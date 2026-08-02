import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLegacyAppleArchive } from './parse-legacy-archive.mjs';
import { parseApplePrices, validatePrices } from './parse-prices.mjs';
import {
  appleSnapshotContentHash,
  buildAppleSnapshotEntry,
  buildAppleSnapshotIndex,
  buildSnapshotChanges,
  publicationDateKey,
  normalizeAppleSnapshot,
  updateHistory
} from './update-prices.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const PRICES_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const SNAPSHOTS_DIR = path.join(PROJECT_DIR, 'data/apple-snapshots');
const SNAPSHOT_INDEX_PATH = path.join(SNAPSHOTS_DIR, 'index.json');
const APPLE_URL = 'https://support.apple.com/en-us/108047';

function archiveMetadata(html) {
  const match = html.match(/web\/([0-9]{14})\/https:\/\/support\.apple\.com\/en-us\/108047/);
  if (!match) throw new Error('Wayback timestamp was not found');
  const stamp = match[1];
  const capturedAtUtc = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  return {
    capturedAtUtc,
    firstConfirmedDate: capturedAtUtc.slice(0, 10),
    archiveUrl: `https://web.archive.org/web/${stamp}/${APPLE_URL}`
  };
}

function parseArchive(html) {
  try {
    return parseApplePrices(html);
  } catch (modernError) {
    try {
      return parseLegacyAppleArchive(html);
    } catch (legacyError) {
      throw new Error(`Archive parsing failed; modern: ${modernError.message}; legacy: ${legacyError.message}`);
    }
  }
}

function withNames(parsed, names) {
  return {
    ...parsed,
    countries: parsed.countries.map((country) => ({
      ...country,
      nameZh: names[country.country] ?? country.country
    }))
  };
}

function emptyChanges() {
  return { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] };
}

function mergeSnapshotChanges(first = emptyChanges(), second = emptyChanges()) {
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  const changed = new Map();
  for (const entry of [...(first.changedCountries ?? []), ...(second.changedCountries ?? [])]) {
    const current = changed.get(entry.country);
    if (!current) {
      changed.set(entry.country, { ...entry, tiers: [...(entry.tiers ?? [])] });
      continue;
    }
    const tiers = new Map((current.tiers ?? []).map((tier) => [tier.id, tier]));
    for (const tier of entry.tiers ?? []) {
      const previousTier = tiers.get(tier.id);
      tiers.set(tier.id, previousTier ? { ...previousTier, to: tier.to } : tier);
    }
    changed.set(entry.country, {
      ...current,
      ...entry,
      fromCurrency: current.fromCurrency,
      fromRegion: current.fromRegion,
      tiers: [...tiers.values()]
    });
  }
  return {
    addedTiers: unique([...(first.addedTiers ?? []), ...(second.addedTiers ?? [])], (item) => item.id),
    removedTiers: unique([...(first.removedTiers ?? []), ...(second.removedTiers ?? [])], (item) => item.id),
    addedCountries: unique([...(first.addedCountries ?? []), ...(second.addedCountries ?? [])], (item) => item.country),
    removedCountries: unique([...(first.removedCountries ?? []), ...(second.removedCountries ?? [])], (item) => item.country),
    changedCountries: [...changed.values()]
  };
}

function migrateSnapshotIndex(index) {
  return {
    schemaVersion: 1,
    snapshots: (index.snapshots ?? []).map((snapshot) => {
      const revisions = (snapshot.revisions ?? []).map((revision) => {
        const dataFile = revision.dataFile ?? revision.file.replace(/\.html$/, '.json');
        const firstConfirmedDate = revision.firstConfirmedDate ?? revision.capturedAtUtc?.slice(0, 10);
        const { capturedAtUtc, ...rest } = revision;
        return { ...rest, dataFile, firstConfirmedDate };
      });
      return {
        ...snapshot,
        activeDataFile: revisions.at(-1)?.dataFile,
        revisions
      };
    })
  };
}

export async function importAppleArchives(inputDir, paths = {}) {
  if (!inputDir) throw new Error('Archive input directory is required');
  const historyPath = paths.historyPath ?? HISTORY_PATH;
  const pricesPath = paths.pricesPath ?? PRICES_PATH;
  const namesPath = paths.namesPath ?? NAMES_PATH;
  const snapshotsDir = paths.snapshotsDir ?? SNAPSHOTS_DIR;
  const snapshotIndexPath = paths.snapshotIndexPath ?? SNAPSHOT_INDEX_PATH;
  const [, currentData, names, fileNames, existingSnapshotIndex] = await Promise.all([
    readFile(historyPath, 'utf8').then(JSON.parse),
    readFile(pricesPath, 'utf8').then(JSON.parse),
    readFile(namesPath, 'utf8').then(JSON.parse),
    readdir(inputDir),
    readFile(snapshotIndexPath, 'utf8').then(JSON.parse).catch((error) => {
      if (error.code === 'ENOENT') return { schemaVersion: 1, snapshots: [] };
      throw error;
    })
  ]);

  const archives = [];
  for (const fileName of fileNames.filter((name) => name.toLowerCase().endsWith('.html'))) {
    const filePath = path.join(inputDir, fileName);
    const html = await readFile(filePath, 'utf8');
    const parsed = withNames(parseArchive(html), names);
    validatePrices(parsed.countries, { tiers: parsed.tiers, minCountries: 60 });
    const publishedDate = publicationDateKey(parsed.sourcePublishedDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) throw new Error(`Invalid publication date in ${fileName}`);
    archives.push({ fileName, filePath, html, parsed, publishedDate, ...archiveMetadata(html) });
  }
  archives.sort((a, b) => (
    a.publishedDate.localeCompare(b.publishedDate)
    || a.capturedAtUtc.localeCompare(b.capturedAtUtc)
    || a.fileName.localeCompare(b.fileName)
  ));

  const rebuilt = { schemaVersion: 2, updatedAt: new Date().toISOString(), countries: {}, sourcePublishedDates: [] };
  let previousData = null;
  let snapshotIndex = migrateSnapshotIndex(existingSnapshotIndex);
  const currentPublishedDate = publicationDateKey(currentData.source.publishedDate);
  if (!archives.length) throw new Error('No validated Apple archives were found in the input directory');
  const archiveDates = new Set(archives.map(({ publishedDate }) => publishedDate));
  const missingDates = snapshotIndex.snapshots
    .map(({ publishedDate }) => publishedDate)
    .filter((publishedDate) => publishedDate !== currentPublishedDate && !archiveDates.has(publishedDate));
  if (missingDates.length) {
    throw new Error(`Archive input is incomplete; missing existing snapshot dates: ${missingDates.join(', ')}`);
  }
  await mkdir(snapshotsDir, { recursive: true });

  for (const archive of archives) {
    const contentHash = appleSnapshotContentHash(archive.parsed);
    const existingSnapshot = snapshotIndex.snapshots.find(({ publishedDate }) => publishedDate === archive.publishedDate);
    const existingRevision = existingSnapshot?.revisions?.find(({ contentHash: existingHash }) => existingHash === contentHash);
    const entry = buildAppleSnapshotEntry(archive.publishedDate, {
      firstConfirmedDate: archive.firstConfirmedDate,
      sourceUrl: APPLE_URL,
      archiveUrl: archive.archiveUrl,
      parser: archive.parsed.parser,
      countries: archive.parsed.countries.length,
      pricePoints: archive.parsed.countries.length * archive.parsed.tiers.length,
      contentHash
    });
    if (existingRevision) {
      entry.file = existingRevision.file;
      entry.dataFile = existingRevision.dataFile ?? entry.dataFile;
    } else if (existingSnapshot) {
      entry.file = `${archive.publishedDate}-${contentHash.slice(0, 12)}.html`;
      entry.dataFile = `${archive.publishedDate}-${contentHash.slice(0, 12)}.json`;
    }
    snapshotIndex = buildAppleSnapshotIndex(snapshotIndex, entry);
    if (!existingRevision) {
      await copyFile(archive.filePath, path.join(snapshotsDir, entry.file));
      await writeFile(
        path.join(snapshotsDir, entry.dataFile),
        `${JSON.stringify(normalizeAppleSnapshot(archive.parsed), null, 2)}\n`,
        'utf8'
      );
    }
    updateHistory(rebuilt, archive.parsed.countries, archive.publishedDate, archive.parsed.tiers);
    const changes = previousData ? buildSnapshotChanges(previousData, archive.parsed.countries, archive.parsed.tiers) : emptyChanges();
    const sourceEntry = {
      publishedDate: archive.parsed.sourcePublishedDate,
      observedAt: archive.firstConfirmedDate,
      kind: previousData ? 'change' : 'initial',
      changes
    };
    const previousSourceEntry = rebuilt.sourcePublishedDates.at(-1);
    if (publicationDateKey(previousSourceEntry?.publishedDate) === archive.publishedDate) {
      previousSourceEntry.changes = mergeSnapshotChanges(previousSourceEntry.changes, changes);
    } else {
      rebuilt.sourcePublishedDates.push(sourceEntry);
    }
    previousData = archive.parsed;
  }

  const lastArchiveDate = archives.at(-1)?.publishedDate ?? '0000-00-00';
  const currentEventDate = currentData.run?.observedAtBeijing
    ?? currentData.generatedAt.slice(0, 10);
  updateHistory(rebuilt, currentData.countries, currentEventDate, currentData.tiers);
  const currentChanges = buildSnapshotChanges(previousData, currentData.countries, currentData.tiers);
  if (currentPublishedDate > lastArchiveDate) {
    rebuilt.sourcePublishedDates.push({
      publishedDate: currentData.source.publishedDate,
      observedAt: currentEventDate,
      kind: 'change',
      changes: currentChanges
    });
  } else if (publicationDateKey(rebuilt.sourcePublishedDates.at(-1)?.publishedDate) === currentPublishedDate) {
    rebuilt.sourcePublishedDates.at(-1).changes = mergeSnapshotChanges(
      rebuilt.sourcePublishedDates.at(-1).changes,
      currentChanges
    );
  }

  await Promise.all([
    writeFile(historyPath, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8'),
    writeFile(snapshotIndexPath, `${JSON.stringify(snapshotIndex, null, 2)}\n`, 'utf8')
  ]);
  return { archives, history: rebuilt, snapshotIndex };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const inputIndex = process.argv.indexOf('--input');
  importAppleArchives(inputIndex >= 0 ? process.argv[inputIndex + 1] : null)
    .then(({ archives }) => console.log(`Imported ${archives.length} validated Apple archives.`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
