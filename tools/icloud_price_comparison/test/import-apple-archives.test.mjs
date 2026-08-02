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
  const parsedCurrent = parseLegacyAppleArchive(secondHtml);

  try {
    await mkdir(inputDir, { recursive: true });
    await Promise.all([
      // Reverse the file names so revision order must come from Wayback timestamps.
      writeFile(path.join(inputDir, '02-first.html'), firstHtml, 'utf8'),
      writeFile(path.join(inputDir, '01-second.html'), secondHtml, 'utf8'),
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
    assert.equal(snapshot.revisions.length, 2);
    assert.equal(snapshot.revisions[0].firstConfirmedDate, '2025-05-12');
    assert.equal(snapshot.revisions[1].firstConfirmedDate, '2025-05-13');
    assert.notEqual(snapshot.revisions[0].file, snapshot.revisions[1].file);
    assert.notEqual(snapshot.revisions[0].dataFile, snapshot.revisions[1].dataFile);
    for (const revision of snapshot.revisions) {
      await access(path.join(snapshotsDir, revision.file));
      await access(path.join(snapshotsDir, revision.dataFile));
    }
    assert.equal(result.history.countries['Alpha 1'].events.length, 2);

    const filesBeforeRepeat = await readdir(snapshotsDir);
    const repeated = await importAppleArchives(inputDir, {
      historyPath,
      pricesPath,
      namesPath,
      snapshotsDir,
      snapshotIndexPath
    });
    const repeatedSnapshot = repeated.snapshotIndex.snapshots.find(({ publishedDate }) => publishedDate === '2025-05-12');
    assert.equal(repeatedSnapshot.revisions.length, 2);
    assert.deepEqual(await readdir(snapshotsDir), filesBeforeRepeat);
    assert.deepEqual(JSON.parse(await readFile(snapshotIndexPath, 'utf8')), repeated.snapshotIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
