import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { validateHistoryPayload, validatePriceHistoryConsistency } from '../data-contract.js';
import { resolveMarket } from '../scripts/market-registry.mjs';
import {
  buildSnapshotChanges,
  buildRunLog,
  buildActionSummaryLines,
  buildAppleSnapshotEntry,
  buildAppleSnapshotIndex,
  defaultUpdateLockPath,
  defaultUpdateTransactionPath,
  appleSnapshotContentHash,
  appleSemanticChanged,
  appleSemanticHash,
  appleStructuralChanges,
  acquireUpdateLock,
  attachDerivedCnyPrices,
  normalizeAppleSnapshotIndex,
  savePublishedAppleSnapshot,
  createRunLogEntry,
  createNetworkBudget,
  confirmCountryRemovals,
  confirmAppleStructuralChanges,
  confirmAppleSemanticChange,
  classifyHealthcheckFailure,
  fetchResource,
  escapeGitHubCommandMessage,
  getExchangeRates,
  validateFxSanity,
  FX_SANITY_MAX_DAILY_CHANGE,
  MIN_FX_SANITY_POINTS,
  logInline,
  main,
  publicationDateKey,
  publicExchangeRateMetadata,
  redactDiagnosticText,
  selectRequiredRates,
  validateCountryNameMapping,
  validateAppleMarketRenameReview,
  writeFailureDiagnostics,
  updateHistory,
  updatePublishedDateHistory,
  writeJsonAtomic
} from '../scripts/update-prices.mjs';

test('classifies only explicitly tagged operational failures as transient', () => {
  assert.equal(classifyHealthcheckFailure(new Error('unknown integrity failure')), 'severe');
  const transient = new Error('temporary network outage');
  transient.healthcheckSeverity = 'transient';
  assert.equal(classifyHealthcheckFailure(transient), 'transient');
  assert.equal(classifyHealthcheckFailure(null), 'severe');
});

test('redacts credentials from diagnostic text', () => {
  const secret = 'super-secret-api-key';
  const redacted = redactDiagnosticText(
    `Authorization: Bearer ${secret} https://v6.exchangerate-api.com/v6/${secret}/latest/USD?token=${secret}`,
    { EXCHANGE_RATE_API_KEY: secret }
  );
  assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /\[REDACTED\]/);
});

test('strictly validates the committed country-name mapping and rejects unsafe entries', async () => {
  const mapping = JSON.parse(await readFile(namesUrl, 'utf8'));
  assert.equal(validateCountryNameMapping(mapping), mapping);
  assert.equal(mapping.mu, null);
  assert.equal(mapping.cg, null);
  assert.throws(() => validateCountryNameMapping([]), /unsupported structure/);
  assert.throws(() => validateCountryNameMapping({ Alpha: '甲' }), /incomplete/);

  const unsafeKey = structuredClone(mapping);
  Object.defineProperty(unsafeKey, '__proto__', { value: '危险', enumerable: true });
  assert.throws(() => validateCountryNameMapping(unsafeKey), /unsafe entry/);

  const unsafeValue = structuredClone(mapping);
  unsafeValue.Australia = '澳大利亚\u202e';
  assert.throws(() => validateCountryNameMapping(unsafeValue), /unsafe entry/);
  const invalidPending = structuredClone(mapping);
  invalidPending.mu = false;
  assert.throws(() => validateCountryNameMapping(invalidPending), /unsafe entry/);
});

test('bounds and flattens untrusted workflow log text', () => {
  assert.equal(
    logInline('remote failure\n::warning title=injected::payload\u202e'),
    'remote failure : :warning title=injected: :payload '
  );
  const bounded = logInline('x'.repeat(2_500));
  assert.equal([...bounded].length, 2_001);
  assert.match(bounded, /…$/);
});

test('escapes untrusted GitHub workflow command messages', () => {
  assert.equal(
    escapeGitHubCommandMessage('market%\r\n::warning::'),
    'market%25%0D%0A%3A%3Awarning%3A%3A'
  );
});

test('builds a deduplicated Apple snapshot index by published date', () => {
  const first = buildAppleSnapshotEntry('Published Date: April 06, 2026', {
    firstConfirmedDate: '2026-07-16',
    archiveUrl: 'https://web.archive.org/web/20260716062720/https://support.apple.com/en-us/108047',
    countries: 70,
    pricePoints: 350,
    contentHash: 'abc'
  });
  const index = buildAppleSnapshotIndex(null, first);
  assert.equal(index.schemaVersion, 2);
  assert.equal(first.dataFile, '2026-04-06.json');
  const duplicate = buildAppleSnapshotIndex(index, { ...first, firstConfirmedDate: '2026-08-02' });
  assert.deepEqual(duplicate, index);
  const earlierDuplicate = buildAppleSnapshotIndex(index, {
    ...first,
    dataFile: '2026-04-06-ignored.json',
    firstConfirmedDate: '2026-07-01',
    archiveUrl: 'https://web.archive.org/web/20260701000000/https://support.apple.com/en-us/108047'
  });
  assert.equal(earlierDuplicate.snapshots[0].revisions.length, 1);
  assert.equal(earlierDuplicate.snapshots[0].revisions[0].firstConfirmedDate, '2026-07-01');
  assert.equal(earlierDuplicate.snapshots[0].revisions[0].dataFile, first.dataFile);
  assert.match(earlierDuplicate.snapshots[0].revisions[0].archiveUrl, /20260701000000/);
  const revised = buildAppleSnapshotIndex(index, {
    ...first,
    dataFile: '2026-04-06-different.json',
    contentHash: 'different'
  });
  assert.equal(revised.snapshots.length, 1);
  assert.equal(revised.snapshots[0].revisions.length, 2);
  assert.equal(revised.snapshots[0].activeContentHash, 'different');
  assert.equal(revised.snapshots[0].activeDataFile, '2026-04-06-different.json');

  const olderImportedLater = buildAppleSnapshotIndex(revised, {
    ...first,
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

test('Apple semantic hash covers every business-semantic field and ignores ordering or presentation', () => {
  const baseline = {
    source: { publishedDate: 'July 17, 2026' },
    tiers: [TIER_200, TIER_50],
    countries: [
      { country: 'Beta', region: 'Asia Pacific', currency: 'JPY', plans: { '200GB': { price: 400, formattedPrice: '¥400' }, '50GB': { price: 100, formattedPrice: '¥100' } } },
      { country: 'Alpha', region: 'Americas', currency: 'USD', plans: { '200GB': { price: 2.99, formattedPrice: '$2.99' }, '50GB': { price: 0.99, formattedPrice: '$0.99' } } }
    ]
  };
  const reordered = structuredClone(baseline);
  reordered.tiers.reverse();
  reordered.countries.reverse();
  reordered.countries[1].plans['50GB'].formattedPrice = 'USD 0.99';
  assert.equal(appleSemanticHash(baseline), appleSemanticHash(reordered));

  const mutations = [
    (value) => { value.countries[0].plans['50GB'].price += 1; },
    (value) => { value.countries[0].currency = 'CNY'; },
    (value) => { value.source.publishedDate = 'July 18, 2026'; },
    (value) => { value.countries.push({ country: 'Gamma', region: 'Europe, Middle East & Africa', currency: 'EUR', plans: { '50GB': { price: 1 }, '200GB': { price: 3 } } }); },
    (value) => { value.countries.pop(); },
    (value) => { value.tiers.push(TIER_1TB); value.countries.forEach((country) => { country.plans['1TB'] = { price: 10 }; }); },
    (value) => { value.tiers = value.tiers.filter(({ id }) => id !== '200GB'); value.countries.forEach((country) => { delete country.plans['200GB']; }); },
    (value) => { value.countries[0].region = 'Americas'; }
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.equal(appleSemanticChanged(baseline, changed), true);
  }
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

test('never steals an old lock from a live process', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-live-lock-'));
  const lockPath = path.join(root, '.icloud-price-update.lock');
  try {
    await writeFile(lockPath, JSON.stringify({
      pid: process.pid,
      acquiredAtUtc: new Date(Date.now() - 31 * 60 * 1_000).toISOString(),
      token: 'live-process'
    }), 'utf8');
    await assert.rejects(() => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }), /already running/);
    assert.equal((await readFile(lockPath, 'utf8')).includes('live-process'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('confirms legitimate removals only when two complete Apple parses are identical', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const first = {
    sourcePublishedDate: data.source.publishedDate,
    parser: 'cross-checked',
    tiers: data.tiers,
    countries: data.countries.slice(1)
  };
  const second = structuredClone(first);
  assert.deepEqual(confirmCountryRemovals(first, second, data.countries), [data.countries[0].country]);

  second.countries[0].plans[data.tiers[0].id].price += 1;
  assert.throws(
    () => confirmCountryRemovals(first, second, data.countries),
    /not reproduced by the independent Apple confirmation fetch/
  );
  assert.throws(
    () => confirmCountryRemovals({ ...first, parser: 'document-order' }, first, data.countries),
    /two fully cross-checked Apple parses/
  );
});

test('requires an identical independent confirmation for global storage-tier changes', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const removedTier = data.tiers.at(-1).id;
  const first = {
    sourcePublishedDate: data.source.publishedDate,
    parser: 'cross-checked',
    tiers: data.tiers.slice(0, -1),
    countries: data.countries.map((country) => {
      const next = structuredClone(country);
      delete next.plans[removedTier];
      return next;
    })
  };
  const changes = appleStructuralChanges(data, first);
  assert.deepEqual(changes.removedTiers, [removedTier]);
  const confirmed = confirmAppleStructuralChanges(first, structuredClone(first), data);
  assert.deepEqual(confirmed.changes.removedTiers, [removedTier]);

  const mismatched = structuredClone(first);
  mismatched.countries[0].plans[data.tiers[0].id].price += 1;
  const mismatchError = assert.throws(
    () => confirmAppleStructuralChanges(first, mismatched, data),
    /not reproduced by the independent confirmation fetch/
  );
  assert.equal(classifyHealthcheckFailure(mismatchError), 'severe');
});

test('performs a no-store second Apple fetch for an ordinary price-only change', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const tierId = changed.tiers[0].id;
  changed.countries[0].plans[tierId].price = 1;
  changed.countries[0].plans[tierId].formattedPrice = '$1.00';
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  let appleRequests = 0;
  delete process.env.EXCHANGE_RATE_API_KEY;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      if (appleRequests === 2) {
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers['cache-control'], 'no-cache');
        assert.equal(options.headers.pragma, 'no-cache');
      }
      return new Response(buildAppleHtml(changed), { status: 200 });
    }
    if (target.includes('open.er-api.com')) {
      return new Response(JSON.stringify(fxPayload), { status: 200 });
    }
    throw new Error(`Unexpected URL in price-only update test: ${target}`);
  };
  try {
    await main({ dryRun: true, stepSummaryPath: null });
    assert.equal(appleRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
  }
});

test('does not perform a second Apple fetch when the semantic snapshot is unchanged', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const result = await runAppleConfirmationScenario({ firstHtml: buildAppleHtml(data) });
  assert.equal(result.appleRequests, 1);
});

test('requires an identical no-store confirmation before establishing the first Apple baseline', async () => {
  const { root, paths } = await createTemporaryBootstrapPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  let appleRequests = 0;
  delete process.env.EXCHANGE_RATE_API_KEY;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      if (appleRequests === 2) {
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers['cache-control'], 'no-cache');
        assert.equal(options.headers.pragma, 'no-cache');
      }
      return new Response(buildAppleHtml(data), { status: 200 });
    }
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in initial-baseline test: ${target}`);
  };
  try {
    await main({ dryRun: true, paths, stepSummaryPath: null });
    assert.equal(appleRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when the two first-baseline Apple responses differ', async () => {
  const { root, paths } = await createTemporaryBootstrapPaths();
  const first = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const second = structuredClone(first);
  const tierId = second.tiers[0].id;
  second.countries[0].plans[tierId].price += 0.01;
  second.countries[0].plans[tierId].formattedPrice = `$${second.countries[0].plans[tierId].price.toFixed(2)}`;
  const originalFetch = globalThis.fetch;
  let appleRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (!target.includes('support.apple.com')) throw new Error(`Unexpected URL before initial confirmation: ${target}`);
    appleRequests += 1;
    return new Response(buildAppleHtml(appleRequests === 1 ? first : second), { status: 200 });
  };
  try {
    await assert.rejects(
      () => main({ dryRun: true, paths, stepSummaryPath: null }),
      (error) => error.code === 'APPLE_CONFIRMATION_MISMATCH'
    );
    assert.equal(appleRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('performs a second Apple fetch when only the published date changes', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data, 'August 12, 2026');
  const result = await runAppleConfirmationScenario({ firstHtml: html, secondHtml: html });
  assert.equal(result.appleRequests, 2);
});

test('publishes price and publication history at Beijing midnight with a previous-day UTC timestamp', async (t) => {
  const fixedNow = new Date('2026-08-15T16:02:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: fixedNow });
  const { root, paths } = await createTemporaryProductionPaths();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = JSON.parse(await readFile(paths.currentDataPath, 'utf8'));
  const changed = structuredClone(previous);
  const changedCountry = changed.countries.find(({ country }) => country === 'Bahamas');
  changedCountry.plans['50GB'] = { ...changedCountry.plans['50GB'], price: 1, formattedPrice: '$1.00' };
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(fixedNow.getTime() / 1_000),
    rates: compatibleExchangeRates(previous)
  };

  await withMockedFetch(
    { html: buildAppleHtml(changed, 'August 12, 2026'), fxPayload },
    () => main({ dryRun: false, paths, stepSummaryPath: null })
  );

  const [prices, history] = await Promise.all([
    readFile(paths.currentDataPath, 'utf8').then(JSON.parse),
    readFile(paths.historyPath, 'utf8').then(JSON.parse)
  ]);
  assert.equal(prices.generatedAt, '2026-08-15T16:02:00.000Z');
  assert.equal(prices.run.observedAtBeijing, '2026-08-16');
  assert.equal(history.updatedAt, prices.generatedAt);
  const priceEvent = history.markets.bs.events.at(-1);
  assert.equal(priceEvent.observedAt, '2026-08-16');
  assert.equal(priceEvent.observedAtBeijing, '2026-08-16');
  assert.equal(priceEvent.observedAtUtc, prices.generatedAt);
  const publicationEvent = history.sourcePublishedDates.at(-1);
  assert.equal(publicationEvent.observedAt, '2026-08-16');
  assert.equal(publicationEvent.observedAtBeijing, '2026-08-16');
  assert.equal(publicationEvent.observedAtUtc, prices.generatedAt);
  assert.doesNotThrow(() => validateHistoryPayload(history));
  assert.doesNotThrow(() => validatePriceHistoryConsistency(prices, history));
});

test('blocks only exact-price rename ambiguity and reports repriced structural candidates', () => {
  const old = {
    country: 'Old Apple Market', marketId: 'old-id', region: 'Asia Pacific', currency: 'USD',
    plans: { '50GB': { price: 1 }, '200GB': { price: 3 } }
  };
  const added = { ...structuredClone(old), country: 'New Apple Market' };
  delete added.marketId;
  const unknownResolver = (sourceName) => ({
    id: `generated-${sourceName}`, sourceName, canonicalName: sourceName, unknown: true
  });
  const requiresReview = (previousCountries, current, candidateCount = 1) => {
    let captured;
    assert.throws(
      () => validateAppleMarketRenameReview({ countries: previousCountries }, current, unknownResolver),
      (error) => {
        captured = error;
        return error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
          && error.message.includes('Old Apple Market')
          && error.message.includes('old-id')
          && error.candidates.length === candidateCount;
      }
    );
    return captured;
  };
  const exactError = requiresReview([old], [added]);
  assert.equal(exactError.candidates[0].pricesMatch, true);
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [added], () => ({ id: 'old-id', unknown: false })
  ).warnings, []);
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [{ ...added, currency: 'EUR' }], unknownResolver
  ).warnings, []);
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [{ ...added, region: 'Europe' }], unknownResolver
  ).warnings, []);
  const changedPrice = structuredClone(added);
  changedPrice.plans['50GB'].price = 2;
  const oneTierResult = validateAppleMarketRenameReview({ countries: [old] }, [changedPrice], unknownResolver);
  assert.equal(oneTierResult.status, 'suspected');
  assert.deepEqual(oneTierResult.warnings, [{
    oldSourceName: 'Old Apple Market',
    newSourceName: 'New Apple Market',
    oldMarketId: 'old-id',
    region: 'Asia Pacific',
    currency: 'USD',
    pricesMatch: false
  }]);
  const allPricesChanged = structuredClone(added);
  for (const plan of Object.values(allPricesChanged.plans)) plan.price += 10;
  assert.equal(
    validateAppleMarketRenameReview({ countries: [old] }, [allPricesChanged], unknownResolver).status,
    'suspected'
  );

  const differentTiers = structuredClone(added);
  delete differentTiers.plans['200GB'];
  assert.deepEqual(validateAppleMarketRenameReview({ countries: [old] }, [differentTiers], unknownResolver).warnings, []);
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [old, added], unknownResolver
  ).warnings, [], 'a genuinely additional unknown has no removed candidate');
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [{ ...added, country: 'old apple market' }],
    () => ({ id: 'old-id', sourceName: 'old apple market', unknown: true, published: true })
  ).warnings, []);
  assert.deepEqual(validateAppleMarketRenameReview(
    { countries: [old] }, [added],
    () => ({ id: 'old-id', sourceName: 'New Apple Market', unknown: false })
  ).warnings, [], 'an explicit registry alias resolves before rename heuristics');

  const secondOld = { ...structuredClone(old), country: 'Another Old Market', marketId: 'another-old-id' };
  const multipleSuspicions = validateAppleMarketRenameReview(
    { countries: [old, secondOld] }, [changedPrice], unknownResolver
  );
  assert.equal(multipleSuspicions.warnings.length, 2);
  assert.equal(new Set(multipleSuspicions.warnings.map(({ oldMarketId }) => oldMarketId)).size, 2);

  const secondRepriced = structuredClone(secondOld);
  secondRepriced.plans['50GB'].price = 2;
  assert.throws(
    () => validateAppleMarketRenameReview({ countries: [old, secondRepriced] }, [added], unknownResolver),
    (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
      && error.candidates.length === 1
      && error.candidates[0].oldMarketId === 'old-id'
  );
  assert.throws(
    () => validateAppleMarketRenameReview({ countries: [old, secondOld] }, [added], unknownResolver),
    (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
      && error.candidates.length === 2
      && new Set(error.candidates.map(({ oldMarketId }) => oldMarketId)).size === 2
  );
});

test('full updater blocks an exact-price rename candidate before FX or production writes', async (t) => {
  const { root, paths } = await createTemporaryProductionPaths();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousText = await readFile(paths.currentDataPath, 'utf8');
  const previous = JSON.parse(previousText);
  const changed = structuredClone(previous);
  const renamed = changed.countries.find(({ country }) => country === 'Bahamas');
  renamed.country = 'Renamed Bahamas Market';
  const html = buildAppleHtml(changed);
  const originalFetch = globalThis.fetch;
  let appleRequests = 0;
  let fxRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      return new Response(html, { status: 200 });
    }
    fxRequests += 1;
    throw new Error(`FX must not be requested before identity review: ${target}`);
  };
  try {
    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
        && error.candidates.some(({ oldMarketId, newSourceName, pricesMatch }) => (
          oldMarketId === 'bs' && newSourceName === 'Renamed Bahamas Market' && pricesMatch === true
        ))
    );
    assert.equal(appleRequests, 2);
    assert.equal(fxRequests, 0);
    assert.equal(await readFile(paths.currentDataPath, 'utf8'), previousText);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('full updater warns but publishes a confirmed rename candidate with repricing', async (t) => {
  const { root, paths } = await createTemporaryProductionPaths();
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousText = await readFile(paths.currentDataPath, 'utf8');
  const previous = JSON.parse(previousText);
  const changed = structuredClone(previous);
  const renamed = changed.countries.find(({ country }) => country === 'Bahamas');
  renamed.country = 'Renamed Bahamas Market';
  renamed.plans['50GB'].price += 1;
  renamed.plans['50GB'].formattedPrice = `$${renamed.plans['50GB'].price.toFixed(2)}`;
  const html = buildAppleHtml(changed);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(previous)
  };
  const summaryPath = path.join(root, 'summary.md');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const warnings = [];
  const logs = [];
  let appleRequests = 0;
  let fxRequests = 0;
  delete process.env.EXCHANGE_RATE_API_KEY;
  process.env.GITHUB_ACTIONS = 'true';
  console.warn = (message) => warnings.push(String(message));
  console.log = (message) => logs.push(String(message));
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      return new Response(html, { status: 200 });
    }
    if (target.includes('open.er-api.com')) {
      fxRequests += 1;
      return new Response(JSON.stringify(fxPayload), { status: 200 });
    }
    throw new Error(`Unexpected URL in rename-suspicion test: ${target}`);
  };
  try {
    await main({ dryRun: false, paths, stepSummaryPath: summaryPath });
    assert.equal(appleRequests, 2);
    assert.equal(fxRequests, 1);
    assert.notEqual(await readFile(paths.currentDataPath, 'utf8'), previousText);
    const published = JSON.parse(await readFile(paths.currentDataPath, 'utf8'));
    assert.ok(published.countries.some(({ country }) => country === 'Renamed Bahamas Market'));
    assert.ok(warnings.some((warning) => warning.includes('MARKET_IDENTITY_RENAME_SUSPECTED')
      && warning.includes('oldMarketId=bs') && warning.includes('pricesMatch=false')));
    assert.ok(logs.some((message) => message.startsWith('::warning title=Apple market identity rename suspected::')
      && message.includes('oldMarketId=bs') && message.includes('pricesMatch=false')));
    assert.match(await readFile(summaryPath, 'utf8'), /MARKET_IDENTITY_RENAME_SUSPECTED.*oldMarketId.*bs.*pricesMatch=false.*自动发布继续/s);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
    if (originalGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
  }
});

test('publishes a confirmed unknown Apple market with a deterministic identity and structured warning', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const unknown = structuredClone(changed.countries[0]);
  unknown.country = 'New Apple Market';
  delete unknown.marketId;
  delete unknown.nameZh;
  changed.countries.push(unknown);
  let appleHtml = buildAppleHtml(changed);
  let fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(changed)
  };
  const summaryPath = path.join(root, 'summary.md');
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const originalLog = console.log;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  const originalGithubActions = process.env.GITHUB_ACTIONS;
  const warnings = [];
  const logs = [];
  let appleRequests = 0;
  delete process.env.EXCHANGE_RATE_API_KEY;
  process.env.GITHUB_ACTIONS = 'true';
  console.warn = (message) => warnings.push(String(message));
  console.log = (message) => logs.push(String(message));
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      if (appleRequests === 2) assert.equal(options.cache, 'no-store');
      return new Response(appleHtml, { status: 200 });
    }
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in unknown-market publication test: ${target}`);
  };
  try {
    await main({ dryRun: false, paths, stepSummaryPath: summaryPath });
    assert.equal(appleRequests, 2);
    const published = JSON.parse(await readFile(paths.currentDataPath, 'utf8'));
    const publishedUnknown = published.countries.find(({ country }) => country === 'New Apple Market');
    assert.match(publishedUnknown.marketId, /^apple-new-apple-market-[0-9a-f]{8}$/);
    assert.equal(publishedUnknown.marketId, resolveMarket('New Apple Market').id);
    assert.ok(warnings.some((warning) => (
      warning.includes(`UNKNOWN_APPLE_MARKET:New Apple Market:${publishedUnknown.marketId}`)
      && warning.includes(unknown.region)
      && warning.includes(unknown.currency)
    )));
    assert.ok(logs.some((message) => (
      message.startsWith('::warning title=Unknown Apple market requires registry review::')
      && message.includes('sourceName=New Apple Market')
      && message.includes(`generatedMarketId=${publishedUnknown.marketId}`)
      && message.includes(`region=${unknown.region}`)
      && message.includes(`currency=${unknown.currency}`)
    )));
    const summary = await readFile(summaryPath, 'utf8');
    assert.match(summary, new RegExp(`UNKNOWN_APPLE_MARKET.*${publishedUnknown.marketId}.*${unknown.region}.*${unknown.currency}`, 's'));
    assert.match(summary, new RegExp(`CHINESE_MARKET_NAME_PENDING.*${publishedUnknown.marketId}.*New Apple Market`, 's'));
    assert.ok(warnings.some((warning) => warning.includes(`CHINESE_MARKET_NAME_PENDING:marketId=${publishedUnknown.marketId}:sourceName=New Apple Market`)));
    assert.ok(logs.some((message) => message.startsWith('::warning title=Apple Chinese market name pending::')
      && message.includes(`marketId=${publishedUnknown.marketId}`)
      && message.includes('sourceName=New Apple Market')));

    const caseChanged = structuredClone(changed);
    const caseChangedUnknown = caseChanged.countries.at(-1);
    caseChangedUnknown.country = 'new apple market';
    const changedTier = caseChanged.tiers[0].id;
    caseChangedUnknown.plans[changedTier].price += 0.01;
    caseChangedUnknown.plans[changedTier].formattedPrice = `$${caseChangedUnknown.plans[changedTier].price.toFixed(2)}`;
    appleHtml = buildAppleHtml(caseChanged);
    fxPayload = {
      ...fxPayload,
      time_last_update_unix: recentFxTimestamp()
    };
    appleRequests = 0;
    await main({ dryRun: false, paths, stepSummaryPath: summaryPath });
    assert.equal(appleRequests, 2);
    const republished = JSON.parse(await readFile(paths.currentDataPath, 'utf8'));
    const caseOnlyUnknown = republished.countries.find(({ country }) => country === 'new apple market');
    assert.equal(caseOnlyUnknown.marketId, publishedUnknown.marketId);
    assert.notEqual(caseOnlyUnknown.marketId, resolveMarket('new apple market').id);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
    if (originalGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalGithubActions;
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when an unknown Apple market changes during confirmation', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const first = structuredClone(data);
  const unknown = structuredClone(first.countries[0]);
  unknown.country = 'New Apple Market';
  delete unknown.marketId;
  delete unknown.nameZh;
  first.countries.push(unknown);
  const second = structuredClone(first);
  const tierId = second.tiers[0].id;
  second.countries.at(-1).plans[tierId].price += 0.01;
  second.countries.at(-1).plans[tierId].formattedPrice = `$${second.countries.at(-1).plans[tierId].price.toFixed(2)}`;
  await assert.rejects(
    () => runAppleConfirmationScenario({ firstHtml: buildAppleHtml(first), secondHtml: buildAppleHtml(second) }),
    (error) => error.code === 'APPLE_CONFIRMATION_MISMATCH'
  );
});

test('accepts different confirmation markup when canonical Apple semantics are identical', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const tierId = changed.tiers[0].id;
  changed.countries[0].plans[tierId].price += 0.01;
  changed.countries[0].plans[tierId].formattedPrice = `$${changed.countries[0].plans[tierId].price.toFixed(2)}`;
  const firstHtml = buildAppleHtml(changed);
  const secondHtml = firstHtml.replace('<body>', '<body><div data-unrelated="true"></div>');
  assert.notEqual(firstHtml, secondHtml);
  const result = await runAppleConfirmationScenario({ firstHtml, secondHtml });
  assert.equal(result.appleRequests, 2);
});

test('fails closed with APPLE_CONFIRMATION_MISMATCH when the two semantic snapshots differ', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const first = structuredClone(data);
  const second = structuredClone(data);
  const tierId = data.tiers[0].id;
  first.countries[0].plans[tierId].price += 0.01;
  second.countries[0].plans[tierId].price += 0.02;
  first.countries[0].plans[tierId].formattedPrice = `$${first.countries[0].plans[tierId].price.toFixed(2)}`;
  second.countries[0].plans[tierId].formattedPrice = `$${second.countries[0].plans[tierId].price.toFixed(2)}`;
  assert.throws(
    () => confirmAppleSemanticChange({ ...first, sourcePublishedDate: first.source.publishedDate, parser: 'cross-checked' }, { ...second, sourcePublishedDate: second.source.publishedDate, parser: 'cross-checked' }, data),
    (error) => {
      assert.equal(error.code, 'APPLE_CONFIRMATION_MISMATCH');
      assert.match(error.message, /not reproduced/);
      return true;
    }
  );
});

test('preserves prices and history when independent Apple price confirmation differs', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const first = structuredClone(data);
  const second = structuredClone(data);
  const tierId = data.tiers[0].id;
  first.countries[0].plans[tierId].price += 0.01;
  second.countries[0].plans[tierId].price += 0.02;
  first.countries[0].plans[tierId].formattedPrice = `$${first.countries[0].plans[tierId].price.toFixed(2)}`;
  second.countries[0].plans[tierId].formattedPrice = `$${second.countries[0].plans[tierId].price.toFixed(2)}`;
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const originalFetch = globalThis.fetch;
  let appleRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (!target.includes('support.apple.com')) throw new Error(`Unexpected URL before confirmation completed: ${target}`);
    appleRequests += 1;
    return new Response(buildAppleHtml(appleRequests === 1 ? first : second), { status: 200 });
  };
  try {
    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      (error) => error.code === 'APPLE_CONFIRMATION_MISMATCH'
    );
    assert.equal(appleRequests, 2);
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed before FX when the second Apple parse loses parser redundancy', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const tierId = changed.tiers[0].id;
  changed.countries[0].plans[tierId].price += 0.01;
  changed.countries[0].plans[tierId].formattedPrice = `$${changed.countries[0].plans[tierId].price.toFixed(2)}`;
  const firstHtml = buildAppleHtml(changed);
  const secondHtml = firstHtml.replace(
    '<h3 id="emea">',
    '<h5>Decoy Market (USD)</h5><ul>' + changed.tiers.map((tier) => `<li>${tier.label}: $1.00</li>`).join('') + '</ul><h3 id="emea">'
  );
  await assert.rejects(
    () => runAppleConfirmationScenario({ firstHtml, secondHtml }),
    (error) => {
      assert.equal(error.code, 'APPLE_CONFIRMATION_MISMATCH');
      assert.match(error.cause?.message ?? '', /Apple parser disagreement/);
      return true;
    }
  );
});

test('classifies an unavailable semantic confirmation as transient and preserves stable production data', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  changed.countries = changed.countries.slice(1);
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  const originalFetch = globalThis.fetch;
  let appleRequests = 0;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (!target.includes('support.apple.com')) {
      throw new Error(`Unexpected URL before Apple confirmation completed: ${target}`);
    }
    appleRequests += 1;
    if (appleRequests === 1) return new Response(buildAppleHtml(changed), { status: 200 });
    throw new Error('simulated connection reset during independent confirmation');
  };
  const networkBudget = createNetworkBudget({
    budgetMs: 5 * 60 * 1_000,
    now: () => 0,
    sleep: async () => {},
    createTimeoutSignal: () => undefined
  });
  try {
    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null, networkBudget }),
      (error) => {
        assert.equal(error.code, 'APPLE_CONFIRMATION_UNAVAILABLE');
        assert.equal(error.cause?.code, 'NETWORK_FETCH_FAILED');
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        assert.match(error.message, /stable data was preserved.*next run must retry/i);
        return true;
      }
    );
    assert.equal(appleRequests, 6, 'one primary fetch plus the full five-attempt confirmation retry sequence');
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed without production writes when semantic confirmation returns HTTP 500 or times out', async (t) => {
  for (const scenario of [
    { name: 'HTTP 500', respond: () => new Response('server error', { status: 500 }) },
    { name: 'timeout', respond: () => { throw new DOMException('simulated timeout', 'TimeoutError'); } }
  ]) {
    await t.test(scenario.name, async () => {
      const { root, paths } = await createTemporaryProductionPaths();
      const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
      const changed = structuredClone(data);
      changed.countries = changed.countries.slice(1);
      const before = await Promise.all([
        readFile(paths.currentDataPath, 'utf8'),
        readFile(paths.historyPath, 'utf8'),
        readFile(paths.runLogPath, 'utf8')
      ]);
      const snapshotStoreBefore = await readSnapshotStoreState(paths);
      const originalFetch = globalThis.fetch;
      let appleRequests = 0;
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (!target.includes('support.apple.com')) throw new Error(`Unexpected URL before confirmation completed: ${target}`);
        appleRequests += 1;
        return appleRequests === 1 ? new Response(buildAppleHtml(changed), { status: 200 }) : scenario.respond();
      };
      const networkBudget = createNetworkBudget({
        budgetMs: 5 * 60 * 1_000,
        now: () => 0,
        sleep: async () => {},
        createTimeoutSignal: () => undefined
      });
      try {
        await assert.rejects(
          () => main({ dryRun: false, paths, stepSummaryPath: null, networkBudget }),
          (error) => error.code === 'APPLE_CONFIRMATION_UNAVAILABLE'
        );
        assert.equal(appleRequests, 6);
        assert.deepEqual(await Promise.all([
          readFile(paths.currentDataPath, 'utf8'),
          readFile(paths.historyPath, 'utf8'),
          readFile(paths.runLogPath, 'utf8')
        ]), before);
        assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
      } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('ignores residual claims that are not bound to the current lock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-residual-claim-'));
  const lockPath = path.join(root, '.icloud-price-update.lock');
  const oldLockContents = `${JSON.stringify({ pid: 999_999_999, token: 'old-lock' })}\n`;
  const claimPath = `${lockPath}.claim-residual`;
  try {
    await writeFile(claimPath, JSON.stringify({
      pid: process.pid,
      expectedContents: oldLockContents,
      token: 'residual-claim'
    }), 'utf8');

    const releaseWithoutLock = await acquireUpdateLock(lockPath, { staleAfterMs: 60_000 });
    await releaseWithoutLock();

    const replacementLockContents = `${JSON.stringify({ pid: 999_999_998, token: 'replacement-lock' })}\n`;
    await writeFile(lockPath, replacementLockContents, 'utf8');
    const releaseReplacement = await acquireUpdateLock(lockPath, { staleAfterMs: 60_000 });
    await releaseReplacement();
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
    rates: compatibleExchangeRates(data)
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
    const activeSnapshot = JSON.parse(await readFile(path.join(snapshotsDir, index.snapshots[0].activeDataFile), 'utf8'));
    assert.equal(activeSnapshot.countries[0].plans['50GB'], 2);
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
const snapshotIndexUrl = new URL('../data/apple-snapshots/index.json', import.meta.url);

function recentFxTimestamp() {
  return Math.floor(Date.now() / 1000);
}

function compatibleExchangeRates(data) {
  const rateBoundsFor = (currency, cnyRate) => {
    let lower = 0;
    let upper = Number.POSITIVE_INFINITY;
    for (const country of data.countries.filter((entry) => entry.currency === currency)) {
      for (const plan of Object.values(country.plans)) {
        assert.ok(Number.isFinite(plan.cnyPrice) && plan.cnyPrice > 0, `${country.country} must expose cnyPrice`);
        lower = Math.max(lower, (plan.price * cnyRate) / (plan.cnyPrice + 0.005));
        upper = Math.min(upper, (plan.price * cnyRate) / (plan.cnyPrice - 0.005));
      }
    }
    assert.ok(lower < upper, `public CNY values must define a compatible ${currency} rate`);
    return (lower + upper) / 2;
  };

  let cnyLower = 0;
  let cnyUpper = Number.POSITIVE_INFINITY;
  for (const country of data.countries.filter((entry) => entry.currency === 'USD')) {
    for (const plan of Object.values(country.plans)) {
      cnyLower = Math.max(cnyLower, (plan.cnyPrice - 0.005) / plan.price);
      cnyUpper = Math.min(cnyUpper, (plan.cnyPrice + 0.005) / plan.price);
    }
  }
  assert.ok(cnyLower < cnyUpper, 'public CNY values must define a compatible USD/CNY rate');
  const cnyRate = (cnyLower + cnyUpper) / 2;
  const rates = { USD: 1, CNY: cnyRate };
  for (const currency of [...new Set(data.countries.map(({ currency }) => currency))].sort()) {
    if (currency === 'USD' || currency === 'CNY') continue;
    rates[currency] = rateBoundsFor(currency, cnyRate);
  }

  for (const country of data.countries) {
    for (const plan of Object.values(country.plans)) {
      const derived = Number(((plan.price / rates[country.currency]) * rates.CNY).toFixed(2));
      assert.equal(derived, plan.cnyPrice, `${country.country} fixture rate must reproduce committed CNY values`);
    }
  }
  return rates;
}

function legacySchema2Fixture(data) {
  const legacy = structuredClone(data);
  legacy.schemaVersion = 2;
  delete legacy.fx.derivedCurrency;
  legacy.fx.apiKeyStatus = 'valid';
  legacy.fx.rates = compatibleExchangeRates(data);
  for (const country of legacy.countries) {
    for (const plan of Object.values(country.plans)) delete plan.cnyPrice;
  }
  return legacy;
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

function fxSanityFixture({
  currency = 'JPY',
  points = MIN_FX_SANITY_POINTS,
  generatedAt = '2026-08-10T00:00:00.000Z'
} = {}) {
  return {
    generatedAt,
    countries: [{
      country: 'Alpha',
      currency,
      plans: Object.fromEntries(Array.from({ length: points }, (_, index) => {
        const price = (index + 1) * 100;
        return [`T${index + 1}`, { price, cnyPrice: price * 0.1 }];
      }))
    }]
  };
}

function fxForCnyPerCurrency(currency, rate) {
  return { rates: { USD: 1, CNY: 1, [currency]: 1 / rate } };
}

test('FX sanity enforces the 12% dailyized symmetric threshold', () => {
  const previousData = fxSanityFixture();
  const now = new Date('2026-08-11T00:00:00.000Z');
  for (const currentRate of [0.105, 0.1 / 1.05, 0.1 * 1.119]) {
    const result = validateFxSanity(previousData, fxForCnyPerCurrency('JPY', currentRate), { now });
    assert.equal(result.status, 'passed');
  }
  for (const currentRate of [0.1 * 1.121, 0.1 / 1.121]) {
    assert.throws(
      () => validateFxSanity(previousData, fxForCnyPerCurrency('JPY', currentRate), { now }),
      (error) => error.code === 'FX_SANITY_FAILURE'
    );
  }
  assert.equal(FX_SANITY_MAX_DAILY_CHANGE, 0.12);
});

test('FX sanity dailyizes multi-day changes and skips unusable baselines explicitly', () => {
  const previousData = fxSanityFixture();
  const threeDay = validateFxSanity(
    previousData,
    fxForCnyPerCurrency('JPY', 0.12),
    { now: new Date('2026-08-13T00:00:00.000Z') }
  );
  assert.equal(threeDay.status, 'passed');
  assert.ok(threeDay.checks.find(({ currency }) => currency === 'JPY').dailyizedChange < 0.12);

  const oldBaseline = validateFxSanity(
    previousData,
    fxForCnyPerCurrency('JPY', 1),
    { now: new Date('2026-08-18T00:00:00.001Z') }
  );
  assert.deepEqual(oldBaseline.warnings, ['FX_SANITY_SKIPPED_OLD_BASELINE']);

  const insufficient = validateFxSanity(
    fxSanityFixture({ points: 2 }),
    fxForCnyPerCurrency('JPY', 0.1),
    { now: new Date('2026-08-11T00:00:00.000Z') }
  );
  assert.ok(insufficient.warnings.includes('FX_SANITY_SKIPPED_INSUFFICIENT_POINTS:JPY:2'));

  const cny = validateFxSanity(
    fxSanityFixture({ currency: 'CNY' }),
    { rates: { USD: 1, CNY: 1 } },
    { now: new Date('2026-08-11T00:00:00.000Z') }
  );
  assert.equal(cny.checks.find(({ currency }) => currency === 'CNY').status, 'skipped-cny');
});

test('FX sanity uses the previous FX timestamp when stale rates later become fresh', () => {
  const previousData = fxSanityFixture({ generatedAt: '2026-08-11T00:00:00.000Z' });
  previousData.fx = { fetchedAt: '2026-08-10T00:00:00.000Z', stale: true };
  const result = validateFxSanity(
    previousData,
    fxForCnyPerCurrency('JPY', 0.115),
    { now: new Date('2026-08-12T00:00:00.000Z') }
  );
  const check = result.checks.find(({ currency }) => currency === 'JPY');
  assert.equal(result.status, 'passed');
  assert.equal(check.days, 2);
  assert.ok(check.dailyizedChange < 0.12);
});

test('FX sanity checks only active currencies with a previous baseline', () => {
  const previousData = fxSanityFixture({ currency: 'XYZ' });
  const now = new Date('2026-08-11T00:00:00.000Z');
  const removed = validateFxSanity(previousData, { rates: { USD: 1, CNY: 1 } }, {
    now,
    currentCurrencies: ['CNY']
  });
  assert.equal(removed.status, 'passed');
  assert.ok(removed.warnings.includes('FX_SANITY_SKIPPED_REMOVED_CURRENCY:XYZ'));

  const added = validateFxSanity(previousData, { rates: { USD: 1, CNY: 1, ABC: 2 } }, {
    now,
    currentCurrencies: ['ABC']
  });
  assert.equal(added.checks.find(({ currency }) => currency === 'ABC').status, 'skipped-new-currency');

  assert.throws(
    () => validateFxSanity(previousData, { rates: { USD: 1, CNY: 1 } }, {
      now,
      currentCurrencies: ['XYZ']
    }),
    (error) => error.code === 'FX_SANITY_FAILURE'
  );

  const cny = validateFxSanity(previousData, { rates: { USD: 1, CNY: 1 } }, {
    now,
    currentCurrencies: ['CNY']
  });
  assert.equal(cny.checks.find(({ currency }) => currency === 'CNY').status, 'skipped-cny');
});

test('derives rounded plan-level CNY prices without publishing source rates', () => {
  const countries = [
    {
      country: 'Alpha',
      region: 'Americas',
      currency: 'USD',
      plans: { '50GB': { price: 1.99, formattedPrice: '$1.99' } }
    },
    {
      country: 'Beta',
      region: 'Asia Pacific',
      currency: 'JPY',
      plans: { '50GB': { price: 150, formattedPrice: '?150' } }
    }
  ];
  const derived = attachDerivedCnyPrices(countries, {
    fx: { rates: { USD: 1, CNY: 7.2, JPY: 150 }, reusePreviousCny: false }
  });

  assert.equal(derived[0].plans['50GB'].cnyPrice, 14.33);
  assert.equal(derived[1].plans['50GB'].cnyPrice, 7.2);
  assert.equal(derived[1].plans['50GB'].cnyRank, 1);
  assert.equal(derived[0].plans['50GB'].cnyRank, 2);
  assert.equal(Object.hasOwn(derived[0].plans['50GB'], 'sourceRate'), false);
  assert.equal(Object.hasOwn(derived[0].plans['50GB'], 'fullPrecisionCnyPrice'), false);
});

test('ranks with full precision and uses dense ranks only for true ties', () => {
  const countries = [
    { marketId: 'a', country: 'Alpha', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 1, formattedPrice: '$1.00' } } },
    { marketId: 'b', country: 'Beta', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 1.00005, formattedPrice: '$1.00005' } } },
    { marketId: 'c', country: 'Gamma', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 1, formattedPrice: '$1.00' } } }
  ];
  const derived = attachDerivedCnyPrices(countries, {
    fx: { rates: { USD: 1, CNY: 7.0637 }, reusePreviousCny: false }
  });
  assert.deepEqual(derived.map((country) => country.plans['50GB'].cnyPrice), [7.06, 7.06, 7.06]);
  assert.deepEqual(derived.map((country) => country.plans['50GB'].cnyRank), [1, 2, 1]);
});

test('reuses schema 4 CNY prices and ranks without reranking rounded ties', () => {
  const previousData = {
    schemaVersion: 4,
    countries: [
      { marketId: 'a', country: 'Alpha', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 0.99, formattedPrice: '$0.99', cnyPrice: 7.06, cnyRank: 1 } } },
      { marketId: 'b', country: 'Beta', region: 'Americas', currency: 'USD', plans: { '50GB': { price: 1, formattedPrice: '$1.00', cnyPrice: 7.06, cnyRank: 2 } } }
    ]
  };
  const staleFx = { rates: null, reusePreviousCny: true };
  const unchanged = previousData.countries.map(({ plans, ...country }) => ({
    ...country,
    plans: Object.fromEntries(Object.entries(plans).map(([tierId, plan]) => [tierId, {
      price: plan.price,
      formattedPrice: plan.formattedPrice
    }]))
  }));
  const reused = attachDerivedCnyPrices(unchanged, { fx: staleFx, previousData });
  assert.deepEqual(reused.map((country) => country.plans['50GB'].cnyPrice), [7.06, 7.06]);
  assert.deepEqual(reused.map((country) => country.plans['50GB'].cnyRank), [1, 2]);

  const invalidChanges = [
    [{ ...unchanged[0], plans: { '50GB': { price: 1.09, formattedPrice: '$1.09' } } }],
    [{ ...unchanged[0], currency: 'CAD' }],
    [{ ...unchanged[0], marketId: 'missing' }],
    [{ ...unchanged[0], plans: { ...unchanged[0].plans, '200GB': { price: 2.99, formattedPrice: '$2.99' } } }]
  ];
  for (const countries of invalidChanges) {
    assert.throws(
      () => attachDerivedCnyPrices(countries, { fx: staleFx, previousData }),
      /Cannot reuse .*CNY price/
    );
  }

  for (const invalidRank of [undefined, 0, 1.5, Number.NaN, 3]) {
    const invalidPrevious = structuredClone(previousData);
    invalidPrevious.countries[0].plans['50GB'].cnyRank = invalidRank;
    assert.throws(
      () => attachDerivedCnyPrices([unchanged[0]], { fx: staleFx, previousData: invalidPrevious }),
      /Cannot reuse .* CNY price and rank/
    );
  }
});

test('publishes an explicit FX metadata allowlist and drops every internal field', () => {
  const metadata = publicExchangeRateMetadata({
    sourceUrl: 'https://example.test/rates',
    sourceMode: 'open-access',
    fallbackUsed: true,
    fallbackReason: 'request-failed',
    base: 'USD',
    fetchedAt: '2026-08-09T00:00:00.000Z',
    stale: true,
    rates: { USD: 1, CNY: 7.2 },
    apiKeyStatus: 'request-failed',
    reusePreviousCny: true,
    futureInternalField: 'must-not-leak'
  });

  assert.deepEqual(metadata, {
    sourceUrl: 'https://example.test/rates',
    sourceMode: 'open-access',
    fallbackUsed: true,
    fallbackReason: 'request-failed',
    base: 'USD',
    fetchedAt: '2026-08-09T00:00:00.000Z',
    stale: true,
    derivedCurrency: 'CNY'
  });
  assert.equal(publicExchangeRateMetadata({
    ...metadata,
    fallbackReason: 'invalid-key'
  }).fallbackReason, 'source-unavailable');
});

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

async function runAppleConfirmationScenario({ firstHtml, secondHtml = firstHtml }) {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.EXCHANGE_RATE_API_KEY;
  let appleRequests = 0;
  delete process.env.EXCHANGE_RATE_API_KEY;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      appleRequests += 1;
      if (appleRequests === 1) return new Response(firstHtml, { status: 200 });
      return new Response(secondHtml, { status: 200 });
    }
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in Apple confirmation scenario: ${target}`);
  };
  const networkBudget = createNetworkBudget({
    budgetMs: 5 * 60 * 1_000,
    now: () => 0,
    sleep: async () => {},
    createTimeoutSignal: () => undefined
  });
  try {
    await main({ dryRun: true, stepSummaryPath: null, networkBudget });
    return { appleRequests };
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = originalApiKey;
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

async function assertRejectsBeforeFetch(callback, expected) {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('preflight must run before network fetches');
  };
  try {
    await assert.rejects(callback, expected);
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function createTemporaryProductionPaths({ copySnapshots = true } = {}) {
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
  if (copySnapshots) await copyCommittedSnapshotStore(paths);
  return { root, paths };
}

async function createTemporaryBootstrapPaths() {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-bootstrap-'));
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
  await copyFile(namesUrl, paths.namesPath);
  return { root, paths };
}

test('production preflight rejects a market identity re-key before any network request', async (t) => {
  const { root, paths } = await createTemporaryProductionPaths();
  t.after(() => rm(root, { recursive: true, force: true }));
  const [prices, history] = await Promise.all([
    readFile(paths.currentDataPath, 'utf8').then(JSON.parse),
    readFile(paths.historyPath, 'utf8').then(JSON.parse)
  ]);
  const japan = prices.countries.find(({ marketId }) => marketId === 'jp');
  japan.country = 'Japan Legacy';
  history.markets.jp.country = 'Japan Legacy';
  await Promise.all([
    writeFile(paths.currentDataPath, `${JSON.stringify(prices, null, 2)}\n`, 'utf8'),
    writeFile(paths.historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  ]);
  await assertRejectsBeforeFetch(
    () => main({ dryRun: true, paths, stepSummaryPath: null }),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );
});

async function copyCommittedSnapshotStore(paths) {
  const index = JSON.parse(await readFile(snapshotIndexUrl, 'utf8'));
  await mkdir(paths.snapshotsDir, { recursive: true });
  await Promise.all([
    copyFile(snapshotIndexUrl, paths.snapshotIndexPath),
    ...index.snapshots.flatMap(({ revisions }) => revisions.map(({ dataFile }) => (
      copyFile(new URL(`../data/apple-snapshots/${dataFile}`, import.meta.url), path.join(paths.snapshotsDir, dataFile))
    )))
  ]);
  return index;
}

async function readSnapshotStoreState(paths) {
  return {
    index: await readFile(paths.snapshotIndexPath, 'utf8'),
    files: (await readdir(paths.snapshotsDir)).sort()
  };
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
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
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
    assert.ok(snapshot, 'production run must retain the current Apple snapshot');
    assert.equal(snapshot.revisions.length, 1);
    assert.equal(
      snapshot.revisions[0].firstConfirmedDate,
      JSON.parse(snapshotStoreBefore.index).snapshots.at(-1).revisions[0].firstConfirmedDate
    );
    assert.equal(writtenData.schemaVersion, 4);
    assert.equal(writtenData.source.publishedDate, data.source.publishedDate);
    assert.equal(writtenData.countries.length, data.countries.length);
    assert.equal(writtenData.fx.derivedCurrency, 'CNY');
    assert.equal(Object.hasOwn(writtenData.fx, 'rates'), false);
    assert.equal(Object.hasOwn(writtenData.fx, 'apiKeyStatus'), false);
    assert.equal(
      writtenData.countries.every((country) => Object.values(country.plans).every(
        (plan) => Number.isFinite(plan.cnyPrice) && plan.cnyPrice > 0
      )),
      true
    );
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
    await assert.rejects(readFile(summaryPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    await rm(root, { recursive: true, force: true });
  }
});

test('does not rewrite history when an observation has no historical changes', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const history = JSON.parse(await readFile(paths.historyPath, 'utf8'));
  for (const [marketId, sourceName] of [['mu', 'Mauritius'], ['cg', 'Republic of Congo']]) {
    data.countries.find((country) => country.marketId === marketId).nameZh = sourceName;
    history.markets[marketId].nameZh = sourceName;
  }
  await Promise.all([
    writeFile(paths.currentDataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8'),
    writeFile(paths.historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  ]);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const historyBefore = await readFile(paths.historyPath, 'utf8');
  const writtenPaths = [];
  const trackWrites = async (filePath, value) => {
    writtenPaths.push(filePath);
    await writeJsonAtomic(filePath, value);
  };
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => main({ dryRun: false, paths, stepSummaryPath: null, writeJson: trackWrites })
    );
    assert.equal(writtenPaths.includes(paths.currentDataPath), true);
    assert.equal(writtenPaths.includes(paths.runLogPath), true);
    assert.equal(writtenPaths.includes(paths.historyPath), false);
    assert.equal(await readFile(paths.historyPath, 'utf8'), historyBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('FX sanity failure preserves every production data file', async (t) => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  t.mock.timers.enable({ apis: ['Date'], now: new Date(Date.parse(data.generatedAt) + 24 * 60 * 60 * 1_000) });
  const rates = compatibleExchangeRates(data);
  rates.JPY /= 2;
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        (error) => error.code === 'FX_SANITY_FAILURE'
      )
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('preserves a pre-existing unindexed snapshot file when a production collision occurs', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const changedCountry = changed.countries.find(({ country: countryName }) => countryName === 'Bahamas');
  changedCountry.plans['50GB'] = { price: 1.09, formattedPrice: '$1.09' };
  const html = buildAppleHtml(changed);
  const contentHash = appleSnapshotContentHash(changed);
  const publishedDate = publicationDateKey(changed.source.publishedDate);
  const collisionPath = path.join(paths.snapshotsDir, `${publishedDate}-${contentHash.slice(0, 12)}.json`);
  const transactionPath = defaultUpdateTransactionPath(paths.currentDataPath);
  const sentinel = '{"preExisting":true}\n';
  const productionPaths = [paths.currentDataPath, paths.historyPath, paths.runLogPath];
  const productionBefore = await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8')));
  const snapshotIndexBefore = await readFile(paths.snapshotIndexPath, 'utf8');
  const originalFetch = globalThis.fetch;
  let collisionCreated = false;
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };

  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) {
      await writeFile(collisionPath, sentinel, 'utf8');
      collisionCreated = true;
      return new Response(html, { status: 200 });
    }
    if (target.includes('v6.exchangerate-api.com') || target.includes('open.er-api.com')) {
      return new Response(JSON.stringify(fxPayload), { status: 200 });
    }
    throw new Error(`Unexpected URL in collision test: ${target}`);
  };

  try {
    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      { code: 'EEXIST' }
    );
    assert.equal(collisionCreated, true);
    assert.equal(await readFile(collisionPath, 'utf8'), sentinel);
    assert.deepEqual(
      await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8'))),
      productionBefore
    );
    assert.equal(await readFile(paths.snapshotIndexPath, 'utf8'), snapshotIndexBefore);
    await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('removes unambiguous updater temporary files before a production run', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
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
    rates: compatibleExchangeRates(data)
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
    rates: compatibleExchangeRates(data)
  };
  await withMockedFetch(
    { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
    () => assert.rejects(
      main({ dryRun: true }),
      /Apple published date is in the future/
    )
  );

  const { root, paths } = await createTemporaryProductionPaths();
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /Apple published date is in the future/
      )
    );
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
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
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
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
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
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
    rates: compatibleExchangeRates(data)
  };
  await mkdir(paths.snapshotsDir, { recursive: true });
  await writeFile(paths.runLogPath, JSON.stringify({ schemaVersion: 1, retention: 90, runs: {} }), 'utf8');
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /run-log\.json has an unsupported structure/i
      )
    );
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recreates a missing run log after a valid production update', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  await rm(paths.runLogPath);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload },
      () => main({ dryRun: false, paths, stepSummaryPath: null })
    );
    const [writtenData, runLog] = await Promise.all([
      readFile(paths.currentDataPath, 'utf8').then(JSON.parse),
      readFile(paths.runLogPath, 'utf8').then(JSON.parse)
    ]);
    assert.equal(runLog.schemaVersion, 1);
    assert.equal(runLog.retention, 90);
    assert.equal(runLog.runs.length, 1);
    assert.equal(runLog.runs[0].status, 'success');
    assert.equal(runLog.runs[0].finishedAtUtc, writtenData.generatedAt);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a partial production baseline before any write', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  await rm(paths.currentDataPath);
  await rm(paths.historyPath);
  const runLogBefore = await readFile(paths.runLogPath, 'utf8');
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  let writes = 0;
  const countWrites = async (filePath, value) => {
    writes += 1;
    await writeJsonAtomic(filePath, value);
  };
  try {
    await assertRejectsBeforeFetch(
      () => main({ dryRun: false, paths, stepSummaryPath: null, writeJson: countWrites }),
      /Production data state is partial; missing: prices\.json, history\.json/
    );
    assert.equal(writes, 0);
    await assert.rejects(readFile(paths.currentDataPath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(paths.historyPath, 'utf8'), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(paths.runLogPath, 'utf8')), JSON.parse(runLogBefore));
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects an existing production baseline when the snapshot store is missing', async () => {
  const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  try {
    await assertRejectsBeforeFetch(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      /Apple snapshot store is missing for the existing production baseline/i
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    await assert.rejects(readFile(paths.snapshotIndexPath, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rolls back prices, history, logs, and snapshots when a production write fails midway', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const snapshotIndexText = await readFile(paths.snapshotIndexPath, 'utf8');
  await Promise.all([
    paths.currentDataPath,
    paths.historyPath,
    paths.runLogPath,
    paths.snapshotIndexPath
  ].map(async (filePath) => {
    const text = filePath === paths.snapshotIndexPath
      ? snapshotIndexText
      : await readFile(filePath, 'utf8');
    await writeFile(filePath, text.replace(/\r?\n/g, '\r\n'), 'utf8');
  }));
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const changed = structuredClone(data);
  const changedCountry = changed.countries.find(({ currency }) => currency === 'USD');
  const changedTier = changed.tiers[0].id;
  changedCountry.plans[changedTier].price += 0.1;
  changedCountry.plans[changedTier].formattedPrice = `$${changedCountry.plans[changedTier].price.toFixed(2)}`;
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  let writes = 0;
  const failSecondWrite = async (filePath, value) => {
    writes += 1;
    if (writes === 2) throw new Error('simulated history write failure');
    await writeJsonAtomic(filePath, value);
  };

  try {
    await withMockedFetch(
      { html: buildAppleHtml(changed), fxPayload },
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
    assert.deepEqual(after, before, 'rollback must restore the original bytes, including CRLF line endings');
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cleans up only created snapshot files when index writing fails', async () => {
  const snapshotsDir = await mkdtemp(path.join(tmpdir(), 'icloud-snapshot-failure-'));
  const indexPath = path.join(snapshotsDir, 'blocked-index');
  const unrelatedTemporaryPath = `${indexPath}.tmp`;
  const base = {
    sourcePublishedDate: 'Published Date: April 06, 2026',
    parser: 'cross-checked',
    tiers: [TIER_50],
    countries: [country('Alpha', { prices: { '50GB': 1 } })]
  };
  try {
    await mkdir(indexPath);
    await writeFile(unrelatedTemporaryPath, 'preserved temporary file', 'utf8');
    await assert.rejects(
      savePublishedAppleSnapshot('<html>failed</html>', base, '2026-08-02', {
        snapshotsDir,
        indexPath
      })
    );
    assert.equal(await readFile(unrelatedTemporaryPath, 'utf8'), 'preserved temporary file');
    assert.deepEqual((await readdir(snapshotsDir)).sort(), ['blocked-index', 'blocked-index.tmp']);
  } finally {
    await rm(snapshotsDir, { recursive: true, force: true });
  }
});

test('preserves pre-existing snapshot evidence when exclusive creation fails', async () => {
  const snapshotsDir = await mkdtemp(path.join(tmpdir(), 'icloud-snapshot-collision-'));
  const indexPath = path.join(snapshotsDir, 'index.json');
  const snapshotPath = path.join(snapshotsDir, '2026-04-06.json');
  const preserved = '{"preserved":true}';
  const parsed = {
    sourcePublishedDate: 'Published Date: April 06, 2026',
    parser: 'cross-checked',
    tiers: [TIER_50],
    countries: [country('Alpha', { prices: { '50GB': 1 } })]
  };
  try {
    await writeFile(snapshotPath, preserved, 'utf8');
    await assert.rejects(
      savePublishedAppleSnapshot('<html>new evidence</html>', parsed, '2026-08-02', {
        snapshotsDir,
        indexPath
      }),
      { code: 'EEXIST' }
    );
    assert.equal(await readFile(snapshotPath, 'utf8'), preserved);
    assert.deepEqual(await readdir(snapshotsDir), ['2026-04-06.json']);
  } finally {
    await rm(snapshotsDir, { recursive: true, force: true });
  }
});

test('writes a failure report and normalized Apple diagnostic', async () => {
  const diagnosticsDir = await mkdtemp(path.join(tmpdir(), 'icloud-diagnostics-'));
  const summaryPath = path.join(diagnosticsDir, 'summary.md');
  const startedAt = new Date('2026-08-02T15:00:00.000Z');
  const finishedAt = new Date('2026-08-02T15:00:02.500Z');
  const secret = 'diagnostic-secret-key';
  const previousSecret = process.env.EXCHANGE_RATE_API_KEY;
  process.env.EXCHANGE_RATE_API_KEY = secret;
  const failureMessage = `snapshot [click](https://evil.example)\n::warning title=injected::\u202e# injected <img src=x onerror=alert(1)> failed ${secret} ${'x'.repeat(1_500)}`;
  try {
    const report = await writeFailureDiagnostics(new Error(failureMessage), {
      diagnosticsDir,
      appleSnapshot: { schemaVersion: 1, publishedDate: '2026-07-17', tiers: [], countries: [] },
      startedAt,
      finishedAt,
      stepSummaryPath: summaryPath
    });
    const files = await readdir(diagnosticsDir);
    assert.deepEqual(files.sort(), ['apple-snapshot.json', 'run-report.json', 'summary.md']);
    assert.equal(report.status, 'failure');
    assert.equal(report.healthcheckSeverity, 'severe');
    assert.equal(report.appleSnapshotCaptured, true);
    const storedMessage = JSON.parse(await readFile(path.join(diagnosticsDir, 'run-report.json'), 'utf8')).error.message;
    assert.equal(storedMessage, failureMessage.replace(secret, '[REDACTED]'));
    assert.doesNotMatch(await readFile(path.join(diagnosticsDir, 'run-report.json'), 'utf8'), new RegExp(secret));
    const renderedSummary = await readFile(summaryPath, 'utf8');
    assert.ok(renderedSummary.includes(String.raw`\[click\]\(https://evil\.example\)`));
    assert.ok(renderedSummary.includes(String.raw`\<img src=x onerror=alert\(1\)\>`));
    assert.match(renderedSummary, /…/);
    assert.equal(renderedSummary.includes('x'.repeat(1_001)), false);
    assert.doesNotMatch(renderedSummary, /\[[^\]]+\]\(https:\/\/evil\.example\)|(^|[^\\])<img\b|\n# /i);
    assert.doesNotMatch(renderedSummary, /\u202e|::warning/i);
  } finally {
    if (previousSecret === undefined) delete process.env.EXCHANGE_RATE_API_KEY;
    else process.env.EXCHANGE_RATE_API_KEY = previousSecret;
    await rm(diagnosticsDir, { recursive: true, force: true });
  }
});

test('captures the current Apple response for failure diagnostics', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  await withMockedFetch(
    { html: buildAppleHtml(data, 'January 1, 2099'), fxPayload },
    () => assert.rejects(main({ dryRun: true }), /Apple published date is in the future/)
  );

  const { root, paths } = await createTemporaryProductionPaths();
  const diagnosticsDir = path.join(root, 'diagnostics');
  const invalidData = structuredClone(data);
  invalidData.fx.fetchedAt = '2026-07-30T00:00:00.000Z';
  invalidData.generatedAt = '2026-07-31T00:00:00.000Z';
  invalidData.run.startedAtUtc = '2026-07-30T23:59:00.000Z';
  invalidData.run.finishedAtUtc = invalidData.generatedAt;
  invalidData.run.observedAtUtc = invalidData.generatedAt;
  invalidData.run.observedAtBeijing = '2026-07-31';
  const invalidRunLog = JSON.parse(await readFile(paths.runLogPath, 'utf8'));
  const latestRun = invalidRunLog.runs.at(-1);
  latestRun.startedAtUtc = invalidData.run.startedAtUtc;
  latestRun.finishedAtUtc = invalidData.generatedAt;
  invalidRunLog.runs = [latestRun];
  invalidRunLog.updatedAtUtc = invalidData.generatedAt;
  const invalidHistory = JSON.parse(await readFile(paths.historyPath, 'utf8'));
  invalidHistory.updatedAt = invalidData.generatedAt;
  await Promise.all([
    writeFile(paths.currentDataPath, JSON.stringify(invalidData), 'utf8'),
    writeFile(paths.historyPath, JSON.stringify(invalidHistory), 'utf8'),
    writeFile(paths.runLogPath, JSON.stringify(invalidRunLog), 'utf8')
  ]);
  try {
    await withMockedFetch(
      { html: buildAppleHtml(data), fxPayload: { result: 'error', 'error-type': 'quota-reached' } },
      () => assert.rejects(main({ dryRun: true, paths }), /quota-reached.*previous exchange-rate-derived prices are unusable/i)
    );
    await writeFailureDiagnostics(new Error('rate refresh failed'), {
      diagnosticsDir,
      stepSummaryPath: null
    });
    const diagnosticFile = path.join(diagnosticsDir, 'apple-snapshot.json');
    const diagnostic = JSON.parse(await readFile(diagnosticFile, 'utf8'));
    assert.equal(diagnostic.publishedDate, '2026-07-17');
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
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
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
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a legacy production baseline with missing required exchange rates before fetch', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const missingCurrency = data.countries.find(({ currency }) => currency !== 'USD')?.currency;
  assert.ok(missingCurrency, 'fixture must contain a non-USD currency');
  const previousData = legacySchema2Fixture(data);
  delete previousData.fx.rates[missingCurrency];
  await writeFile(paths.currentDataPath, `${JSON.stringify(previousData, null, 2)}\n`, 'utf8');
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await assertRejectsBeforeFetch(
      () => main({ dryRun: false, paths }),
      new RegExp(`Existing prices\\.json is missing exchange rates for: ${missingCurrency}`, 'i')
    );
    const after = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    assert.deepEqual(after, before);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
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

test('adds a newly required currency and removes a delisted currency on a successful refresh', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: { USD: 1, CNY: 7.2, EUR: 0.86 }
  }), { status: 200 });
  try {
    const fx = await getExchangeRates(
      { fx: { rates: { USD: 1, CNY: 7.1, JPY: 150 } } },
      { apiKey: '', requiredCurrencies: ['EUR'] }
    );
    assert.equal(fx.stale, false);
    assert.equal(fx.apiKeyStatus, 'not-configured');
    assert.equal(fx.rates.CNY, 7.2);
    assert.equal(fx.rates.EUR, 0.86);
    assert.equal(fx.rates.JPY, undefined);
    assert.deepEqual(Object.keys(fx.rates), ['CNY', 'EUR', 'USD']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fails closed when a newly required currency has no online rate', () => {
  assert.throws(
    () => selectRequiredRates({ USD: 1, CNY: 7.2, JPY: 150 }, ['EUR']),
    /Exchange rates are missing for: EUR/
  );
});

test('uses the authenticated exchange-rate endpoint without putting the key in the URL', async () => {
  const originalFetch = globalThis.fetch;
  const apiKey = 'test-secret-key';
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount += 1;
    assert.equal(String(url), 'https://v6.exchangerate-api.com/v6/latest/USD');
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`);
    assert.equal(options.redirect, 'error', 'credentialed requests must never follow redirects');
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
    assert.deepEqual(fx.rates, { CNY: 7.2, JPY: 150, USD: 1 });
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
    assert.deepEqual(fx.rates, { CNY: 7.2, JPY: 150, USD: 1 });
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

test('uses a monotonic clock for the default network budget', () => {
  const originalDateNow = Date.now;
  Date.now = () => { throw new Error('wall clock must not be used'); };
  try {
    const networkBudget = createNetworkBudget({ budgetMs: 100 });
    const remainingMs = networkBudget.deadlineAt - networkBudget.now();
    assert.ok(remainingMs > 0 && remainingMs <= 100);
  } finally {
    Date.now = originalDateNow;
  }
});

test('caps retry delays and request timeouts by the shared network deadline', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let now = 0;
  let requests = 0;
  const sleeps = [];
  const requestTimeouts = [];
  globalThis.fetch = async () => {
    requests += 1;
    now += 30;
    throw new Error('simulated outage');
  };
  console.warn = () => {};
  const networkBudget = createNetworkBudget({
    budgetMs: 100,
    now: () => now,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      now += delayMs;
    },
    createTimeoutSignal: (timeoutMs) => {
      requestTimeouts.push(timeoutMs);
      return new AbortController().signal;
    }
  });
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 5,
        retryDelaysMs: [0, 50, 50, 50, 50],
        requestTimeoutMs: 45,
        resourceName: 'test resource',
        networkBudget
      }),
      (error) => {
        assert.match(error.message, /Network deadline exceeded while fetching test resource/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
    assert.equal(requests, 2);
    assert.deepEqual(sleeps, [50]);
    assert.deepEqual(requestTimeouts, [45, 20]);
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('rejects an oversized response from its declared content length before reading it', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => new Response('small', {
    status: 200,
    headers: { 'content-length': '1025' }
  });
  console.warn = () => {};
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 1,
        maxResponseBytes: 1024,
        resourceName: 'declared oversized resource'
      }),
      (error) => {
        assert.match(error.message, /declared oversized resource response exceeds 1024 bytes/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('rejects an unsafe declared content length instead of trusting a rounded Number', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => new Response('small', {
    status: 200,
    headers: { 'content-length': '9007199254740992' }
  });
  console.warn = () => {};
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 1,
        maxResponseBytes: 1024,
        resourceName: 'unsafe declared resource'
      }),
      (error) => {
        assert.match(error.message, /unsafe declared resource response exceeds 1024 bytes/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('rejects an oversized streamed response when content length is absent', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => new Response('x'.repeat(1025), { status: 200 });
  console.warn = () => {};
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 1,
        maxResponseBytes: 1024,
        resourceName: 'streamed oversized resource'
      }),
      (error) => {
        assert.match(error.message, /streamed oversized resource response exceeds 1024 bytes/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('rejects malformed UTF-8 response bytes instead of decoding replacement characters', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 });
  console.warn = () => {};
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 1,
        json: true,
        resourceName: 'malformed UTF-8 resource'
      }),
      (error) => {
        assert.match(error.message, /malformed UTF-8 resource.*encoded data was not valid/i);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('strictly decodes the array-buffer fallback when a Response body stream is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  globalThis.fetch = async () => ({
    ok: true,
    headers: new Headers(),
    body: null,
    arrayBuffer: async () => new Uint8Array([0xc3, 0x28]).buffer
  });
  console.warn = () => {};
  try {
    await assert.rejects(
      fetchResource('https://example.test/resource', {
        attempts: 1,
        json: true,
        resourceName: 'bodyless malformed UTF-8 resource'
      }),
      (error) => {
        assert.match(error.message, /bodyless malformed UTF-8 resource.*encoded data was not valid/i);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('keeps previous exchange rates when the shared network deadline expires', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let now = 0;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    now += 2;
    throw new Error('simulated outage');
  };
  console.warn = () => {};
  const networkBudget = createNetworkBudget({
    budgetMs: 1,
    now: () => now,
    sleep: async (delayMs) => { now += delayMs; },
    createTimeoutSignal: () => new AbortController().signal
  });
  const fetchedAt = new Date().toISOString();
  try {
    const fx = await getExchangeRates({
      fx: {
        sourceUrl: 'https://open.er-api.com/v6/latest/USD',
        base: 'USD',
        fetchedAt,
        rates: { USD: 1, CNY: 7.1, JPY: 150 }
      }
    }, {
      apiKey: '',
      requiredCurrencies: ['USD', 'CNY', 'JPY'],
      networkBudget
    });
    assert.equal(requests, 1);
    assert.equal(fx.stale, true);
    assert.equal(fx.fetchedAt, fetchedAt);
  } finally {
    globalThis.fetch = originalFetch;
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
    assert.deepEqual(fx.rates, { CNY: 7.1, USD: 1 });
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
      (error) => {
        assert.match(error.message, /previous exchange-rate-derived prices are unusable: Exchange-rate response is too old/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
    );
    await assert.rejects(
      () => getExchangeRates({
        fx: {
          base: 'USD',
          fetchedAt: new Date().toISOString(),
          rates: { USD: 1, CNY: 7.1 }
        }
      }, { requiredCurrencies: ['USD', 'CNY', 'JPY'] }),
      (error) => {
        assert.match(error.message, /previous exchange rates are missing for: JPY/);
        assert.equal(classifyHealthcheckFailure(error), 'transient');
        return true;
      }
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
  assert.equal(result.history.updatedAt, '2026-07-31T16:00:00.000Z');
  assert.throws(
    () => updateHistory(result.history, [alphaWithNewTier], '2026-08-02', [TIER_50, TIER_1TB], 'not-an-iso-timestamp'),
    /UTC observation timestamp is invalid/
  );

  const repeated = updateHistory(result.history, [alphaWithNewTier], '2026-08-02', [TIER_50, TIER_1TB], '2026-08-01T16:00:00.000Z');
  assert.equal(repeated.history.countries.Alpha.events.length, 2, 'unchanged prices should not duplicate history');
  assert.equal(repeated.history.updatedAt, '2026-07-31T16:00:00.000Z', 'unchanged history must keep its last structural update time');
  assert.equal(repeated.changed, false);
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
        time_last_update_unix: recentFxTimestamp(),
        rates: compatibleExchangeRates(data)
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
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
  };
  await runDryMain({
    html: buildAppleHtml(data).replaceAll('50 GB', '50GB'),
    fxPayload
  });
});

test('fails closed before FX processing when only one Apple parser succeeds', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: compatibleExchangeRates(data)
  };
  await assert.rejects(
    () => runDryMain({
      html: buildAppleHtml(data).replaceAll(' class="gb-header"', ''),
      fxPayload
    }),
    /Apple parser redundancy failed closed/
  );
});

test('complete dry-run keeps previous derived CNY prices for an incomplete online response and rejects a missing Apple publication date', async (t) => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  t.mock.timers.enable({ apis: ['Date'], now: new Date(data.generatedAt) });
  const missingCurrency = data.countries.find(({ currency }) => currency !== 'USD').currency;
  const incompleteRates = { ...compatibleExchangeRates(data) };
  delete incompleteRates[missingCurrency];
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
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
  assert.match(warnings.join('\n'), /keeping previous derived CNY prices/);
  await assert.rejects(
    () => runDryMain({ html: buildAppleHtml(data, null), fxPayload: { ...fxPayload, rates: compatibleExchangeRates(data) } }),
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
  assert.equal(Object.hasOwn(entry.source, 'exchangeRatesApiKeyStatus'), false);
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
  const sanitized = buildRunLog({
    schemaVersion: 1,
    retention: 90,
    runs: [{ id: 'legacy', source: { exchangeRatesApiKeyStatus: 'valid', exchangeRatesStale: false } }]
  }, entry);
  assert.deepEqual(sanitized.runs[0].source, { exchangeRatesStale: false });

  const legacyWithDebugFields = structuredClone(entry);
  legacyWithDebugFields.debug = true;
  legacyWithDebugFields.source.exchangeRatesApiKeyStatus = 'valid';
  legacyWithDebugFields.source.exchangeRatesFallbackReason = 'invalid-key';
  legacyWithDebugFields.source.rawRates = { USD: 1 };
  legacyWithDebugFields.counts.debug = true;
  legacyWithDebugFields.counts.tiers[0].debug = true;
  legacyWithDebugFields.changes.debug = true;
  legacyWithDebugFields.changes.publishedDate.debug = true;
  legacyWithDebugFields.changes.addedCountries[0].debug = true;
  legacyWithDebugFields.changes.changedCountries = [{
    country: 'Alpha',
    nameZh: 'Alpha',
    fromCurrency: 'USD',
    toCurrency: 'CAD',
    fromRegion: 'Other',
    toRegion: 'Americas',
    tiers: [{ id: '50GB', from: 0.99, to: 1.29, debug: true }],
    debug: true
  }];
  const fullySanitized = buildRunLog({ schemaVersion: 1, retention: 90, runs: [legacyWithDebugFields] }, entry);
  assert.doesNotMatch(JSON.stringify(fullySanitized.runs[0]), /debug|rawRates|ApiKey/);
  assert.equal(fullySanitized.runs[0].source.exchangeRatesFallbackReason, 'source-unavailable');
  assert.deepEqual(fullySanitized.runs[0].changes.addedCountries[0], { country: 'Beta', nameZh: 'Beta' });
  assert.deepEqual(fullySanitized.runs[0].changes.changedCountries[0].tiers[0], {
    id: '50GB', from: 0.99, to: 1.29
  });
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
  assert.match(rendered, /汇率来源：ExchangeRate-API 认证接口（主来源）/);
  assert.doesNotMatch(rendered, /API Key|汇率认证|未配置|invalid-key|quota-reached/i);
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
  assert.doesNotMatch(stale, /API Key|汇率认证|未配置/i);
  assert.match(stale, /缺少汇率.*JPY/);

  const sanitySkipped = buildActionSummaryLines(data, {
    ...summary,
    fxSanityWarnings: ['FX_SANITY_SKIPPED_OLD_BASELINE']
  }, 'schedule').join('\n');
  assert.match(sanitySkipped, /FX sanity.*FX\\_SANITY\\_SKIPPED\\_OLD\\_BASELINE/);

  const unknownMarket = buildActionSummaryLines(data, {
    ...summary,
    unknownMarkets: [{ sourceName: 'New Apple Market', id: 'apple-new-apple-market-1234abcd' }]
  }, 'schedule').join('\n');
  assert.match(unknownMarket, /UNKNOWN_APPLE_MARKET.*New Apple Market.*apple-new-apple-market-1234abcd/);

  const pendingChineseName = buildActionSummaryLines(data, {
    ...summary,
    chineseNamePendingMarkets: [{ marketId: 'mu', sourceName: 'Mauritius' }]
  }, 'schedule').join('\n');
  assert.match(pendingChineseName, /CHINESE_MARKET_NAME_PENDING.*marketId=mu.*sourceName=Mauritius/);

  const renameSuspected = buildActionSummaryLines(data, {
    ...summary,
    marketIdentityRenameSuspicions: [{
      oldSourceName: 'Old [Market]\n::warning::',
      newSourceName: 'New Market',
      oldMarketId: 'old-id',
      region: 'Asia Pacific',
      currency: 'USD',
      pricesMatch: false
    }]
  }, 'schedule').join('\n');
  assert.match(renameSuspected, /MARKET_IDENTITY_RENAME_SUSPECTED.*New Market.*old-id.*pricesMatch=false.*自动发布继续/s);
  assert.doesNotMatch(renameSuspected, /\n::warning::/);

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
  assert.match(noSecret, /汇率来源：ExchangeRate-API 开放接口/);
  assert.doesNotMatch(noSecret, /API Key|汇率认证|未配置/i);
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
  assert.doesNotMatch(fallback, /API Key|汇率认证|额度|quota-reached/i);
  assert.doesNotMatch(fallback, /### 警告/);

  const injected = buildActionSummaryLines({
    ...data,
    source: {
      publishedDate: '[date](https://evil.example)',
      parser: '[parser](https://evil.example)',
      parserStatus: '<img src=x onerror=alert(1)>\n# injected heading'
    }
  }, {
    ...summary,
    missingRates: ['[JPY](https://evil.example)'],
    publicationDateChanged: true,
    publishedDateHistory: [
      { publishedDate: 'July 1, 2026' },
      { publishedDate: '[date](https://evil.example)' }
    ],
    publicationChanges: {
      ...summary.publicationChanges,
      addedTiers: [{ id: '1TB', label: '[tier](https://evil.example)' }],
      addedCountries: [{ country: 'Injected', nameZh: '[click](https://evil.example)' }]
    }
  }, 'schedule').join('\n');
  assert.ok(injected.includes(String.raw`\[click\]\(https://evil\.example\)`));
  assert.ok(injected.includes(String.raw`\[tier\]\(https://evil\.example\)`));
  assert.ok(injected.includes(String.raw`\[parser\]\(https://evil\.example\)`));
  assert.ok(injected.includes(String.raw`\<img src=x onerror=alert\(1\)\>`));
  assert.doesNotMatch(injected, /\[[^\]]+\]\(https:\/\/evil\.example\)/);
  assert.doesNotMatch(injected, /(^|[^\\])<img\b|\n# /i);
});

test('keeps credential configuration and failure details out of public Action notices', async () => {
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: recentFxTimestamp(),
    rates: compatibleExchangeRates(data)
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
  assert.match(output, /::notice title=汇率来源自动回退::认证汇率来源不可用，已使用开放接口。/);
  assert.equal((output.match(/::notice title=汇率来源自动回退::/g) ?? []).length, 1);
  assert.doesNotMatch(output, /API Key|未配置|无效|invalid-key|quota-reached/i);
  assert.equal(
    output.split('\n').filter((line) => line.startsWith('::warning')).every(
      (line) => line.startsWith('::warning title=Apple Chinese market name pending::')
    ),
    true
  );
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
  const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: compatibleExchangeRates(data)
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
  const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: compatibleExchangeRates(data)
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
  const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: compatibleExchangeRates(data)
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
  for (const extension of ['html', 'json']) {
    const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
    await copyCommittedSnapshotStore(paths);
    const orphanName = `orphan-evidence.${extension}`;
    const orphanPath = path.join(paths.snapshotsDir, orphanName);
    await writeFile(orphanPath, extension === 'html' ? '<orphan evidence>' : '{"orphan":true}', 'utf8');
    const before = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8'),
      readFile(paths.snapshotIndexPath, 'utf8')
    ]);
    try {
      await assertRejectsBeforeFetch(
        () => main({ dryRun: false, paths, stepSummaryPath: null }),
        new RegExp(`snapshot index does not reference existing evidence: ${orphanName.replace('.', '\\.')}`, 'i')
      );
      assert.equal(
        await readFile(orphanPath, 'utf8'),
        extension === 'html' ? '<orphan evidence>' : '{"orphan":true}'
      );
      assert.deepEqual(await Promise.all([
        readFile(paths.currentDataPath, 'utf8'),
        readFile(paths.historyPath, 'utf8'),
        readFile(paths.runLogPath, 'utf8'),
        readFile(paths.snapshotIndexPath, 'utf8')
      ]), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('fails closed when indexed snapshot evidence is missing', async () => {
  for (const field of ['dataFile']) {
    const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
    const index = await copyCommittedSnapshotStore(paths);
    const missingFile = index.snapshots[0].revisions[0][field];
    await rm(path.join(paths.snapshotsDir, missingFile));
    const before = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8'),
      readFile(paths.snapshotIndexPath, 'utf8')
    ]);
    try {
      await assertRejectsBeforeFetch(
        () => main({ dryRun: false, paths, stepSummaryPath: null }),
        new RegExp(`snapshot index references missing evidence: ${missingFile.replace('.', '\\.')}`, 'i')
      );
      assert.deepEqual(await Promise.all([
        readFile(paths.currentDataPath, 'utf8'),
        readFile(paths.historyPath, 'utf8'),
        readFile(paths.runLogPath, 'utf8'),
        readFile(paths.snapshotIndexPath, 'utf8')
      ]), before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('fails closed when normalized snapshot content does not match its hash', async () => {
  const { root, paths } = await createTemporaryProductionPaths({ copySnapshots: false });
  const index = await copyCommittedSnapshotStore(paths);
  const revision = index.snapshots[0].revisions[0];
  const dataPath = path.join(paths.snapshotsDir, revision.dataFile);
  const normalized = JSON.parse(await readFile(dataPath, 'utf8'));
  const firstCountry = normalized.countries[0];
  const firstTier = normalized.tiers[0].id;
  firstCountry.plans[firstTier] += 1;
  await writeFile(dataPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  const corruptedEvidence = await readFile(dataPath, 'utf8');
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8'),
    readFile(paths.snapshotIndexPath, 'utf8')
  ]);
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    throw new Error('preflight must run before network fetches');
  };
  try {
    await assert.rejects(
      main({ dryRun: false, paths, stepSummaryPath: null }),
      /snapshot evidence has a content-hash mismatch/i
    );
    assert.equal(fetched, false);
    assert.equal(await readFile(dataPath, 'utf8'), corruptedEvidence);
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8'),
      readFile(paths.snapshotIndexPath, 'utf8')
    ]), before);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects syntactically valid but corrupt prices and history baselines', async () => {
  const corruptions = [
    {
      file: 'prices',
      mutate(value) { value.countries = []; },
      error: /Only 0 countries were parsed/
    },
    {
      file: 'prices',
      mutate(value) { value.fx.sourceUrl = 'https://example.invalid/rates?key=secret'; },
      error: /prices\.json has an unsupported or unsafe structure/i
    },
    {
      file: 'history',
      mutate(value) { value.countries = {}; value.sourcePublishedDates = []; },
      error: /history\.json has an unsupported structure/i
    }
  ];

  for (const corruption of corruptions) {
    const { root, paths } = await createTemporaryProductionPaths();
    const targetPath = corruption.file === 'prices' ? paths.currentDataPath : paths.historyPath;
    const value = JSON.parse(await readFile(targetPath, 'utf8'));
    corruption.mutate(value);
    await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const before = await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]);
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      throw new Error('preflight must run before network fetches');
    };
    try {
      await assert.rejects(main({ dryRun: false, paths, stepSummaryPath: null }), corruption.error);
      assert.equal(fetched, false);
      assert.deepEqual(await Promise.all([
        readFile(paths.currentDataPath, 'utf8'),
        readFile(paths.historyPath, 'utf8'),
        readFile(paths.runLogPath, 'utf8')
      ]), before);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('rejects structurally valid cross-file production mismatches', async (t) => {
  const cases = [
    {
      name: 'prices differ from latest history values',
      target: 'prices',
      mutate({ prices }) {
        const country = prices.countries[0];
        const tierId = prices.tiers[0].id;
        country.plans[tierId].price += 1;
        country.plans[tierId].formattedPrice = `${country.currency} ${country.plans[tierId].price}`;
      },
      error: /Existing history\.json latest values do not match/i
    },
    {
      name: 'latest history values differ from current prices',
      target: 'history',
      mutate({ prices, history }) {
        const country = prices.countries[0];
        const tierId = prices.tiers[0].id;
        history.markets[country.marketId].events.at(-1).plans[tierId] += 1;
      },
      error: /Existing history\.json latest values do not match/i
    },
    {
      name: 'latest run counts differ from current prices',
      target: 'runLog',
      mutate({ runLog }) {
        runLog.runs.at(-1).counts.countries += 1;
      },
      error: /Existing run-log\.json latest run does not match current prices/i
    },
    {
      name: 'latest run publication date differs from current prices',
      target: 'runLog',
      mutate({ runLog }) {
        runLog.runs.at(-1).source.applePublishedDate = 'April 06, 2026';
      },
      error: /Existing run-log\.json latest run does not match current prices/i
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const { root, paths } = await createTemporaryProductionPaths();
      const values = {
        prices: JSON.parse(await readFile(paths.currentDataPath, 'utf8')),
        history: JSON.parse(await readFile(paths.historyPath, 'utf8')),
        runLog: JSON.parse(await readFile(paths.runLogPath, 'utf8'))
      };
      testCase.mutate(values);
      const targetPath = {
        prices: paths.currentDataPath,
        history: paths.historyPath,
        runLog: paths.runLogPath
      }[testCase.target];
      await writeFile(targetPath, `${JSON.stringify(values[testCase.target], null, 2)}\n`, 'utf8');
      const before = await Promise.all([
        readFile(paths.currentDataPath, 'utf8'),
        readFile(paths.historyPath, 'utf8'),
        readFile(paths.runLogPath, 'utf8')
      ]);
      try {
        await assertRejectsBeforeFetch(
          () => main({ dryRun: false, paths, stepSummaryPath: null }),
          testCase.error
        );
        assert.deepEqual(await Promise.all([
          readFile(paths.currentDataPath, 'utf8'),
          readFile(paths.historyPath, 'utf8'),
          readFile(paths.runLogPath, 'utf8')
        ]), before);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('rejects current prices that disagree with the active snapshot evidence', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const prices = JSON.parse(await readFile(paths.currentDataPath, 'utf8'));
  const history = JSON.parse(await readFile(paths.historyPath, 'utf8'));
  const country = prices.countries[0];
  const tierId = prices.tiers[0].id;
  const changedPrice = country.plans[tierId].price + 1;
  country.plans[tierId].price = changedPrice;
  country.plans[tierId].formattedPrice = `${country.currency} ${changedPrice}`;
  history.markets[country.marketId].events.at(-1).plans[tierId] = changedPrice;
  await Promise.all([
    writeFile(paths.currentDataPath, `${JSON.stringify(prices, null, 2)}\n`, 'utf8'),
    writeFile(paths.historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8')
  ]);
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.historyPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await assertRejectsBeforeFetch(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      /Apple snapshot active revision does not match current prices/i
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.historyPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects malformed history countries before any production write', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const data = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const html = buildAppleHtml(data);
  const fxPayload = {
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: Math.floor(Date.parse(data.fx.fetchedAt) / 1000),
    rates: compatibleExchangeRates(data)
  };
  const malformedHistory = JSON.stringify({ schemaVersion: 2, countries: [], sourcePublishedDates: [] });
  await writeFile(paths.historyPath, malformedHistory, 'utf8');
  const before = await Promise.all([
    readFile(paths.currentDataPath, 'utf8'),
    readFile(paths.runLogPath, 'utf8')
  ]);
  const snapshotStoreBefore = await readSnapshotStoreState(paths);
  try {
    await withMockedFetch(
      { html, fxPayload },
      () => assert.rejects(
        main({ dryRun: false, paths, stepSummaryPath: null }),
        /history\.json has an unsupported structure/i
      )
    );
    assert.deepEqual(await Promise.all([
      readFile(paths.currentDataPath, 'utf8'),
      readFile(paths.runLogPath, 'utf8')
    ]), before);
    assert.equal(await readFile(paths.historyPath, 'utf8'), malformedHistory);
    assert.deepEqual(await readSnapshotStoreState(paths), snapshotStoreBefore);
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
    await writeFile(lockPath, JSON.stringify({ pid: 'not-a-pid', acquiredAtUtc: new Date().toISOString() }), 'utf8');
    await assert.rejects(
      () => acquireUpdateLock(lockPath, { staleAfterMs: 60_000 }),
      /already running/
    );
    await writeFile(lockPath, '{', 'utf8');
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

test('rejects malformed recovery transactions before any network fetch', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const transactionPath = defaultUpdateTransactionPath(paths.currentDataPath);
  try {
    await writeFile(transactionPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'writing',
      originalFiles: [null],
      originalSnapshotIndexText: null,
      createdSnapshotFiles: [path.join(paths.snapshotsDir, 'index.json')]
    }, null, 2)}\n`, 'utf8');
    await assertRejectsBeforeFetch(
      () => main({ dryRun: false, paths, stepSummaryPath: null }),
      /Unsafe or unsupported iCloud price update recovery transaction/
    );
    assert.ok(await readFile(transactionPath, 'utf8'), 'unsafe transaction must remain for manual inspection');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recovers an interrupted update transaction before the next network fetch', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const transactionPath = defaultUpdateTransactionPath(paths.currentDataPath);
  const productionPaths = [paths.currentDataPath, paths.historyPath, paths.runLogPath];
  const originalFiles = await Promise.all(productionPaths.map(async (filePath) => ({
    filePath,
    text: await readFile(filePath, 'utf8'),
    existed: true
  })));
  const originalSnapshotIndexText = await readFile(paths.snapshotIndexPath, 'utf8');
  const createdSnapshotFiles = [
    path.join(paths.snapshotsDir, '2026-08-07-aaaaaaaaaaaa.json')
  ];
  const originalFetch = globalThis.fetch;
  let fetched = false;
  let clock = 0;
  const networkBudget = createNetworkBudget({
    budgetMs: 1,
    now: () => clock,
    sleep: async () => {},
    createTimeoutSignal: () => undefined
  });

  try {
    await Promise.all(createdSnapshotFiles.map((filePath) => writeFile(filePath, 'partial evidence', 'utf8')));
    await writeFile(transactionPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'writing',
      originalFiles,
      originalSnapshotIndexText,
      createdSnapshotFiles
    }, null, 2)}\n`, 'utf8');
    await Promise.all([
      ...productionPaths.map((filePath) => writeFile(filePath, '{"corrupt":true}\n', 'utf8')),
      writeFile(paths.snapshotIndexPath, '{"corrupt":true}\n', 'utf8')
    ]);

    globalThis.fetch = async () => {
      fetched = true;
      assert.deepEqual(
        await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8'))),
        originalFiles.map(({ text }) => text)
      );
      assert.equal(await readFile(paths.snapshotIndexPath, 'utf8'), originalSnapshotIndexText);
      await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
      for (const filePath of createdSnapshotFiles) {
        await assert.rejects(readFile(filePath, 'utf8'), { code: 'ENOENT' });
      }
      clock = 2;
      throw new Error('stop after interrupted transaction recovery');
    };

    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null, networkBudget }),
      /Network deadline exceeded/
    );
    assert.equal(fetched, true);
    assert.deepEqual(
      await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8'))),
      originalFiles.map(({ text }) => text)
    );
    assert.equal(await readFile(paths.snapshotIndexPath, 'utf8'), originalSnapshotIndexText);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps committed production data when cleaning a leftover transaction marker', async () => {
  const { root, paths } = await createTemporaryProductionPaths();
  const transactionPath = defaultUpdateTransactionPath(paths.currentDataPath);
  const productionPaths = [paths.currentDataPath, paths.historyPath, paths.runLogPath];
  const productionBefore = await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8')));
  const snapshotIndexBefore = await readFile(paths.snapshotIndexPath, 'utf8');
  const originalFetch = globalThis.fetch;
  let fetched = false;
  let clock = 0;
  const networkBudget = createNetworkBudget({
    budgetMs: 1,
    now: () => clock,
    sleep: async () => {},
    createTimeoutSignal: () => undefined
  });

  try {
    await writeFile(transactionPath, `${JSON.stringify({
      schemaVersion: 1,
      phase: 'committed',
      originalFiles: productionPaths.map((filePath) => ({
        filePath,
        text: '{"stale-original":true}\n',
        existed: true
      })),
      originalSnapshotIndexText: '{"stale-index":true}\n',
      createdSnapshotFiles: []
    }, null, 2)}\n`, 'utf8');

    globalThis.fetch = async () => {
      fetched = true;
      assert.deepEqual(
        await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8'))),
        productionBefore
      );
      assert.equal(await readFile(paths.snapshotIndexPath, 'utf8'), snapshotIndexBefore);
      await assert.rejects(readFile(transactionPath, 'utf8'), { code: 'ENOENT' });
      clock = 2;
      throw new Error('stop after committed transaction cleanup');
    };

    await assert.rejects(
      () => main({ dryRun: false, paths, stepSummaryPath: null, networkBudget }),
      /Network deadline exceeded/
    );
    assert.equal(fetched, true);
    assert.deepEqual(
      await Promise.all(productionPaths.map((filePath) => readFile(filePath, 'utf8'))),
      productionBefore
    );
    assert.equal(await readFile(paths.snapshotIndexPath, 'utf8'), snapshotIndexBefore);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('records pure tier removal and same-price restoration as availability changes', () => {
  const history = {
    schemaVersion: 2,
    countries: {
      Alpha: {
        nameZh: '甲',
        region: 'Americas',
        events: [{ observedAt: '2026-07-01', currency: 'USD', plans: { '50GB': 1, '200GB': 3 } }]
      }
    }
  };
  const withoutTier = country('Alpha', { nameZh: '甲', prices: { '50GB': 1 } });
  const removed = updateHistory(history, [withoutTier], '2026-07-15', [TIER_50]);
  assert.equal(removed.changedCountries, 1);
  assert.deepEqual(removed.history.countries.Alpha.events.at(-1).plans, { '50GB': 1 });

  const restoredCountry = country('Alpha', { nameZh: '甲', prices: { '50GB': 1, '200GB': 3 } });
  const restored = updateHistory(removed.history, [restoredCountry], '2026-08-01', [TIER_50, TIER_200]);
  assert.equal(restored.changedCountries, 1);
  assert.equal(restored.history.countries.Alpha.events.length, 3);
  assert.deepEqual(restored.history.countries.Alpha.events.at(-1).plans, { '50GB': 1, '200GB': 3 });
});
