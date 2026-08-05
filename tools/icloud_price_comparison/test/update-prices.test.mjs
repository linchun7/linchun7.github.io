import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildSnapshotChanges,
  buildRunLog,
  buildActionSummaryLines,
  buildAppleSnapshotEntry,
  buildAppleSnapshotIndex,
  defaultUpdateLockPath,
  appleSnapshotContentHash,
  acquireUpdateLock,
  normalizeAppleSnapshotIndex,
  savePublishedAppleSnapshot,
  createRunLogEntry,
  getExchangeRates,
  main,
  publicationDateKey,
  writeFailureDiagnostics,
  updateHistory,
  updatePublishedDateHistory,
  writeJsonAtomic
} from '../scripts/update-prices.mjs';

test('builds a deduplicated Apple snapshot index by published date', () => {
  const first = buildAppleSnapshotEntry('Published Date: April 06, 2026', {
    firstConfirmedDate: '2026-07-16',
    archiveUrl: 'https://web.archive.org/web/20260716062720/https://support.apple.com/en-us/108047',
    countries: 70,
    pricePoints: 350,
    contentHash: 'abc'
  });
  assert.equal(first.file, '2026-04-06.html');
  const index = buildAppleSnapshotIndex(null, first);
  assert.equal(first.dataFile, '2026-04-06.json');
  const duplicate = buildAppleSnapshotIndex(index, { ...first, firstConfirmedDate: '2026-08-02' });
  assert.deepEqual(duplicate, index);
  const revised = buildAppleSnapshotIndex(index, {
    ...first,
    file: '2026-04-06-different.html',
    dataFile: '2026-04-06-different.json',
    contentHash: 'different'
  });
  assert.equal(revised.snapshots.length, 1);
  assert.equal(revised.snapshots[0].revisions.length, 2);
  assert.equal(revised.snapshots[0].activeContentHash, 'different');
  assert.equal(revised.snapshots[0].activeDataFile, '2026-04-06-different.json');

  const olderImportedLater = buildAppleSnapshotIndex(revised, {
    ...first,
    file: '2026-04-06-older.html',
    dataFile: '2026-04-06-older.json',
    firstConfirmedDate: '2026-07-01',
    contentHash: 'older'
  });
  assert.deepEqual(
    olderImportedLater.snapshots[0].revisions.map(({ contentHash }) => contentHash),
    ['older', 'abc', 'different']
  );
  assert.equal(olderImportedLater.snapshots[0].activeContentHash, 'different');
});

test('Apple snapshot semantic hash ignores formatted price text', () => {
  const parsed = {
    tiers: [{ id: '50GB', label: '50 GB', capacityGb: 50 }],
    countries: [{ country: 'Alpha', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 0.99, formattedPrice: '$0.99' } } }]
  };
  const reformatted = structuredClone(parsed);
  reformatted.countries[0].plans['50GB'].formattedPrice = 'USD 0.99';
  assert.equal(appleSnapshotContentHash(parsed), appleSnapshotContentHash(reformatted));
});

test('rejects malformed Apple snapshot indexes before writing', () => {
  assert.throws(
    () => buildAppleSnapshotEntry('not-a-date', {
      firstConfirmedDate: '2026-08-05',
      countries: 70,
      pricePoints: 350,
      contentHash: 'a'.repeat(64)
    }),
    /published date is invalid/i
  );
  assert.throws(
    () => normalizeAppleSnapshotIndex({ schemaVersion: 1, snapshots: [{ publishedDate: 'not-a-date', revisions: [] }] }),
    /snapshot index/i
  );
  assert.throws(
    () => normalizeAppleSnapshotIndex({
      schemaVersion: 1,
      snapshots: [{ publishedDate: '2026-04-06', revisions: [] }]
    }),
    /no revisions/i
  );
  assert.throws(
    () => normalizeAppleSnapshotIndex({
      schemaVersion: 1,
      snapshots: [{
        publishedDate: '2026-04-06',
        revisions: [{
          file: '2026-04-06.html',
          dataFile: '2026-04-06.json',
          firstConfirmedDate: '2099-01-01',
          contentHash: 'a'.repeat(64)
        }]
      }]
    }),
    /invalid revision/i
  );
  assert.throws(
    () => normalizeAppleSnapshotIndex({
      schemaVersion: 1,
      snapshots: [
        {
          publishedDate: '2026-04-06',
          revisions: [{
            file: '2026-04-06.html',
            dataFile: '2026-04-06.json',
            firstConfirmedDate: '2026-04-07',
            contentHash: 'a'.repeat(64)
          }]
        },
        {
          publishedDate: '2026-05-12',
          revisions: [{
            file: '2026-04-06.html',
            dataFile: '2026-04-06.json',
            firstConfirmedDate: '2026-05-13',
            contentHash: 'b'.repeat(64)
          }]
        }
      ]
    }),
    /invalid revision/i
  );
});

test('recovers a stale updater lock and protects an active lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-lock-'));
  const lockPath = path.join(root, '.icloud-price-update.lock');
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, acquiredAtUtc: new Date().toISOString() }), 'utf8');
    const release = await acquireUpdateLock(lockPath, { staleAfterMs: 60_000 });
    await assert.rejects(() => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }), /already running/);
    await release();
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not delete a winner lock during stale-lock contention', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-lock-contention-'));
  const lockPath = path.join(root, '.icloud-price-update.lock');
  let claimReachedResolve;
  let allowRecoveryResolve;
  const claimReached = new Promise((resolve) => { claimReachedResolve = resolve; });
  const allowRecovery = new Promise((resolve) => { allowRecoveryResolve = resolve; });
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 999_999_999, acquiredAtUtc: new Date().toISOString() }), 'utf8');
    const firstRun = acquireUpdateLock(lockPath, {
      staleAfterMs: 60_000,
      onStaleLockClaimed: async () => {
        claimReachedResolve();
        await allowRecovery;
      }
    });
    await claimReached;
    await assert.rejects(
      () => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }),
      /already running/
    );
    allowRecoveryResolve();
    const release = await firstRun;
    await assert.rejects(
      () => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }),
      /already running/
    );
    await release();
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    allowRecoveryResolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('serializes concurrent production runs and releases the updater lock', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  delete process.env.EXCHANGE_RATE_API_KEY;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return new Response(html, { status: 200 });
    }
    if (target.includes('exchangerate-api.com') || target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error('Unexpected URL in concurrent-run test: ' + target);
  };
  const lockPath = path.join(root, '.icloud-price-update.lock');
  try {
    const firstRun = main({ dryRun: false, paths: { ...paths, lockPath }, stepSummaryPath: null });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      () => main({ dryRun: false, paths: { ...paths, lockPath }, stepSummaryPath: null }),
      /already running/
    );
    await firstRun;
    await assert.rejects(readFile(lockPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
    await rm(root, { recursive: true, force: true });
  }
});

test('writes, deduplicates, and revises Apple snapshots in production format', async () => {
  const snapshotsDir = await mkdtemp(path.join(tmpdir(), 'icloud-snapshots-'));
  const indexPath = path.join(snapshotsDir, 'index.json');
  const base = {
    sourcePublishedDate: 'Published Date: April 06, 2026',
    parser: 'cross-checked',
    tiers: [TIER_50],
    countries: [country('Alpha', { prices: { '50GB': 1 } })]
  };
  try {
    assert.equal(await savePublishedAppleSnapshot('<html>one</html>', base, '2026-08-02', { snapshotsDir, indexPath }), true);
    assert.equal(await savePublishedAppleSnapshot('<html>one</html>', base, '2026-08-03', { snapshotsDir, indexPath }), false);
    const revised = structuredClone(base);
    revised.countries[0].plans['50GB'].price = 2;
    assert.equal(await savePublishedAppleSnapshot('<html>two</html>', revised, '2026-08-03', { snapshotsDir, indexPath }), true);

    const index = JSON.parse(await readFile(indexPath, 'utf8'));
    assert.equal(index.snapshots.length, 1);
    assert.equal(index.snapshots[0].revisions.length, 2);
    assert.equal(index.snapshots[0].revisions[0].firstConfirmedDate, '2026-08-02');
    assert.equal(index.snapshots[0].revisions[1].firstConfirmedDate, '2026-08-03');
    assert.equal((await readFile(path.join(snapshotsDir, index.snapshots[0].activeFile), 'utf8')), '<html>two</html>');
  } finally {
    await rm(snapshotsDir, { recursive: true, force: true });
  }
});

const TIER_50 = { id: '50GB', label: '50 GB', capacityGb: 50 };
const TIER_200 = { id: '200GB', label: '200 GB', capacityGb: 200 };
const TIER_1TB = { id: '1TB', label: '1 TB', capacityGb: 1024 };
const updaterUrl = new URL('../scripts/update-prices.mjs', import.meta.url);
const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);
const runLogUrl = new URL('../data/run-log.json', import.meta.url);
const namesUrl = new URL('../scripts/country-names.zh.json', import.meta.url);

function recentFxTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function buildAppleHtml(data, publishedDate = data.source.publishedDate) {
  const sections = [
    ['nasalac', 'Americas'],
    ['emea', 'Europe, Middle East & Africa'],
    ['ap', 'Asia Pacific']
  ];
  const sectionHtml = sections.map(([sectionId, region]) => {
    const countries = data.countries.filter((entry) => entry.region === region).map((entry) => [
      `<h4 class="gb-header">${escapeHtml(entry.country)} (${escapeHtml(entry.currency)})</h4>`,
      '<ul>',
      ...data.tiers.map((tier) => `<li><strong>${escapeHtml(tier.label)}</strong>: ${escapeHtml(entry.plans[tier.id].formattedPrice)}</li>`),
      '</ul>'
    ].join('')).join('');
    return `<h3 id="${sectionId}">${escapeHtml(region)}</h3>${countries}`;
  }).join('');
  const publication = publishedDate
    ? `<p>Published Date: <time>${escapeHtml(publishedDate)}</time></p>`
    : '';
  return `<!doctype html><html><body>${sectionHtml}${publication}<!--${'x'.repeat(20_000)}--></body></html>`;
}

async function runDryMain({ html, fxPayload, apiKey = '', authenticatedFxPayload, githubActions = false }) {
  const originalFetch = globalThis.fetch;
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  delete process.env.GITHUB_STEP_SUMMARY;
  if (apiKey) process.env.EXCHANGE_RATE_API_KEY = apiKey;
  else delete process.env.EXCHANGE_RATE_API_KEY;
  if (githubActions) process.env.GITHUB_ACTIONS = 'true';
  else delete process.env.GITHUB_ACTIONS;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) return new Response(html, { status: 200 });
    if (target.includes('v6.exchangerate-api.com')) {
      return new Response(JSON.stringify(authenticatedFxPayload), { status: 200 });
    }
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in dry-run test: ${target}`);
  };
  try {
    return await main({ dryRun: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
    if (originalGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
  }
}

async function withMockedFetch({ html, fxPayload }, callback) {
  const originalFetch = globalThis.fetch;
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  // Production-path tests must not append a second report to the Actions job summary.
  delete process.env.GITHUB_STEP_SUMMARY;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) return new Response(html, { status: 200 });
    if (target.includes('v6.exchangerate-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in production-path test: ${target}`);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  }
}

async function createTemporaryProductionPaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-production-'));
  const dataDir = path.join(root, 'data');
  const paths = {
    currentDataPath: path.join(dataDir, 'prices.json'),
    historyPath: path.join(dataDir, 'history.json'),
    runLogPath: path.join(dataDir, 'run-log.json'),
    namesPath: path.join(root, 'country-names.zh.json'),
    snapshotsDir: path.join(dataDir, 'apple-snapshots'),
    snapshotIndexPath: path.join(dataDir, 'apple-snapshots', 'index.json')
  };
  await mkdir(dataDir, { recursive: true });
  await Promise.all([
    copyFile(pricesUrl, paths.currentDataPath),
    copyFile(historyUrl, paths.historyPath),
    copyFile(runLogUrl, paths.runLogPath),
    copyFile(namesUrl, paths.namesPath)
  ]);
  return { root, paths };
}

test('runs the production write path against isolated files', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const summaryPath = path.join(root, 'unexpected-summary.md');
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  process.env.GITHUB_STEP_SUMMARY = summaryPath;
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => main({ dryRun: false, paths, stepSummaryPath: null })
    );
    const [writtenData, index] = await Promise.all([
      readFile(paths.currentDataPath, 'utf8').then(JSON.parse),
      readFile(paths.snapshotIndexPath, 'utf8').then(JSON.parse)
    ]);
    const snapshot = index.snapshots.find(({ publishedDate }) => publishedDate === '2026-07-17');
    assert.ok(snapshot, 'production run must write the current Apple snapshot');
    assert.equal(snapshot.revisions.length, 1);
    assert.equal(snapshot.revisions[0].firstConfirmedDate, writtenData.run.observedAtBeijing);
    assert.equal(writtenData.source.publishedDate, data.source.publishedDate);
    assert.equal(writtenData.countries.length, data.countries.length);
    await assert.rejects(readFile(summaryPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    await rm(root, { recursive: true, force: true });
  }
});

test('removes unambiguous updater temporary files before a production run', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const staleFiles = [
    `${paths.currentDataPath}.tmp-1-2-stale`,
    `${paths.historyPath}.tmp-1-2-stale`,
    `${paths.snapshotIndexPath}.tmp-1-2-stale`
  ];
  await mkdir(paths.snapshotsDir, { recursive: true });
  await Promise.all(staleFiles.map((filePath) => writeFile(filePath, 'partial', 'utf8')));
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => main({ dryRun: false, paths, stepSummaryPath: null })
    );
    for (const filePath of staleFiles) await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves updater temporary files during a dry-run', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  const temporaryPath = `${paths.currentDataPath}.tmp-1-2-dry-run`;
  await writeFile(temporaryPath, 'partial', 'utf8');
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => main({ dryRun: true, paths, stepSummaryPath: null })
    );
    assert.equal(await readFile(temporaryPath, 'utf8'), 'partial');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rejects a future Apple publication date before dry-run or production writes', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  await withMockedFetch(
    { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
    () => assert.rejects(
      main({ dryRun: true }),
      /Apple published date is in the future/
    )
  );

  const { root, paths } = await createTemporaryProductionPaths();
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /Apple published date is in the future/
      )
    );
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not write a snapshot when publication-date validation fails', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data, 'July 1, 2026'), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths }),
        /Apple published date moved backwards/
      )
    );
    const after = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    assert.deepEqual(after, before);
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('validates the run-log schema before persisting snapshots', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  await mkdir(paths.snapshotsDir, { recursive: true });
  await writeFile(paths.runLogPath, JSON.stringify({ schemaVersion: 1, retention: 90, runs: {} }), 'utf8');
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /Run log has an unsupported structure/
      )
    );
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(await readdir(paths.snapshotsDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves missing prices and history files during rollback', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  await rm(paths.currentDataPath);
  await rm(paths.historyPath);
  const runLogBefore = await readFile(paths.runLogPath, 'utf8');
  let writes = 0;
  const failSecondWrite = async (filePath, value) => {
    writes += 1;
    if (writes === 2) throw new Error('simulated history write failure');
    await writeJsonAtomic(filePath, value);
  };
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null, writeJson: failSecondWrite }),
        /simulated history write failure/
      )
    );
    await assert.rejects(readFile(paths.currentDataPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(paths.historyPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(paths.runLogPath, 'utf8')), JSON.parse(runLogBefore));
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back prices, history, logs, and snapshots when a production write fails midway', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  let writes = 0;
  const failSecondWrite = async (filePath, value) => {
    writes += 1;
    if (writes === 2) throw new Error('simulated history write failure');
    await writeJsonAtomic(filePath, value);
  };

  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null, writeJson: failSecondWrite }),
        /simulated history write failure/
      )
    );
    const after = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    assert.deepEqual(after.map(JSON.parse), before.map(JSON.parse));
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(await readdir(paths.snapshotsDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans up snapshot files when index writing fails', async () => {
  const snapshotsDir = await mkdtemp(path.join(tmpdir(), 'icloud-snapshot-failure-'));
  const indexPath = path.join(snapshotsDir, 'blocked-index');
  const base = {
    sourcePublishedDate: 'Published Date: April 06, 2026',
    parser: 'cross-checked',
    tiers: [TIER_50],
    countries: [country('Alpha', { prices: { '50GB': 1 } })]
  };
  try {
    await mkdir(indexPath);
    await assert.rejects(
      savePublishedAppleSnapshot('<html>failed</html>', base, '2026-08-02', {
        snapshotsDir,
        indexPath
      })
    );
    assert.deepEqual(await readdir(snapshotsDir), ['blocked-index']);
  } finally {
    await rm(snapshotsDir, { recursive: true, force: true });
  }
});

test('writes a failure report and Apple response diagnostic', async () => {
  const diagnosticsDir = await mkdtemp(path.join(tmpdir(), 'icloud-diagnostics-'));
  const summaryPath = path.join(diagnosticsDir, 'summary.md');
  const startedAt = new Date('2026-08-02T15:00:00.000Z');
  const finishedAt = new Date('2026-08-02T15:00:02.500Z');
  try {
    const report = await writeFailureDiagnostics(new Error('snapshot write failed'), {
      diagnosticsDir,
      appleHtml: '<html>diagnostic</html>',
      startedAt,
      finishedAt,
      stepSummaryPath: summaryPath
    });
    const files = await readdir(diagnosticsDir);
    assert.deepEqual(files.sort(), ['apple-response-20260802T150000Z.html', 'run-report.json', 'summary.md']);
    assert.equal(report.status, 'failure');
    assert.equal(report.appleResponseCaptured, true);
    assert.equal(JSON.parse(await readFile(path.join(diagnosticsDir, 'run-report.json'), 'utf8')).error.message, 'snapshot write failed');
    assert.match(await readFile(summaryPath, 'utf8'), /snapshot write failed/);
  } finally {
    await rm(diagnosticsDir, { recursive: true, force: true });
  }
});

test('captures the current Apple response for failure diagnostics', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: data.fx.rates
  };
  await withMockedFetch(
    { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
    () => assert.rejects(main({ dryRun: true }), /Apple published date is in the future/)
  );

  const { root, paths } = await createTemporaryProductionPaths();
  const diagnosticsDir = path.join(root, 'diagnostics');
  const invalidData = structuredClone(data);
  invalidData.fx.rates = { USD: 1 };
  await writeFile(paths.currentDataPath, JSON.stringify(invalidData), 'utf8');
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload: { result: 'error', 'error-type': 'quota-reached' } },
      () => assert.rejects(main({ dryRun: true, paths }), /Exchange-rate service returned quota-reached/)
    );
    await writeFailureDiagnostics(new Error('rate refresh failed'), {
      diagnosticsDir,
      stepSummaryPath: null
    });
    const diagnosticFile = (await readdir(diagnosticsDir)).find((name) => name.startsWith('apple-response-'));
    assert.ok(diagnosticFile, 'failure diagnostics should include the current Apple response');
    const diagnosticHtml = await readFile(path.join(diagnosticsDir, diagnosticFile), 'utf8');
    assert.match(diagnosticHtml, /July 17, 2026/);
    assert.doesNotMatch(diagnosticHtml, /January 1, 2099/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not write production files when a price anomaly is rejected', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const changedCountry = changed.countries.find(({ currency }) => currency === 'USD') ?? changed.countries[0];
  const changedTier = changed.tiers[0].id;
  changedCountry.plans[changedTier].price *= 11;
  changedCountry.plans[changedTier].formattedPrice = `${changedCountry.currency} ${changedCountry.plans[changedTier].price}`;
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(changed), fxPayload },
      () => assert.rejects(main({ dryRun: false, paths }), /suspicious|implausible|anomal|异常/i)
    );
    const after = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    assert.deepEqual(after, before);
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not write production files when required exchange rates are missing', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const missingCurrency = data.countries.find(({ currency }) => currency !== 'USD')?.currency;
  assert.ok(missingCurrency, 'fixture must contain a non-USD currency');
  const rates = { ...data.fx.rates };
  delete rates[missingCurrency];
  const previousData = structuredClone(data);
  delete previousData.fx.rates[missingCurrency];
  await writeFile(paths.currentDataPath, `${JSON.stringify(previousData, null, 2)}\n`, 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(main({ dryRun: false, paths }), /missing|缺少|currency/i)
    );
    const after = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    assert.deepEqual(after, before);
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function country(countryName, {
  nameZh = countryName,
  region = 'Americas',
  currency = 'USD',
  prices = { '50GB': 1, '200GB': 3 }
} = {}) {
  return {
    country: countryName,
    nameZh,
    region,
    currency,
    plans: Object.fromEntries(Object.entries(prices).map(([id, price]) => [id, {
      price,
      formattedPrice: `${currency} ${price}`
    }]))
  };
}

function snapshot({ countries, tiers = [TIER_50, TIER_200], publishedDate = 'July 17, 2026' }) {
  return {
    generatedAt: '2026-07-31T18:30:00.000Z',
    source: { publishedDate },
    tiers,
    countries
  };
}

test('records one initial publication date and only appends genuine date changes', () => {
  const previousData = snapshot({ countries: [country('Alpha')] });
  const history = { schemaVersion: 1, countries: {} };
  const noChanges = { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] };

  const initial = updatePublishedDateHistory(history, previousData, '2026-07-17', '2026-08-01', noChanges);
  assert.equal(initial.changed, false);
  assert.equal(initial.entries.length, 1);
  assert.equal(initial.entries[0].kind, 'initial');
  assert.equal(initial.entries[0].observedAt, '2026-08-01', 'the initial detection date should use Beijing time');

  const repeated = updatePublishedDateHistory(history, previousData, 'July 17, 2026', '2026-08-02', noChanges);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.entries.length, 1);

  const changed = updatePublishedDateHistory(history, previousData, 'August 1, 2026', '2026-08-02', noChanges);
  assert.equal(changed.changed, true);
  assert.equal(changed.entries.length, 2);
  assert.equal(changed.entries.at(-1).kind, 'change');
  assert.deepEqual(changed.entries.at(-1).changes, noChanges);
});

test('rejects a publication date that moves backwards', () => {
  const previousData = snapshot({ countries: [country('Alpha')], publishedDate: 'July 17, 2026' });
  const history = { schemaVersion: 1, countries: {}, sourcePublishedDates: [{
    publishedDate: 'July 17, 2026',
    observedAt: '2026-07-31',
    kind: 'initial',
    changes: { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] }
  }] };
  assert.throws(
    () => updatePublishedDateHistory(history, previousData, 'July 16, 2026', '2026-08-01', {}),
    /published date moved backwards/
  );
});

test('rejects malformed or duplicate existing publication history', () => {
  const previousData = snapshot({ countries: [country('Alpha')], publishedDate: 'July 17, 2026' });
  const changes = { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] };
  assert.throws(
    () => updatePublishedDateHistory({
      schemaVersion: 2,
      countries: {},
      sourcePublishedDates: [{ publishedDate: 'July 17, 2026' }]
    }, previousData, 'July 17, 2026', '2026-08-01', changes),
    /invalid entry/
  );
  assert.throws(
    () => updatePublishedDateHistory({
      schemaVersion: 2,
      countries: {},
      sourcePublishedDates: [
        { publishedDate: 'July 17, 2026', observedAt: '2026-07-31', changes },
        { publishedDate: 'August 1, 2026', observedAt: '2026-08-02', changes },
        { publishedDate: 'July 17, 2026', observedAt: '2026-08-03', changes }
      ]
    }, previousData, 'August 2, 2026', '2026-08-04', changes),
    /duplicate date/
  );
});

test('does not carry a missing currency from old rates into a successful refresh', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: { USD: 1, CNY: 7.2 }
  }), { status: 200 });
  try {
    const fx = await getExchangeRates({ fx: { rates: { USD: 1, CNY: 7.1, JPY: 150 } } }, { apiKey: '' });
    assert.equal(fx.stale, false);
    assert.equal(fx.apiKeyStatus, 'not-configured');
    assert.equal(fx.rates.CNY, 7.2);
    assert.equal(fx.rates.JPY, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('uses the authenticated exchange-rate endpoint without putting the key in the URL', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'test-secret-key';
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    assert.equal(String(url), 'https://v6.exchangerate-api.com/v6/latest/USD');
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
    assert.doesNotMatch(String(url), new RegExp(apiKey));
    return new Response(JSON.stringify({
      result: 'success',
      base_code: 'USD',
      time_last_update_unix: recentFxTimestamp(),
      conversion_rates: { USD: 1, CNY: 7.2, JPY: 150 }
    }), { status: 200 });
  };
  try {
    const fx = await getExchangeRates(null, { apiKey, requiredCurrencies: ['USD', 'CNY', 'JPY'] });
    assert.equal(requestCount, 1);
    assert.equal(fx.sourceMode, 'api-key');
    assert.equal(fx.fallbackUsed, false);
    assert.equal(fx.fallbackReason, null);
    assert.equal(fx.apiKeyStatus, 'valid');
    assert.equal(fx.rates.JPY, 150);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to the open endpoint when the authenticated quota is exhausted', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'test-secret-key';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), authorization: options.headers.authorization });
    if (String(url).includes('v6.exchangerate-api.com')) {
      return new Response(JSON.stringify({ result: 'error', 'error-type': 'quota-reached' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      result: 'success',
      base_code: 'USD',
      time_last_update_unix: recentFxTimestamp(),
      rates: { USD: 1, CNY: 7.2, JPY: 150 }
    }), { status: 200 });
  };
  try {
    const fx = await getExchangeRates(null, { apiKey, requiredCurrencies: ['USD', 'CNY', 'JPY'] });
    assert.deepEqual(requests.map(({ url }) => url), [
      'https://v6.exchangerate-api.com/v6/latest/USD',
      'https://open.er-api.com/v6/latest/USD'
    ]);
    assert.equal(requests[0].authorization, `Bearer ${apiKey}`);
    assert.equal(requests[1].authorization, undefined);
    assert.equal(fx.sourceMode, 'open-access');
    assert.equal(fx.fallbackUsed, true);
    assert.equal(fx.fallbackReason, 'quota-reached');
    assert.equal(fx.apiKeyStatus, 'quota-reached');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back when the authenticated response omits a required currency', async () => {
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async (url) => {
    requestCount += 1;
    const authenticated = String(url).includes('v6.exchangerate-api.com');
    return new Response(JSON.stringify({
      result: 'success',
      base_code: 'USD',
      time_last_update_unix: recentFxTimestamp(),
      ...(authenticated
        ? { conversion_rates: { USD: 1, CNY: 7.2 } }
        : { rates: { USD: 1, CNY: 7.2, JPY: 150 } })
    }), { status: 200 });
  };
  try {
    const fx = await getExchangeRates(null, {
      apiKey: 'test-secret-key',
      requiredCurrencies: ['USD', 'CNY', 'JPY']
    });
    assert.equal(requestCount, 2);
    assert.equal(fx.sourceMode, 'open-access');
    assert.equal(fx.fallbackUsed, true);
    assert.equal(fx.fallbackReason, 'missing-rates');
    assert.equal(fx.apiKeyStatus, 'missing-rates');
    assert.equal(fx.rates.JPY, 150);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not expose the exchange-rate key when both online sources fail', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWarn = console.warn;
  const warnings = [];
  const apiKey = 'secret-that-must-not-appear';
  globalThis.fetch = async () => { throw new Error('temporary outage'); };
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  console.warn = (message) => warnings.push(String(message));
  try {
    await assert.rejects(
      () => getExchangeRates(null, { apiKey }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(apiKey));
        return true;
      }
    );
    assert.ok(warnings.length >= 5);
    assert.doesNotMatch(warnings.join('\n'), new RegExp(apiKey));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    console.warn = originalWarn;
  }
});

test('keeps the previous exchange rates when the refresh fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = async () => { throw new Error('temporary outage'); };
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  const fetchedAt = new Date().toISOString();
  try {
    const fx = await getExchangeRates({
      fx: {
        sourceUrl: 'https://example.test/rates',
        base: 'USD',
        fetchedAt,
        rates: { USD: 1, CNY: 7.1, JPY: 150 }
      }
    });
    assert.equal(fx.stale, true);
    assert.equal(fx.apiKeyStatus, 'not-configured');
    assert.equal(fx.fetchedAt, fetchedAt);
    assert.equal(fx.rates.JPY, 150);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('rejects expired or incomplete previous rates when both online sources fail', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = async () => { throw new Error('temporary outage'); };
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    await assert.rejects(
      () => getExchangeRates({
        fx: {
          base: 'USD',
          fetchedAt: new Date(Date.now() - (37 * 60 * 60 * 1000)).toISOString(),
          rates: { USD: 1, CNY: 7.1, JPY: 150 }
        }
      }, { requiredCurrencies: ['USD', 'CNY', 'JPY'] }),
      /previous exchange rates are unusable: Exchange-rate response is too old/
    );
    await assert.rejects(
      () => getExchangeRates({
        fx: {
          base: 'USD',
          fetchedAt: new Date().toISOString(),
          rates: { USD: 1, CNY: 7.1 }
        }
      }, { requiredCurrencies: ['USD', 'CNY', 'JPY'] }),
      /previous exchange rates are missing for: JPY/
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('does not invent exchange rates when no previous valid rates exist', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ result: 'error' }), { status: 200 });
  try {
    await assert.rejects(
      () => getExchangeRates({ fx: { rates: { USD: 1 } } }, { apiKey: '' }),
      /Exchange-rate response is missing required fields/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('creates a clean initial publication record when no prior snapshot exists', () => {
  const history = { schemaVersion: 1, countries: {} };
  const noisyChanges = {
    addedTiers: [TIER_50],
    removedTiers: [],
    addedCountries: [{ country: 'Alpha' }],
    removedCountries: [],
    changedCountries: []
  };
  const result = updatePublishedDateHistory(history, null, 'July 17, 2026', '2026-08-01', noisyChanges);
  assert.equal(result.changed, false);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, 'initial');
  assert.deepEqual(result.entries[0].changes.addedCountries, []);
});

test('detects tier, country, region, currency, and price changes together', () => {
  const previousData = snapshot({
    countries: [
      country('Alpha', { nameZh: '甲', prices: { '50GB': 1, '200GB': 3 } }),
      country('Removed', { nameZh: '已移除' })
    ]
  });
  const currentCountries = [
    country('Alpha', {
      nameZh: '甲',
      region: 'Asia Pacific',
      currency: 'CAD',
      prices: { '50GB': 2, '1TB': 8 }
    }),
    country('Added', { nameZh: '新增', prices: { '50GB': 1.5, '1TB': 6 } })
  ];

  const changes = buildSnapshotChanges(previousData, currentCountries, [TIER_50, TIER_1TB]);
  assert.deepEqual(changes.addedTiers, [{ id: '1TB', label: '1 TB' }]);
  assert.deepEqual(changes.removedTiers, [{ id: '200GB', label: '200 GB' }]);
  assert.deepEqual(changes.addedCountries, [{ country: 'Added', nameZh: '新增' }]);
  assert.deepEqual(changes.removedCountries, [{ country: 'Removed', nameZh: '已移除' }]);
  assert.equal(changes.changedCountries.length, 1);
  assert.deepEqual(changes.changedCountries[0], {
    country: 'Alpha',
    nameZh: '甲',
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    fromRegion: 'Americas',
    toRegion: 'Asia Pacific',
    tiers: [{ id: '50GB', from: 1, to: 2 }]
  });
});

test('keeps removed-country history and appends complete events for a new tier', () => {
  const history = {
    schemaVersion: 1,
    countries: {
      Alpha: {
        nameZh: '甲',
        region: 'Americas',
        events: [{ observedAt: '2026-07-01', currency: 'USD', plans: { '50GB': 1, '200GB': 3 } }]
      },
      Removed: {
        nameZh: '已移除',
        region: 'Americas',
        events: [{ observedAt: '2026-07-01', currency: 'USD', plans: { '50GB': 1, '200GB': 3 } }]
      }
    }
  };
  const alphaWithNewTier = country('Alpha', { nameZh: '甲', prices: { '50GB': 1, '1TB': 8 } });
  const result = updateHistory(history, [alphaWithNewTier], '2026-08-01', [TIER_50, TIER_1TB], '2026-07-31T16:00:00.000Z');

  assert.ok(result.history.countries.Removed, 'removal should not erase historical events');
  assert.equal(result.history.countries.Alpha.events.length, 2);
  assert.deepEqual(result.history.countries.Alpha.events.at(-1).plans, { '50GB': 1, '1TB': 8 });
  assert.equal(result.history.countries.Alpha.events.at(-1).observedAtBeijing, '2026-08-01');
  assert.equal(result.history.countries.Alpha.events.at(-1).observedAtUtc, '2026-07-31T16:00:00.000Z');

  const repeated = updateHistory(result.history, [alphaWithNewTier], '2026-08-02', [TIER_50, TIER_1TB]);
  assert.equal(repeated.history.countries.Alpha.events.length, 2, 'unchanged prices should not duplicate history');
});

test('rejects a price event whose observation date moves backwards', () => {
  const history = {
    schemaVersion: 2,
    countries: {
      Alpha: {
        nameZh: 'Alpha',
        region: 'Americas',
        events: [{ observedAt: '2026-08-02', currency: 'USD', plans: { '50GB': 1 } }]
      }
    }
  };
  assert.throws(
    () => updateHistory(
      history,
      [country('Alpha', { prices: { '50GB': 2 } })],
      '2026-08-01',
      [TIER_50]
    ),
    /observation date moved backwards/
  );
});

test('rejects unsafe country keys before updating history objects', () => {
  assert.throws(
    () => updateHistory(
      { schemaVersion: 2, countries: {} },
      [country('__proto__')],
      '2026-08-01',
      [TIER_50]
    ),
    /Unsafe country key/
  );
  assert.equal(Object.prototype.nameZh, undefined);
});

test('reuses preserved history when a removed country later returns', () => {
  const history = {
    schemaVersion: 1,
    countries: {
      Alpha: {
        nameZh: '甲',
        region: 'Americas',
        events: [{ observedAt: '2026-07-01', currency: 'USD', plans: { '50GB': 1, '200GB': 3 } }]
      }
    }
  };
  updateHistory(history, [], '2026-07-15', [TIER_50, TIER_200]);
  const returned = updateHistory(history, [country('Alpha', { nameZh: '甲', prices: { '50GB': 2, '200GB': 4 } })], '2026-08-01', [TIER_50, TIER_200]);
  assert.equal(returned.history.countries.Alpha.events.length, 2);
  assert.equal(returned.history.countries.Alpha.events.at(-1).plans['50GB'], 2);
});

test('normalizes equivalent Apple publication-date formats', () => {
  assert.equal(publicationDateKey('July 17, 2026'), publicationDateKey('2026-07-17'));
  assert.equal(publicationDateKey('Published Date: July 17, 2026'), publicationDateKey('2026-07-17'));
  assert.notEqual(publicationDateKey('July 17, 2026'), publicationDateKey('August 1, 2026'));
});

test('rejects impossible or unsupported calendar dates instead of normalizing them', () => {
  for (const value of ['February 30, 2026', 'April 31, 2026', '2026-02-30', '2026-13-01', 'Feb 28, 2026']) {
    assert.match(publicationDateKey(value), /^raw:/, value);
  }
  assert.equal(publicationDateKey('February 29, 2024'), '2024-02-29');
  assert.match(publicationDateKey('February 29, 2026'), /^raw:/);
});

test('runs the complete updater in dry-run mode without modifying committed data', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const before = await Promise.all([pricesUrl, historyUrl, runLogUrl].map((url) => readFile(url, 'utf8')));
  const messages = [];
  const originalLog = console.log;
  console.log = (...parts) => messages.push(parts.join(' '));
  try {
    await runDryMain({
      html: buildAppleHtml(data),
      fxPayload: {
        result: 'success',
        base_code: 'USD',
        time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
        rates: data.fx.rates
      }
    });
  } finally {
    console.log = originalLog;
  }
  const after = await Promise.all([pricesUrl, historyUrl, runLogUrl].map((url) => readFile(url, 'utf8')));
  assert.deepEqual(after, before, 'dry-run must not change prices, history, or run logs');
  assert.ok(messages.some((message) => /Live check passed with cross-checked: 73 countries and 365 prices/.test(message)));
});

test('accepts compact Apple 50GB labels during the fetch preflight', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  await runDryMain({
    html: buildAppleHtml(data).replaceAll('50 GB', '50GB'),
    fxPayload
  });
});

test('complete dry-run keeps previous rates for an incomplete online response and rejects a missing Apple publication date', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const missingCurrency = data.countries.find(({ currency }) => currency !== 'USD').currency;
  const incompleteRates = { ...data.fx.rates };
  delete incompleteRates[missingCurrency];
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: incompleteRates
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    await runDryMain({ html: buildAppleHtml(data), fxPayload });
  } finally {
    console.warn = originalWarn;
  }
  assert.match(warnings.join('\n'), new RegExp(`Exchange rates are missing for:.*${missingCurrency}`));
  assert.match(warnings.join('\n'), /keeping previous rates/);
  await assert.rejects(
    () => runDryMain({ html: buildAppleHtml(data, null), fxPayload: { ...fxPayload, rates: data.fx.rates } }),
    /Apple published date was not found/
  );
});

test('builds a structured successful run log with source, counts, and changes', () => {
  const originalEventName = process.env.GITHUB_EVENT_NAME;
  const originalTriggerSource = process.env.ICLOUD_TRIGGER_SOURCE;
  const originalAutomaticDate = process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING;
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  process.env.ICLOUD_TRIGGER_SOURCE = 'cloudflare';
  process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING = '2026-08-01';
  const data = {
    source: {
      url: 'https://support.apple.com/en-us/108047',
      publishedDate: 'July 17, 2026',
      parser: 'cross-checked',
      parserStatus: 'Both independent parser paths agreed'
    },
    fx: {
      fetchedAt: '2026-08-01T00:02:31.000Z',
      stale: false,
      sourceMode: 'api-key',
      fallbackUsed: false,
      fallbackReason: null,
      apiKeyStatus: 'valid'
    },
    tiers: [TIER_50, TIER_200],
    countries: [country('Alpha'), country('Beta', { currency: 'CAD' })]
  };
  const publicationChanges = {
    addedTiers: [],
    removedTiers: [],
    addedCountries: [{ country: 'Beta', nameZh: 'Beta' }],
    removedCountries: [],
    changedCountries: []
  };
  let entry;
  try {
    entry = createRunLogEntry(
      data,
      {
        observedAt: '2026-08-01',
        publicationChanges,
        publicationDateChanged: true,
        publishedDateHistory: [{ publishedDate: 'July 1, 2026' }, { publishedDate: 'July 17, 2026' }]
      },
      new Date('2026-08-01T04:00:00.000Z'),
      new Date('2026-08-01T04:00:02.500Z')
    );
  } finally {
    if (originalEventName === undefined) delete process.env.GITHUB_EVENT_NAME;
    else process.env.GITHUB_EVENT_NAME = originalEventName;
    if (originalTriggerSource === undefined) delete process.env.ICLOUD_TRIGGER_SOURCE;
    else process.env.ICLOUD_TRIGGER_SOURCE = originalTriggerSource;
    if (originalAutomaticDate === undefined) delete process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING;
    else process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING = originalAutomaticDate;
  }

  assert.equal(entry.status, 'success');
  assert.equal(entry.trigger, 'cloudflare');
  assert.equal(entry.automaticRunDateBeijing, '2026-08-01');
  assert.equal(entry.durationMs, 2500);
  assert.equal(entry.observedAtBeijing, '2026-08-01');
  assert.equal(entry.source.applePublishedDate, 'July 17, 2026');
  assert.equal(entry.source.appleParser, 'cross-checked');
  assert.match(entry.source.appleParserStatus, /agreed/);
  assert.equal(entry.source.exchangeRatesSourceMode, 'api-key');
  assert.equal(entry.source.exchangeRatesFallbackUsed, false);
  assert.equal(entry.source.exchangeRatesFallbackReason, null);
  assert.equal(entry.source.exchangeRatesApiKeyStatus, 'valid');
  assert.equal(entry.counts.countries, 2);
  assert.equal(entry.counts.pricePoints, 4);
  assert.equal(entry.counts.currencies, 2);
  assert.deepEqual(entry.changes.publishedDate, {
    changed: true,
    from: 'July 1, 2026',
    to: 'July 17, 2026'
  });
  assert.deepEqual(entry.changes.addedCountries, [{ country: 'Beta', nameZh: 'Beta' }]);

  const previousRuns = Array.from({ length: 90 }, (_, index) => ({ id: String(index) }));
  const log = buildRunLog({ schemaVersion: 1, retention: 90, runs: previousRuns }, entry);
  assert.equal(log.runs.length, 90);
  assert.equal(log.runs.at(-1), entry);
  assert.equal(log.runs[0].id, '1');
  assert.throws(
    () => buildRunLog({ schemaVersion: 2, runs: [] }, entry),
    /unsupported structure/
  );
});

test('clamps run-log completion timestamps when the clock moves backwards', () => {
  const startedAt = new Date('2026-08-03T00:00:02.000Z');
  const finishedAt = new Date('2026-08-03T00:00:01.000Z');
  const entry = createRunLogEntry(
    {
      source: { url: 'https://support.apple.com/en-us/108047', publishedDate: 'July 17, 2026' },
      fx: { fetchedAt: '2026-08-03T00:00:00.000Z', stale: false },
      tiers: [TIER_50],
      countries: [country('Alpha')]
    },
    {
      observedAt: '2026-08-03',
      publicationChanges: {
        addedTiers: [],
        removedTiers: [],
        addedCountries: [],
        removedCountries: [],
        changedCountries: []
      },
      publicationDateChanged: false,
      publishedDateHistory: [{ publishedDate: 'July 17, 2026' }]
    },
    startedAt,
    finishedAt
  );
  assert.equal(entry.finishedAtUtc, startedAt.toISOString());
  assert.equal(entry.id, startedAt.toISOString());
  assert.equal(entry.durationMs, 0);
});

test('rejects invalid USD anchors, timestamps, and stale fallback rates', async () => {
  const originalFetch = globalThis.fetch;
  const invalidPayloads = [
    { result: 'success', base_code: 'USD', time_last_update_unix: recentFxTimestamp(), rates: { USD: 2, CNY: 7.2 } },
    { result: 'success', base_code: 'USD', time_last_update_unix: 0, rates: { USD: 1, CNY: 7.2 } },
    { result: 'success', base_code: 'EUR', time_last_update_unix: recentFxTimestamp(), rates: { USD: 1, CNY: 7.2 } },
    { result: 'success', base_code: 'USD', time_last_update_unix: recentFxTimestamp(), rates: { USD: 1, CNY: -7.2 } }
  ];
  try {
    for (const payload of invalidPayloads) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      await assert.rejects(
        () => getExchangeRates({ fx: { rates: { USD: 0, CNY: -1 } } }, { apiKey: '' }),
        /Exchange-rate response is missing required fields/
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects stale and future exchange-rate timestamps', async () => {
  const originalFetch = globalThis.fetch;
  const nowSeconds = recentFxTimestamp();
  const payloads = [
    {
      payload: {
        result: 'success',
        base_code: 'USD',
        time_last_update_unix: nowSeconds - (37 * 60 * 60),
        rates: { USD: 1, CNY: 7.2 }
      },
      message: /too old/
    },
    {
      payload: {
        result: 'success',
        base_code: 'USD',
        time_last_update_unix: nowSeconds + (6 * 60),
        rates: { USD: 1, CNY: 7.2 }
      },
      message: /future/
    }
  ];
  try {
    for (const { payload, message } of payloads) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      await assert.rejects(
        () => getExchangeRates(null, { apiKey: '' }),
        message
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps successful Action summaries concise and promotes warnings', () => {
  const data = {
    source: {
      publishedDate: 'July 17, 2026',
      parser: 'cross-checked',
      parserStatus: 'Both independent parser paths agreed'
    },
    generatedAt: '2026-07-31T22:10:00.000Z',
    fx: {
      fetchedAt: '2026-07-31T00:02:31.000Z',
      stale: false,
      sourceMode: 'api-key',
      fallbackUsed: false,
      fallbackReason: null,
      apiKeyStatus: 'valid'
    },
    tiers: [TIER_50, TIER_200],
    countries: [country('Alpha')]
  };
  const summary = {
    history: { countries: { Alpha: {} } },
    missingRates: [],
    addedCountries: [],
    removedCountries: [],
    changedCountries: 0,
    publishedDateHistory: [{ publishedDate: 'July 17, 2026' }],
    publicationDateChanged: false,
    publicationChanges: {
      addedTiers: [],
      removedTiers: [],
      addedCountries: [],
      removedCountries: [],
      changedCountries: []
    }
  };

  const rendered = buildActionSummaryLines(data, summary, 'workflow_dispatch').join('\n');
  assert.match(rendered, /### 结论/);
  assert.match(rendered, /触发方式：手动执行/);
  assert.match(rendered, /Apple 解析路径：cross-checked（双解析器一致）/);
  assert.match(rendered, /汇率来源：ExchangeRate-API Key 接口（主来源）/);
  assert.match(rendered, /汇率认证：API Key 有效/);
  assert.match(rendered, /### 本次变化\n本次变化：无/);
  assert.doesNotMatch(rendered, /本次新增地区：无|本次移除地区：无|缺少汇率：无/);

  const cloudflare = buildActionSummaryLines(data, summary, 'cloudflare').join('\n');
  assert.match(cloudflare, /触发方式：Cloudflare 定时主触发/);

  const githubBackup = buildActionSummaryLines(data, summary, 'github-schedule').join('\n');
  assert.match(githubBackup, /触发方式：GitHub 定时备用/);

  const stale = buildActionSummaryLines({
    ...data,
    fx: { ...data.fx, stale: true, apiKeyStatus: 'request-failed' }
  }, {
    ...summary,
    missingRates: ['JPY']
  }, 'schedule').join('\n');
  assert.match(stale, /### 警告/);
  assert.match(stale, /汇率降级/);
  assert.match(stale, /汇率认证：主接口请求失败，开放接口也不可用/);
  assert.match(stale, /缺少汇率.*JPY/);

  const noSecret = buildActionSummaryLines({
    ...data,
    fx: {
      ...data.fx,
      sourceMode: 'open-access',
      fallbackUsed: false,
      fallbackReason: null,
      apiKeyStatus: 'not-configured'
    }
  }, summary, 'schedule').join('\n');
  assert.match(noSecret, /汇率认证：未配置 API Key，使用开放接口/);
  assert.doesNotMatch(noSecret, /### 警告/);

  const fallback = buildActionSummaryLines({
    ...data,
    fx: {
      ...data.fx,
      sourceMode: 'open-access',
      fallbackUsed: true,
      fallbackReason: 'quota-reached',
      apiKeyStatus: 'quota-reached'
    }
  }, summary, 'schedule').join('\n');
  assert.match(fallback, /汇率来源：ExchangeRate-API 开放接口（自动回退）/);
  assert.match(fallback, /汇率认证：API 额度已用完，使用开放接口/);
  assert.doesNotMatch(fallback, /### 警告/);
});

test('reports missing or invalid exchange-rate credentials as notices without warnings', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const messages = [];
  const originalLog = console.log;
  console.log = (...parts) => messages.push(parts.join(' '));
  try {
    await runDryMain({ html: buildAppleHtml(data), fxPayload, githubActions: true });
    await runDryMain({
      html: buildAppleHtml(data),
      fxPayload,
      apiKey: 'invalid-test-key',
      authenticatedFxPayload: { result: 'error', 'error-type': 'invalid-key' },
      githubActions: true
    });
  } finally {
    console.log = originalLog;
  }

  const output = messages.join('\n');
  assert.match(output, /::notice title=未配置汇率 API Key::/);
  assert.match(output, /::notice title=汇率 API Key 未生效::API Key 无效，已使用开放接口。/);
  assert.doesNotMatch(output, /::warning/);
});

test('shows price, currency, region, country, tier, and publication-date changes separately', () => {
  const data = {
    source: { publishedDate: 'July 17, 2026', parser: 'cross-checked' },
    generatedAt: '2026-08-01T00:30:00.000Z',
    fx: {
      fetchedAt: '2026-08-01T00:02:31.000Z',
      stale: false,
      sourceMode: 'api-key',
      fallbackUsed: false,
      fallbackReason: null
    },
    tiers: [TIER_50, TIER_1TB],
    countries: [country('Alpha')]
  };
  const summary = {
    history: { countries: { Alpha: {} } },
    missingRates: [],
    addedCountries: ['Added'],
    removedCountries: ['Removed'],
    changedCountries: 1,
    publishedDateHistory: [{ publishedDate: 'July 1, 2026' }, { publishedDate: 'July 17, 2026' }],
    publicationDateChanged: true,
    publicationChanges: {
      addedTiers: [{ id: '1TB', label: '1 TB' }],
      removedTiers: [{ id: '200GB', label: '200 GB' }],
      addedCountries: [{ country: 'Added', nameZh: '新增' }],
      removedCountries: [{ country: 'Removed', nameZh: '移除' }],
      changedCountries: [{
        country: 'Alpha',
        nameZh: '甲',
        fromCurrency: 'USD',
        toCurrency: 'CAD',
        fromRegion: 'Americas',
        toRegion: 'Asia Pacific',
        tiers: [{ id: '50GB', from: 1, to: 2 }]
      }]
    }
  };

  const rendered = buildActionSummaryLines(data, summary, 'schedule').join('\n');
  assert.match(rendered, /Apple 发布日期：July 1, 2026 → July 17, 2026/);
  assert.match(rendered, /新增容量：1 TB/);
  assert.match(rendered, /移除容量：200 GB/);
  assert.match(rendered, /新增地区：新增/);
  assert.match(rendered, /移除地区：移除/);
  assert.match(rendered, /所属分区变化：甲/);
  assert.match(rendered, /币种变化：甲/);
  assert.match(rendered, /价格变化：甲/);
});

test('keeps failure diagnostics compact without duplicate files', async () => {
  const source = await readFile(updaterUrl, 'utf8');
  assert.match(source, /run-report\.json/);
  assert.doesNotMatch(source, /update-failure\.json/);
  assert.doesNotMatch(source, /path\.join\(DIAGNOSTICS_DIR, 'apple-response\.html'\)/);
});

test('initializes the confirmation date before saving a production snapshot', async () => {
  const source = await readFile(updaterUrl, 'utf8');
  const observedAtDeclaration = source.indexOf('const observedAt = formatBeijingDate(generatedAt);');
  const publicationValidation = source.indexOf('const publishedDateUpdate = updatePublishedDateHistory(');
  const snapshotWrite = source.indexOf('await savePublishedAppleSnapshot(html, parsed, observedAt, {');
  assert.ok(observedAtDeclaration >= 0, 'confirmation date declaration must exist');
  assert.ok(snapshotWrite > observedAtDeclaration, 'production snapshot must only use an initialized confirmation date');
  assert.ok(snapshotWrite > publicationValidation, 'production snapshot must only be written after publication-date validation');
});


test('fails closed when the snapshot index is missing while evidence exists', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const oldHtml = path.join(paths.snapshotsDir, '2024-12-05.html');
  const oldData = path.join(paths.snapshotsDir, '2024-12-05.json');
  await mkdir(paths.snapshotsDir, { recursive: true });
  await writeFile(oldHtml, '<old evidence>', 'utf8');
  await writeFile(oldData, '{"old":true}', 'utf8');
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /snapshot index is missing while snapshot evidence exists/
      )
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.equal(await readFile(oldHtml, 'utf8'), '<old evidence>');
    assert.equal(await readFile(oldData, 'utf8'), '{"old":true}');
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed on an invalid snapshot index without deleting evidence', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const oldHtml = path.join(paths.snapshotsDir, '2024-12-05.html');
  await mkdir(paths.snapshotsDir, { recursive: true });
  await writeFile(oldHtml, '<old evidence>', 'utf8');
  await writeFile(paths.snapshotIndexPath, '{not-json', 'utf8');
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /Unable to read valid JSON from index\.json/
      )
    );
    assert.equal(await readFile(oldHtml, 'utf8'), '<old evidence>');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed on an empty snapshot index without deleting evidence', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const oldHtml = path.join(paths.snapshotsDir, '2024-12-05.html');
  const oldData = path.join(paths.snapshotsDir, '2024-12-05.json');
  await mkdir(paths.snapshotsDir, { recursive: true });
  await writeFile(oldHtml, '<old evidence>', 'utf8');
  await writeFile(oldData, '{"old":true}', 'utf8');
  await writeFile(paths.snapshotIndexPath, JSON.stringify({ schemaVersion: 1, snapshots: [] }), 'utf8');
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /snapshot index does not reference existing evidence/
      )
    );
    assert.equal(await readFile(oldHtml, 'utf8'), '<old evidence>');
    assert.equal(await readFile(oldData, 'utf8'), '{"old":true}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when a snapshot index omits existing evidence', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const indexedHtml = path.join(paths.snapshotsDir, '2024-12-05.html');
  const indexedData = path.join(paths.snapshotsDir, '2024-12-05.json');
  const unindexedHtml = path.join(paths.snapshotsDir, '2024-12-06.html');
  const unindexedData = path.join(paths.snapshotsDir, '2024-12-06.json');
  await mkdir(paths.snapshotsDir, { recursive: true });
  await Promise.all([
    writeFile(indexedHtml, '<indexed evidence>', 'utf8'),
    writeFile(indexedData, '{"indexed":true}', 'utf8'),
    writeFile(unindexedHtml, '<unindexed evidence>', 'utf8'),
    writeFile(unindexedData, '{"unindexed":true}', 'utf8')
  ]);
  await writeFile(paths.snapshotIndexPath, JSON.stringify({
    schemaVersion: 1,
    snapshots: [{
      publishedDate: '2024-12-05',
      revisions: [{
        file: '2024-12-05.html',
        dataFile: '2024-12-05.json',
        firstConfirmedDate: '2026-08-01',
        contentHash: 'a'.repeat(64)
      }]
    }]
  }), 'utf8');
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /snapshot index does not reference existing evidence: 2024-12-06\.html, 2024-12-06\.json/
      )
    );
    assert.deepEqual(await Promise.all([
      readFile(indexedHtml, 'utf8'),
      readFile(indexedData, 'utf8'),
      readFile(unindexedHtml, 'utf8'),
      readFile(unindexedData, 'utf8')
    ]), ['<indexed evidence>', '{"indexed":true}', '<unindexed evidence>', '{"unindexed":true}']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('rejects malformed history countries before any production write', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = await readFile(new URL('../data/apple-snapshots/2026-07-17.html', import.meta.url), 'utf8');
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: data.fx.rates
  };
  const malformedHistory = JSON.stringify({ schemaVersion: 2, countries: [], sourcePublishedDates: [] });
  await writeFile(paths.historyPath, malformedHistory, 'utf8');
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /unsupported countries structure/
      )
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.equal(await readFile(paths.historyPath, 'utf8'), malformedHistory);
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed on a fresh malformed updater lock and recovers an old one', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-lock-malformed-'));
  const lockPath = path.join(root, '.icloud-price-update.lock');
  try {
    await writeFile(lockPath, '{', 'utf8');
    await assert.rejects(
      () => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }),
      /already running/
    );
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const release = await acquireUpdateLock(lockPath, { staleAfterMs: 60_000 });
    await release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('derives the project-level lock from custom data paths', () => {
  const currentDataPath = path.join('C:', 'isolated', 'data', 'prices.json');
  assert.equal(
    defaultUpdateLockPath(currentDataPath),
    path.join('C:', 'isolated', '.icloud-price-update.lock')
  );
});

test('rejects future Apple snapshot confirmation dates', () => {
  assert.throws(
    () => buildAppleSnapshotEntry('May 12, 2025', {
      firstConfirmedDate: '2099-01-01',
      countries: 60,
      pricePoints: 180,
      contentHash: 'a'.repeat(64)
    }),
    /first confirmation date is invalid or in the future/
  );
});
