import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertArchiveCountriesAreKnown,
  currentPriceObservationDate,
  importAppleArchives,
  recoverAppleArchiveImport,
  rollbackAppleArchiveImport
} from '../scripts/import-apple-archives.mjs';
import { parseLegacyAppleArchive } from '../scripts/parse-legacy-archive.mjs';
import { appleSnapshotContentHash, normalizeAppleSnapshot } from '../scripts/update-prices.mjs';

const regions = [
  ['nasalac', 'North America', 'Alpha', 'USD'],
  ['emea', 'Europe', 'Beta', 'EUR'],
  ['ap', 'Asia Pacific', 'Gamma', 'JPY']
];

test('production archive imports reject countries outside the reviewed Apple list', () => {
  const parsed = { countries: [{ country: 'Known' }, { country: 'Unexpected' }] };
  assert.throws(
    () => assertArchiveCountriesAreKnown(parsed, { Known: '已知' }, 'archive.html'),
    /outside the reviewed Apple country list: Unexpected/
  );
  const known = { countries: [{ country: 'Known' }] };
  assert.equal(assertArchiveCountriesAreKnown(known, { Known: '已知' }), known);
});

function archiveHtml({ date = 'May 12, 2025', alphaPrice = '0.99', stamp }) {
  const countries = regions.flatMap(([id, heading, prefix, currency]) => [
    `<h3 id="${id}">${heading}</h3>`,
    ...Array.from({ length: 20 }, (_, index) => `
      <p>${prefix} ${index + 1} (${currency})</p>
      <p><b>50GB:</b> $${prefix === 'Alpha' && index === 0 ? alphaPrice : '0.99'}</p>
      <p><b>200GB</b>: $2.99</p>
      <p><b>2TB</b>: $9.99</p>`)
  ]).join('');
  return `<!doctype html><a href="https://web.archive.org/web/${stamp}/https://support.apple.com/en-us/108047">archive</a><div id="sections">${countries}<p><span>Published Date:</span> ${date}</p></div>`;
}

function currentData(parsed) {
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-02T11:00:00.000Z',
    source: {
      name: 'Apple Support',
      url: 'https://support.apple.com/en-us/108047',
      publishedDate: parsed.sourcePublishedDate,
      parser: parsed.parser,
      parserStatus: parsed.parserStatus
    },
    run: {
      observedAtBeijing: '2026-08-02',
      observedAtUtc: '2026-08-02T11:00:00.000Z'
    },
    tiers: parsed.tiers,
    countries: parsed.countries
  };
}

async function seedSnapshotStore({
  snapshotsDir,
  snapshotIndexPath,
  html,
  legacyTopLevel = false,
  omitDataFile = false
}) {
  const parsed = parseLegacyAppleArchive(html);
  const publishedDate = parsed.sourcePublishedDate.replace(/^.*?([A-Za-z]+\s+\d{1,2},\s*\d{4}).*$/, '$1');
  const publishedDateIso = new Date(`${publishedDate} 00:00:00 UTC`).toISOString().slice(0, 10);
  const stamp = html.match(/web\/([0-9]{14})\//)[1];
  const capturedAtUtc = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  const firstConfirmedDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(capturedAtUtc));
  const file = `${publishedDateIso}.html`;
  const dataFile = `${publishedDateIso}.json`;
  const contentHash = appleSnapshotContentHash(parsed);
  const revision = {
    publishedDate: publishedDateIso,
    ...(legacyTopLevel ? { file } : {}),
    ...(!omitDataFile ? { dataFile } : {}),
    ...(legacyTopLevel ? { capturedAtUtc } : { firstConfirmedDate }),
    sourceUrl: 'https://support.apple.com/en-us/108047',
    archiveUrl: `https://web.archive.org/web/${stamp}/https://support.apple.com/en-us/108047`,
    parser: parsed.parser,
    countries: parsed.countries.length,
    pricePoints: parsed.countries.length * parsed.tiers.length,
    contentHash
  };
  const snapshot = legacyTopLevel
    ? revision
    : {
      publishedDate: publishedDateIso,
      activeDataFile: dataFile,
      activeContentHash: contentHash,
      revisions: [revision]
    };
  await mkdir(snapshotsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(snapshotsDir, dataFile), `${JSON.stringify(normalizeAppleSnapshot(parsed), null, 2)}\n`, 'utf8'),
    writeFile(snapshotIndexPath, `${JSON.stringify({ schemaVersion: legacyTopLevel ? 1 : 2, snapshots: [snapshot] }, null, 2)}\n`, 'utf8')
  ]);
  return { parsed, file, dataFile, contentHash, firstConfirmedDate, capturedAtUtc };
}

test('keeps same-date archive revisions as separate normalized JSON evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-import-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const firstHtml = archiveHtml({ stamp: '20250512010000', alphaPrice: '0.99' });
  const secondHtml = archiveHtml({ stamp: '20250513010000', alphaPrice: '1.99' });
  const thirdHtml = archiveHtml({ stamp: '20250514010000', alphaPrice: '2.99' });
  const parsedCurrent = parseLegacyAppleArchive(thirdHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      // Reverse the file names so revision order must come from Wayback timestamps.
      writeFile(path.join(inputDir, '02-first.html'), firstHtml, 'utf8'),
      writeFile(path.join(inputDir, '01-second.html'), secondHtml, 'utf8'),
      writeFile(path.join(inputDir, '00-third.html'), thirdHtml, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsedCurrent))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);

    const result = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    const snapshot = result.snapshotIndex.snapshots.find(({ publishedDate }) => publishedDate === '2025-05-12');
    assert.ok(snapshot);
    assert.equal(snapshot.revisions.length, 3);
    assert.equal(snapshot.revisions[0].firstConfirmedDate, '2025-05-12');
    assert.equal(snapshot.revisions[1].firstConfirmedDate, '2025-05-13');
    assert.equal(snapshot.revisions[2].firstConfirmedDate, '2025-05-14');
    assert.notEqual(snapshot.revisions[0].dataFile, snapshot.revisions[1].dataFile);
    assert.equal(snapshot.revisions[0].dataFile, '2025-05-12.json');
    for (const revision of snapshot.revisions.slice(1)) {
      assert.match(revision.dataFile, /^2025-05-12-[0-9a-f]{12}\.json$/);
    }
    for (const revision of snapshot.revisions) {
      await access(path.join(snapshotsDir, revision.dataFile));
      assert.equal('file' in revision, false);
    }
    assert.equal(Object.values(result.history.markets).find(({ country }) => country === 'Alpha 1').events.length, 3);
    assert.equal(result.history.sourcePublishedDates.length, 1);
    assert.equal(result.history.sourcePublishedDates[0].changes.changedCountries[0].country, 'Alpha 1');
    assert.deepEqual(result.history.sourcePublishedDates[0].changes.changedCountries[0].tiers, [
      { id: '50GB', from: 0.99, to: 2.99 }
    ]);

    const filesBeforeRepeat = await readdir(snapshotsDir);
    const repeated = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    const repeatedSnapshot = repeated.snapshotIndex.snapshots.find(({ publishedDate }) => publishedDate === '2025-05-12');
    assert.equal(repeatedSnapshot.revisions.length, 3);
    assert.deepEqual(await readdir(snapshotsDir), filesBeforeRepeat);
    assert.deepEqual(JSON.parse(await readFile(snapshotIndexPath, 'utf8')), repeated.snapshotIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the Beijing calendar date for Wayback confirmation dates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-beijing-date-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ stamp: '20250511230000' });
  const parsed = parseLegacyAppleArchive(html);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(inputDir, 'late-utc.html'), html, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);
    const result = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    const revision = result.snapshotIndex.snapshots[0].revisions[0];
    assert.equal(revision.firstConfirmedDate, '2025-05-12');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses the Beijing calendar date when current prices omit explicit observation metadata', () => {
  assert.equal(currentPriceObservationDate({
    generatedAt: '2026-08-14T16:02:00.000Z',
    run: { observedAtUtc: '2026-08-14T16:02:00.000Z' }
  }), '2026-08-15');
  assert.equal(currentPriceObservationDate({
    generatedAt: '2026-08-14T16:02:00.000Z',
    run: { observedAtBeijing: '2026-08-14' }
  }), '2026-08-14');
});

test('keeps separate evidence for different publication dates with identical content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-identical-dates-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const firstHtml = archiveHtml({ date: 'May 12, 2025', stamp: '20250512010000' });
  const secondHtml = archiveHtml({ date: 'May 13, 2025', stamp: '20250513010000' });
  const parsedCurrent = parseLegacyAppleArchive(secondHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(inputDir, 'first.html'), firstHtml, 'utf8'),
      writeFile(path.join(inputDir, 'second.html'), secondHtml, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsedCurrent))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);

    const result = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    assert.equal(result.snapshotIndex.snapshots.length, 2);
    for (const snapshot of result.snapshotIndex.snapshots) {
      const revision = snapshot.revisions[0];
      await access(path.join(snapshotsDir, revision.dataFile));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrates a legacy top-level snapshot and records an earlier same-hash confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-legacy-earlier-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const laterHtml = archiveHtml({ stamp: '20250514010000' });
  const earlierHtml = archiveHtml({ stamp: '20250512010000' });
  const parsedCurrent = parseLegacyAppleArchive(laterHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    const seeded = await seedSnapshotStore({
      snapshotsDir,
      snapshotIndexPath,
      html: laterHtml,
      legacyTopLevel: true,
      omitDataFile: true
    });
    await Promise.all([
      writeFile(path.join(inputDir, 'earlier.html'), earlierHtml, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsedCurrent))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);
    const filesBefore = (await readdir(snapshotsDir)).sort();

    const result = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    const snapshot = result.snapshotIndex.snapshots[0];
    assert.equal(snapshot.revisions.length, 1);
    assert.equal(snapshot.revisions[0].dataFile, seeded.dataFile);
    assert.equal(snapshot.revisions[0].firstConfirmedDate, '2025-05-12');
    assert.match(snapshot.revisions[0].archiveUrl, /20250512010000/);
    assert.equal(snapshot.activeDataFile, seeded.dataFile);
    assert.equal(snapshot.activeContentHash, seeded.contentHash);
    assert.equal('file' in snapshot, false);
    assert.equal('dataFile' in snapshot, false);
    assert.equal('capturedAtUtc' in snapshot.revisions[0], false);
    assert.equal(result.history.sourcePublishedDates[0].observedAt, '2025-05-12');
    assert.deepEqual((await readdir(snapshotsDir)).sort(), filesBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects indexed-but-missing snapshot evidence before staging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-missing-evidence-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ stamp: '20250512010000' });
  const parsed = parseLegacyAppleArchive(html);

  try {
    await mkdir(inputDir, { recursive: true });
    const seeded = await seedSnapshotStore({ snapshotsDir, snapshotIndexPath, html });
    await Promise.all([
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8'),
      rm(path.join(snapshotsDir, seeded.dataFile))
    ]);
    const before = await Promise.all([
      readFile(historyPath, 'utf8'),
      readFile(snapshotIndexPath, 'utf8')
    ]);

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      new RegExp(`snapshot index references missing evidence: ${seeded.dataFile.replace('.', '\\.')}`, 'i')
    );
    assert.deepEqual(await Promise.all([
      readFile(historyPath, 'utf8'),
      readFile(snapshotIndexPath, 'utf8')
    ]), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects snapshot evidence when the index is missing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-missing-index-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ stamp: '20250512010000' });
  const parsed = parseLegacyAppleArchive(html);

  try {
    await Promise.all([mkdir(inputDir, { recursive: true }), mkdir(snapshotsDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(snapshotsDir, '2025-05-12.json'), `${JSON.stringify(normalizeAppleSnapshot(parsed), null, 2)}\n`, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);
    const historyBefore = await readFile(historyPath, 'utf8');

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /snapshot index is missing while snapshot evidence exists/i
    );
    assert.equal(await readFile(historyPath, 'utf8'), historyBefore);
    await assert.rejects(readFile(snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects archives whose publication date is after the Wayback confirmation date', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-future-published-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ date: 'December 31, 2030', stamp: '20200101000000' });
  const parsed = parseLegacyAppleArchive(html);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(inputDir, 'future.html'), html, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /publication date after its Wayback confirmation date/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects empty or incomplete archive inputs without rewriting history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-guard-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ stamp: '20250513010000', alphaPrice: '1.99' });
  const parsed = parseLegacyAppleArchive(html);
  const existingHtml = archiveHtml({ date: 'April 1, 2025', stamp: '20250402010000' });
  const originalHistory = JSON.stringify({ schemaVersion: 2, countries: { Preserved: { events: [] } }, sourcePublishedDates: [] });

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      writeFile(historyPath, originalHistory, 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /No validated Apple archives/
    );
    assert.equal(await readFile(historyPath, 'utf8'), originalHistory);

    await seedSnapshotStore({ snapshotsDir, snapshotIndexPath, html: existingHtml });
    await writeFile(path.join(inputDir, 'may.html'), html, 'utf8');
    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /Archive input is incomplete.*2025-04-01/
    );
    assert.equal(await readFile(historyPath, 'utf8'), originalHistory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects archives whose Wayback capture time is in the future', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-future-capture-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const currentHtml = archiveHtml({ stamp: '20250512010000' });
  const futureHtml = archiveHtml({ stamp: '20990101000000' });
  const parsedCurrent = parseLegacyAppleArchive(currentHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(inputDir, 'future.html'), futureHtml, 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsedCurrent))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);
    await assert.rejects(
      importAppleArchives(inputDir, {
        historyPath,
        pricesPath,
        namesPath,
        snapshotsDir,
        snapshotIndexPath
      }),
      /Wayback timestamp is in the future/
    );
    await assert.rejects(readdir(snapshotsDir), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not overwrite unindexed snapshot evidence during import', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-collision-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const html = archiveHtml({ stamp: '20250512010000' });
  const parsed = parseLegacyAppleArchive(html);
  const preservedJson = '{"preserved":true}';

  try {
    await Promise.all([mkdir(inputDir, { recursive: true }), mkdir(snapshotsDir, { recursive: true })]);
    await Promise.all([
      writeFile(path.join(inputDir, 'archive.html'), html, 'utf8'),
      writeFile(path.join(snapshotsDir, '2025-05-12.json'), preservedJson, 'utf8'),
      writeFile(snapshotIndexPath, JSON.stringify({ schemaVersion: 2, snapshots: [] }), 'utf8'),
      writeFile(historyPath, JSON.stringify({ schemaVersion: 2, countries: {}, sourcePublishedDates: [] }), 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8')
    ]);

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /snapshot index does not reference existing evidence: 2025-05-12\.json/i
    );
    assert.equal(await readFile(path.join(snapshotsDir, '2025-05-12.json'), 'utf8'), preservedJson);
    assert.deepEqual(JSON.parse(await readFile(snapshotIndexPath, 'utf8')), { schemaVersion: 2, snapshots: [] });
    assert.deepEqual(JSON.parse(await readFile(historyPath, 'utf8')), { schemaVersion: 2, countries: {}, sourcePublishedDates: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('attempts every archive rollback action when one cleanup fails', async () => {
  const calls = [];
  const remove = async (filePath, options) => {
    calls.push(['remove', filePath, options]);
    if (filePath === 'snapshot-a.html') throw new Error('simulated snapshot cleanup failure');
  };
  const writeText = async (filePath, text) => {
    calls.push(['write', filePath, text]);
  };

  await assert.rejects(
    rollbackAppleArchiveImport({
      createdSnapshotFiles: ['snapshot-a.html', 'snapshot-a.json'],
      historyPath: 'history.json',
      originalHistoryText: 'history-before',
      snapshotIndexPath: 'index.json',
      originalIndexText: 'index-before',
      stagingDir: 'staging',
      remove,
      writeText
    }),
    (error) => error instanceof AggregateError
      && error.errors.some(({ message }) => message === 'simulated snapshot cleanup failure')
  );
  assert.deepEqual(calls, [
    ['remove', 'snapshot-a.html', { force: true }],
    ['remove', 'snapshot-a.json', { force: true }],
    ['write', 'history.json', 'history-before'],
    ['write', 'index.json', 'index-before'],
    ['remove', 'staging', { recursive: true, force: true }]
  ]);
});

test('recovers a crash-interrupted JSON-only archive import before the next run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-recovery-'));
  const dataDir = path.join(root, 'data');
  const snapshotsDir = path.join(dataDir, 'apple-snapshots');
  const historyPath = path.join(dataDir, 'history.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const transactionPath = path.join(dataDir, '.apple-archive-import-transaction.json');
  await mkdir(dataDir, { recursive: true });
  const stagingDir = await mkdtemp(path.join(dataDir, '.apple-snapshot-import-'));
  const createdFile = path.join(snapshotsDir, '2026-08-01.json');
  const originalHistoryText = '{"history":"original"}\n';
  const originalIndexText = '{"schemaVersion":2,"snapshots":[]}\n';
  try {
    await mkdir(snapshotsDir, { recursive: true });
    await Promise.all([
      writeFile(historyPath, '{"history":"partial"}\n', 'utf8'),
      writeFile(snapshotIndexPath, '{"partial":true}\n', 'utf8'),
      writeFile(createdFile, '{"partial":true}\n', 'utf8'),
      writeFile(transactionPath, `${JSON.stringify({
        schemaVersion: 1,
        phase: 'writing',
        originalHistoryText,
        originalIndexText,
        stagingDir,
        createdSnapshotFiles: [createdFile]
      }, null, 2)}\n`, 'utf8')
    ]);
    assert.equal(await recoverAppleArchiveImport({
      transactionPath,
      historyPath,
      snapshotIndexPath,
      snapshotsDir
    }), true);
    assert.equal(await readFile(historyPath, 'utf8'), originalHistoryText);
    assert.equal(await readFile(snapshotIndexPath, 'utf8'), originalIndexText);
    await assert.rejects(readFile(createdFile), { code: 'ENOENT' });
    await assert.rejects(readFile(transactionPath), { code: 'ENOENT' });
    await assert.rejects(access(stagingDir), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects archives newer than current prices without changing history or snapshot evidence', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-archive-future-publication-'));
  const inputDir = path.join(root, 'input');
  const snapshotsDir = path.join(root, 'snapshots');
  const historyPath = path.join(root, 'history.json');
  const pricesPath = path.join(root, 'prices.json');
  const namesPath = path.join(root, 'names.json');
  const snapshotIndexPath = path.join(snapshotsDir, 'index.json');
  const currentHtml = archiveHtml({ date: 'May 12, 2025', stamp: '20250513010000' });
  const futureHtml = archiveHtml({ date: 'June 1, 2025', stamp: '20250602010000' });
  const parsedCurrent = parseLegacyAppleArchive(currentHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    await seedSnapshotStore({ snapshotsDir, snapshotIndexPath, html: currentHtml });
    await Promise.all([
      writeFile(path.join(inputDir, 'future.html'), futureHtml, 'utf8'),
      writeFile(historyPath, '{"sentinel":"history"}\r\n', 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsedCurrent), null, 2)}\n`, 'utf8'),
      writeFile(namesPath, '{}\n', 'utf8')
    ]);
    const beforeHistory = await readFile(historyPath);
    const beforeIndex = await readFile(snapshotIndexPath);
    const beforeFiles = (await readdir(snapshotsDir)).sort();
    const beforeEvidence = await Promise.all(beforeFiles.map((name) => readFile(path.join(snapshotsDir, name))));

    await assert.rejects(
      () => importAppleArchives(inputDir, {
        historyPath,
        pricesPath,
        namesPath,
        snapshotsDir,
        snapshotIndexPath
      }),
      /publication date is newer than current prices\.json/i
    );

    assert.deepEqual(await readFile(historyPath), beforeHistory);
    assert.deepEqual(await readFile(snapshotIndexPath), beforeIndex);
    assert.deepEqual((await readdir(snapshotsDir)).sort(), beforeFiles);
    assert.deepEqual(
      await Promise.all(beforeFiles.map((name) => readFile(path.join(snapshotsDir, name)))),
      beforeEvidence
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
