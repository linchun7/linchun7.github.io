import { constants } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLegacyAppleArchive } from './parse-legacy-archive.mjs';
import { parseApplePrices, validatePrices } from './parse-prices.mjs';
import {
  appleSnapshotContentHash,
  acquireUpdateLock,
  buildAppleSnapshotEntry,
  buildAppleSnapshotIndex,
  buildSnapshotChanges,
  publicationDateKey,
  normalizeAppleSnapshot,
  normalizeAppleSnapshotIndex,
  snapshotFileSha256,
  validateAppleSnapshotStore,
  defaultUpdateLockPath,
  updateHistory
} from './update-prices.mjs';
import { formatBeijingDate } from './run-context.mjs';
import { attachMarketIdentity, resolveMarket } from './market-registry.mjs';
import { getOfficialChineseMarketName } from './country-names.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const PRICES_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const SNAPSHOTS_DIR = path.join(PROJECT_DIR, 'data/apple-snapshots');
const SNAPSHOT_INDEX_PATH = path.join(SNAPSHOTS_DIR, 'index.json');
const IMPORT_TRANSACTION_PATH = path.join(PROJECT_DIR, 'data/.apple-archive-import-transaction.json');
const APPLE_URL = 'https://support.apple.com/en-us/108047';

export function currentPriceObservationDate(currentData) {
  return currentData.run?.observedAtBeijing ?? formatBeijingDate(currentData.generatedAt);
}

async function writeTextAtomic(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporaryPath, text, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function rollbackAppleArchiveImport({
  createdSnapshotFiles,
  historyPath,
  originalHistoryText,
  snapshotIndexPath,
  originalIndexText,
  stagingDir,
  remove = rm,
  writeText = writeTextAtomic
}) {
  const operations = [
    ...createdSnapshotFiles.map((filePath) => () => remove(filePath, { force: true })),
    () => writeText(historyPath, originalHistoryText),
    () => originalIndexText === null
      ? remove(snapshotIndexPath, { force: true })
      : writeText(snapshotIndexPath, originalIndexText),
    () => remove(stagingDir, { recursive: true, force: true })
  ];
  const results = await Promise.allSettled(operations.map((operation) => operation()));
  const failures = results
    .filter(({ status }) => status === 'rejected')
    .map(({ reason }) => reason);
  if (failures.length) {
    throw new AggregateError(failures, 'Apple archive import rollback was incomplete');
  }
}

async function readImportTransaction(transactionPath) {
  try {
    return JSON.parse(await readFile(transactionPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Unable to read the Apple archive import transaction: ${error.message}`);
  }
}

export async function recoverAppleArchiveImport({
  transactionPath = IMPORT_TRANSACTION_PATH,
  historyPath = HISTORY_PATH,
  snapshotIndexPath = SNAPSHOT_INDEX_PATH,
  snapshotsDir = SNAPSHOTS_DIR
} = {}) {
  const transaction = await readImportTransaction(transactionPath);
  if (!transaction) return false;
  const snapshotRoot = path.resolve(snapshotsDir);
  const stagingRoot = path.resolve(path.dirname(snapshotsDir));
  const stagingDir = path.resolve(transaction.stagingDir ?? '');
  const createdSnapshotFiles = transaction.createdSnapshotFiles ?? [];
  const filesAreSafe = Array.isArray(createdSnapshotFiles) && createdSnapshotFiles.every((filePath) => {
    const resolved = path.resolve(filePath);
    return path.dirname(resolved) === snapshotRoot
      && /^\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{12})?\.json$/.test(path.basename(resolved));
  });
  if (transaction.schemaVersion !== 1
    || !['writing', 'committed'].includes(transaction.phase)
    || typeof transaction.originalHistoryText !== 'string'
    || !(transaction.originalIndexText === null || typeof transaction.originalIndexText === 'string')
    || !filesAreSafe
    || path.dirname(stagingDir) !== stagingRoot
    || !path.basename(stagingDir).startsWith('.apple-snapshot-import-')) {
    throw new Error('Unsafe or unsupported Apple archive import recovery transaction');
  }
  if (transaction.phase === 'committed') {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(transactionPath, { force: true });
    return true;
  }
  await rollbackAppleArchiveImport({
    createdSnapshotFiles,
    historyPath,
    originalHistoryText: transaction.originalHistoryText,
    snapshotIndexPath,
    originalIndexText: transaction.originalIndexText,
    stagingDir
  });
  await rm(transactionPath, { force: true });
  return true;
}

function archiveMetadata(html) {
  const match = html.match(/web\/([0-9]{14})\/https:\/\/support\.apple\.com\/en-us\/108047/);
  if (!match) throw new Error('Wayback timestamp was not found');
  const stamp = match[1];
  const capturedAtUtc = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  if (Date.parse(capturedAtUtc) > Date.now()) {
    throw new Error('Wayback timestamp is in the future');
  }
  return {
    capturedAtUtc,
    firstConfirmedDate: formatBeijingDate(capturedAtUtc),
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
      nameZh: getOfficialChineseMarketName(resolveMarket(country.country).id, names)
        ?? names[country.country]
        ?? country.country
    }))
  };
}

export function assertArchiveCountriesAreKnown(parsed, names, fileName = 'archive') {
  const unknownCountries = parsed.countries
    .map(({ country }) => country)
    .filter((country) => {
      const market = resolveMarket(country);
      const displayName = getOfficialChineseMarketName(market.id, names) ?? names[country];
      return typeof displayName !== 'string' || !displayName.trim();
    });
  if (unknownCountries.length) {
    throw new Error(`${fileName} contains countries outside the reviewed Apple country list: ${unknownCountries.join(', ')}`);
  }
  return parsed;
}

function emptyChanges() {
  return { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] };
}

function mergeSnapshotChanges(baseChanges = emptyChanges(), additionalChanges = emptyChanges()) {
  const unique = (items, key) => [...new Map(items.map((item) => [key(item), item])).values()];
  const changed = new Map();
  for (const entry of [...(baseChanges.changedCountries ?? []), ...(additionalChanges.changedCountries ?? [])]) {
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
    addedTiers: unique([...(baseChanges.addedTiers ?? []), ...(additionalChanges.addedTiers ?? [])], (item) => item.id),
    removedTiers: unique([...(baseChanges.removedTiers ?? []), ...(additionalChanges.removedTiers ?? [])], (item) => item.id),
    addedCountries: unique([...(baseChanges.addedCountries ?? []), ...(additionalChanges.addedCountries ?? [])], (item) => item.country),
    removedCountries: unique([...(baseChanges.removedCountries ?? []), ...(additionalChanges.removedCountries ?? [])], (item) => item.country),
    changedCountries: [...changed.values()]
  };
}

function migrateSnapshotIndex(index) {
  return {
    schemaVersion: 2,
    snapshots: (index.snapshots ?? []).map((snapshot) => {
      const sourceRevisions = Array.isArray(snapshot.revisions)
        ? snapshot.revisions
        : (snapshot.dataFile || snapshot.file) ? [{ ...snapshot }] : [];
      const revisions = sourceRevisions.map((revision) => {
        const dataFile = revision.dataFile ?? revision.file?.replace(/\.html$/, '.json');
        const firstConfirmedDate = revision.firstConfirmedDate
          ?? (revision.capturedAtUtc ? formatBeijingDate(revision.capturedAtUtc) : undefined);
        const { capturedAtUtc, file, htmlSha256, ...rest } = revision;
        return { ...rest, dataFile, firstConfirmedDate };
      }).sort((a, b) => (a.firstConfirmedDate ?? '').localeCompare(b.firstConfirmedDate ?? ''));
      const active = revisions.at(-1);
      const {
        file,
        dataFile,
        activeFile,
        htmlSha256,
        firstConfirmedDate,
        capturedAtUtc,
        sourceUrl,
        archiveUrl,
        parser,
        countries,
        pricePoints,
        contentHash,
        revisions: ignoredRevisions,
        ...container
      } = snapshot;
      return {
        ...container,
        activeDataFile: active?.dataFile,
        activeContentHash: active?.contentHash,
        revisions
      };
    })
  };
}

export async function importAppleArchives(inputDir, paths = {}) {
  if (!inputDir) throw new Error('Archive input directory is required');
  const historyPath = paths.historyPath ?? HISTORY_PATH;
  const lockPath = paths.lockPath ?? defaultUpdateLockPath(paths.pricesPath ?? PRICES_PATH);
  const releaseLock = await acquireUpdateLock(lockPath);
  try {
    return await importAppleArchivesUnlocked(inputDir, paths);
  } finally {
    await releaseLock();
  }
}

async function importAppleArchivesUnlocked(inputDir, paths = {}) {
  const historyPath = paths.historyPath ?? HISTORY_PATH;
  const pricesPath = paths.pricesPath ?? PRICES_PATH;
  const namesPath = paths.namesPath ?? NAMES_PATH;
  const snapshotsDir = paths.snapshotsDir ?? SNAPSHOTS_DIR;
  const snapshotIndexPath = paths.snapshotIndexPath ?? SNAPSHOT_INDEX_PATH;
  const transactionPath = paths.transactionPath ?? path.join(path.dirname(historyPath), '.apple-archive-import-transaction.json');
  const enforceReviewedCountries = paths.enforceReviewedCountries ?? true;
  await recoverAppleArchiveImport({ transactionPath, historyPath, snapshotIndexPath, snapshotsDir });
  const [existingHistory, currentData, names, fileNames, existingSnapshotIndexState] = await Promise.all([
    readFile(historyPath, 'utf8').then(JSON.parse),
    readFile(pricesPath, 'utf8').then(JSON.parse),
    readFile(namesPath, 'utf8').then(JSON.parse),
    readdir(inputDir),
    readFile(snapshotIndexPath, 'utf8').then((text) => ({ value: JSON.parse(text), existed: true })).catch((error) => {
      if (error.code === 'ENOENT') return { value: { schemaVersion: 2, snapshots: [] }, existed: false };
      throw error;
    })
  ]);
  const reviewedCountryNames = {
    ...names,
    ...Object.fromEntries(Object.entries(existingHistory.countries ?? {}).map(([country, record]) => (
      [country, record.nameZh || country]
    ))),
    ...Object.fromEntries(Object.values(existingHistory.markets ?? {}).map((record) => (
      [record.country, record.nameZh || record.country]
    ))),
    ...Object.fromEntries((currentData.countries ?? []).map(({ country, nameZh }) => (
      [country, nameZh || country]
    )))
  };
  let migratedSnapshotIndex = migrateSnapshotIndex(existingSnapshotIndexState.value);
  const validatedSnapshotIndex = await validateAppleSnapshotStore({
    snapshotsDir,
    snapshotIndexPath,
    snapshotIndex: migratedSnapshotIndex,
    snapshotIndexExists: existingSnapshotIndexState.existed
  });
  if (validatedSnapshotIndex) migratedSnapshotIndex = validatedSnapshotIndex;

  const archives = [];
  for (const fileName of fileNames.filter((name) => name.toLowerCase().endsWith('.html'))) {
    const filePath = path.join(inputDir, fileName);
    const htmlBuffer = await readFile(filePath);
    const html = htmlBuffer.toString('utf8');
    const rawParsed = parseArchive(html);
    if (enforceReviewedCountries) assertArchiveCountriesAreKnown(rawParsed, reviewedCountryNames, fileName);
    const parsed = withNames(rawParsed, names);
    validatePrices(parsed.countries, { tiers: parsed.tiers, minCountries: 60 });
    const publishedDate = publicationDateKey(parsed.sourcePublishedDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate)) throw new Error(`Invalid publication date in ${fileName}`);
    const metadata = archiveMetadata(html);
    if (publishedDate > metadata.firstConfirmedDate) {
      throw new Error(`Archive ${fileName} has a publication date after its Wayback confirmation date`);
    }
    archives.push({ fileName, filePath, html, parsed, publishedDate, ...metadata });
  }
  archives.sort((a, b) => (
    a.publishedDate.localeCompare(b.publishedDate)
    || a.capturedAtUtc.localeCompare(b.capturedAtUtc)
    || a.fileName.localeCompare(b.fileName)
  ));

  const rebuilt = { schemaVersion: 4, updatedAt: new Date().toISOString(), markets: {}, sourcePublishedDates: [] };
  let previousData = null;
  let snapshotIndex = normalizeAppleSnapshotIndex(migratedSnapshotIndex);
  const currentPublishedDate = publicationDateKey(currentData.source.publishedDate);
  if (!archives.length) throw new Error('No validated Apple archives were found in the input directory');
  const futureArchives = archives.filter(({ publishedDate }) => publishedDate > currentPublishedDate);
  if (futureArchives.length) {
    throw new Error(`Archive publication date is newer than current prices.json: ${futureArchives.map(({ fileName, publishedDate }) => `${fileName} (${publishedDate})`).join(', ')}`);
  }
  const archiveDates = new Set(archives.map(({ publishedDate }) => publishedDate));
  const missingDates = snapshotIndex.snapshots
    .map(({ publishedDate }) => publishedDate)
    .filter((publishedDate) => publishedDate !== currentPublishedDate && !archiveDates.has(publishedDate));
  if (missingDates.length) {
    throw new Error(`Archive input is incomplete; missing existing snapshot dates: ${missingDates.join(', ')}`);
  }
  await mkdir(snapshotsDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(path.dirname(snapshotsDir), '.apple-snapshot-import-'));
  const createdSnapshotFiles = [];
  const stagedFiles = [];
  const originalHistoryText = await readFile(historyPath, 'utf8');
  const originalIndexText = await readFile(snapshotIndexPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

  for (const archive of archives) {
    const contentHash = appleSnapshotContentHash(archive.parsed);
    const normalizedSnapshotText = `${JSON.stringify(normalizeAppleSnapshot(archive.parsed), null, 2)}\n`;
    const existingSnapshot = snapshotIndex.snapshots.find(({ publishedDate }) => publishedDate === archive.publishedDate);
    const existingRevision = existingSnapshot?.revisions?.find(({ contentHash: existingHash }) => existingHash === contentHash);
    const entry = buildAppleSnapshotEntry(archive.publishedDate, {
      firstConfirmedDate: archive.firstConfirmedDate,
      sourceUrl: APPLE_URL,
      archiveUrl: archive.archiveUrl,
      parser: archive.parsed.parser,
      countries: archive.parsed.countries.length,
      pricePoints: archive.parsed.countries.length * archive.parsed.tiers.length,
      contentHash,
      dataSha256: snapshotFileSha256(normalizedSnapshotText)
    });
    if (existingRevision) {
      entry.dataFile = existingRevision.dataFile;
    } else if (existingSnapshot) {
      entry.dataFile = `${archive.publishedDate}-${contentHash.slice(0, 12)}.json`;
    }
    snapshotIndex = buildAppleSnapshotIndex(snapshotIndex, entry);
    if (!existingRevision) {
      try {
        await writeFile(
          path.join(stagingDir, entry.dataFile),
          normalizedSnapshotText,
          'utf8'
        );
      } catch (error) {
        await rm(stagingDir, { recursive: true, force: true });
        throw new Error(`Apple archive staging failed: ${error.message}`, { cause: error });
      }
      stagedFiles.push(entry.dataFile);
    }
    updateHistory(rebuilt, attachMarketIdentity(archive.parsed.countries, { chineseNames: names }), archive.publishedDate, archive.parsed.tiers);
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
      previousSourceEntry.observedAt = [previousSourceEntry.observedAt, snapshotIndex.snapshots
        .find(({ publishedDate }) => publishedDate === archive.publishedDate)
        ?.revisions?.[0]?.firstConfirmedDate]
        .filter(Boolean)
        .sort()[0];
    } else {
      sourceEntry.observedAt = snapshotIndex.snapshots
        .find(({ publishedDate }) => publishedDate === archive.publishedDate)
        ?.revisions?.[0]?.firstConfirmedDate ?? sourceEntry.observedAt;
      rebuilt.sourcePublishedDates.push(sourceEntry);
    }
    previousData = archive.parsed;
  }

  const lastArchiveDate = archives.at(-1)?.publishedDate ?? '0000-00-00';
  const currentEventDate = currentPriceObservationDate(currentData);
  updateHistory(rebuilt, attachMarketIdentity(currentData.countries, { chineseNames: names }), currentEventDate, currentData.tiers);
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

  try {
    const plannedSnapshotFiles = stagedFiles.map((name) => path.join(snapshotsDir, name));
    for (const filePath of plannedSnapshotFiles) {
      await access(filePath).then(
        () => { throw new Error(`Apple snapshot evidence already exists: ${path.basename(filePath)}`); },
        (error) => { if (error.code !== 'ENOENT') throw error; }
      );
    }
    const transaction = {
      schemaVersion: 1,
      phase: 'writing',
      originalHistoryText,
      originalIndexText,
      stagingDir,
      createdSnapshotFiles: plannedSnapshotFiles
    };
    await writeTextAtomic(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`);
    for (const name of stagedFiles) {
      await copyFile(path.join(stagingDir, name), path.join(snapshotsDir, name), constants.COPYFILE_EXCL);
      createdSnapshotFiles.push(path.join(snapshotsDir, name));
    }
    snapshotIndex = await validateAppleSnapshotStore({
      snapshotsDir,
      snapshotIndexPath,
      snapshotIndex,
      snapshotIndexExists: true,
      history: rebuilt,
      currentData,
      deep: true
    });
    await writeTextAtomic(historyPath, `${JSON.stringify(rebuilt, null, 2)}\n`);
    await writeTextAtomic(snapshotIndexPath, `${JSON.stringify(snapshotIndex, null, 2)}\n`);
    await writeTextAtomic(transactionPath, `${JSON.stringify({ ...transaction, phase: 'committed' }, null, 2)}\n`);
    await rm(stagingDir, { recursive: true, force: true });
    await rm(transactionPath, { force: true });
    return { archives, history: rebuilt, snapshotIndex };
  } catch (error) {
    try {
      await rollbackAppleArchiveImport({
        createdSnapshotFiles: stagedFiles.map((name) => path.join(snapshotsDir, name)),
        historyPath,
        originalHistoryText,
        snapshotIndexPath,
        originalIndexText,
        stagingDir
      });
      await rm(transactionPath, { force: true });
    } catch (rollbackError) {
      throw new AggregateError(
        [error, ...(rollbackError.errors ?? [rollbackError])],
        `Apple archive import was not committed and rollback was incomplete: ${error.message}`,
        { cause: error }
      );
    }
    throw new Error(`Apple archive import was not committed: ${error.message}`, { cause: error });
  }
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
