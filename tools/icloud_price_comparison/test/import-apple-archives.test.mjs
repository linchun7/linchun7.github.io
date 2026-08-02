import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { importAppleArchives } from '../scripts/import-apple-archives.mjs';
import { parseLegacyAppleArchive } from '../scripts/parse-legacy-archive.mjs';

const regions = [
  ['nasalac', 'North America', 'Alpha', 'USD'],
  ['emea', 'Europe', 'Beta', 'EUR'],
  ['ap', 'Asia Pacific', 'Gamma', 'JPY']
];

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

test('keeps same-date archive revisions as separate HTML and JSON evidence', async () => {
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
    assert.notEqual(snapshot.revisions[0].file, snapshot.revisions[1].file);
    assert.notEqual(snapshot.revisions[0].dataFile, snapshot.revisions[1].dataFile);
    assert.equal(snapshot.revisions[0].file, '2025-05-12.html');
    assert.equal(snapshot.revisions[0].dataFile, '2025-05-12.json');
    for (const revision of snapshot.revisions.slice(1)) {
      assert.match(revision.file, /^2025-05-12-[0-9a-f]{12}\.html$/);
      assert.match(revision.dataFile, /^2025-05-12-[0-9a-f]{12}\.json$/);
    }
    for (const revision of snapshot.revisions) {
      await access(path.join(snapshotsDir, revision.file));
      await access(path.join(snapshotsDir, revision.dataFile));
    }
    assert.equal(result.history.countries['Alpha 1'].events.length, 3);
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
  const originalHistory = JSON.stringify({ schemaVersion: 2, countries: { Preserved: { events: [] } }, sourcePublishedDates: [] });

  try {
    await mkdir(inputDir, { recursive: true });
    await mkdir(snapshotsDir, { recursive: true });
    await Promise.all([
      writeFile(historyPath, originalHistory, 'utf8'),
      writeFile(pricesPath, `${JSON.stringify(currentData(parsed))}\n`, 'utf8'),
      writeFile(namesPath, '{}', 'utf8'),
      writeFile(snapshotIndexPath, JSON.stringify({
        schemaVersion: 1,
        snapshots: [{
          publishedDate: '2025-04-01',
          activeFile: '2025-04-01.html',
          activeDataFile: '2025-04-01.json',
          activeContentHash: 'a'.repeat(64),
          revisions: [{
            publishedDate: '2025-04-01',
            file: '2025-04-01.html',
            dataFile: '2025-04-01.json',
            firstConfirmedDate: '2025-04-02',
            contentHash: 'a'.repeat(64)
          }]
        }]
      }), 'utf8')
    ]);

    await assert.rejects(
      importAppleArchives(inputDir, { historyPath, pricesPath, namesPath, snapshotsDir, snapshotIndexPath }),
      /No validated Apple archives/
    );
    assert.equal(await readFile(historyPath, 'utf8'), originalHistory);

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
