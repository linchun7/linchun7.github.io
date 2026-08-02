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

function latestExistingEventDate(history, afterDate) {
  return Object.values(history.countries ?? {})
    .flatMap(({ events }) => events ?? [])
    .map(({ observedAt }) => observedAt)
    .filter((date) => date > afterDate)
    .sort()
    .at(-1) ?? null;
}

export async function importAppleArchives(inputDir) {
  if (!inputDir) throw new Error('Archive input directory is required');
  const [history, currentData, names, fileNames] = await Promise.all([
    readFile(HISTORY_PATH, 'utf8').then(JSON.parse),
    readFile(PRICES_PATH, 'utf8').then(JSON.parse),
    readFile(NAMES_PATH, 'utf8').then(JSON.parse),
    readdir(inputDir)
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
  archives.sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));

  const rebuilt = { schemaVersion: 2, updatedAt: new Date().toISOString(), countries: {}, sourcePublishedDates: [] };
  let previousData = null;
  let snapshotIndex = { schemaVersion: 1, snapshots: [] };
  await mkdir(SNAPSHOTS_DIR, { recursive: true });

  for (const archive of archives) {
    const contentHash = appleSnapshotContentHash(archive.parsed);
    const entry = buildAppleSnapshotEntry(archive.publishedDate, {
      capturedAtUtc: archive.capturedAtUtc,
      sourceUrl: APPLE_URL,
      archiveUrl: archive.archiveUrl,
      parser: archive.parsed.parser,
      countries: archive.parsed.countries.length,
      pricePoints: archive.parsed.countries.length * archive.parsed.tiers.length,
      contentHash
    });
    snapshotIndex = buildAppleSnapshotIndex(snapshotIndex, entry);
    await copyFile(archive.filePath, path.join(SNAPSHOTS_DIR, entry.file));
    updateHistory(rebuilt, archive.parsed.countries, archive.publishedDate, archive.parsed.tiers, archive.capturedAtUtc);
    const changes = previousData ? buildSnapshotChanges(previousData, archive.parsed.countries, archive.parsed.tiers) : emptyChanges();
    rebuilt.sourcePublishedDates.push({
      publishedDate: archive.parsed.sourcePublishedDate,
      observedAt: archive.capturedAtUtc.slice(0, 10),
      observedAtUtc: archive.capturedAtUtc,
      kind: previousData ? 'change' : 'initial',
      changes
    });
    previousData = archive.parsed;
  }

  const lastArchiveDate = archives.at(-1)?.publishedDate ?? '0000-00-00';
  const currentObservedAt = latestExistingEventDate(history, lastArchiveDate) ?? currentData.run?.observedAtBeijing ?? currentData.generatedAt.slice(0, 10);
  updateHistory(rebuilt, currentData.countries, currentObservedAt, currentData.tiers, currentData.run?.observedAtUtc ?? currentData.generatedAt);
  const currentPublishedDate = publicationDateKey(currentData.source.publishedDate);
  if (currentPublishedDate > lastArchiveDate) {
    rebuilt.sourcePublishedDates.push({
      publishedDate: currentData.source.publishedDate,
      observedAt: history.sourcePublishedDates?.at(-1)?.observedAt ?? currentObservedAt,
      ...(history.sourcePublishedDates?.at(-1)?.observedAtUtc ? { observedAtUtc: history.sourcePublishedDates.at(-1).observedAtUtc } : {}),
      kind: 'change',
      changes: buildSnapshotChanges(previousData, currentData.countries, currentData.tiers)
    });
  }

  await Promise.all([
    writeFile(HISTORY_PATH, `${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8'),
    writeFile(SNAPSHOT_INDEX_PATH, `${JSON.stringify(snapshotIndex, null, 2)}\n`, 'utf8')
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
