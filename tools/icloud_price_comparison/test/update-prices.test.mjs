import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildSnapshotChanges,
  buildRunLog,
  buildActionSummaryLines,
  createRunLogEntry,
  getExchangeRates,
  main,
  publicationDateKey,
  updateHistory,
  updatePublishedDateHistory
} from '../scripts/update-prices.mjs';

const TIER_50 = { id: '50GB', label: '50 GB', capacityGb: 50 };
const TIER_200 = { id: '200GB', label: '200 GB', capacityGb: 200 };
const TIER_1TB = { id: '1TB', label: '1 TB', capacityGb: 1024 };
const updaterUrl = new URL('../scripts/update-prices.mjs', import.meta.url);
const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);
const runLogUrl = new URL('../data/run-log.json', import.meta.url);

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

async function runDryMain({ html, fxPayload }) {
  const originalFetch = globalThis.fetch;
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_STEP_SUMMARY;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes('support.apple.com')) return new Response(html, { status: 200 });
    if (target.includes('open.er-api.com')) return new Response(JSON.stringify(fxPayload), { status: 200 });
    throw new Error(`Unexpected URL in dry-run test: ${target}`);
  };
  try {
    return await main({ dryRun: true });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
  }
}

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

test('does not carry a missing currency from old rates into a successful refresh', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: 'success',
    base_code: 'USD',
    time_last_update_unix: 1_754_006_400,
    rates: { USD: 1, CNY: 7.2 }
  }), { status: 200 });
  try {
    const fx = await getExchangeRates({ fx: { rates: { USD: 1, CNY: 7.1, JPY: 150 } } });
    assert.equal(fx.stale, false);
    assert.equal(fx.rates.CNY, 7.2);
    assert.equal(fx.rates.JPY, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps the previous exchange rates when the refresh fails', async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.fetch = async () => { throw new Error('temporary outage'); };
  globalThis.setTimeout = (callback, _delay, ...args) => originalSetTimeout(callback, 0, ...args);
  try {
    const fx = await getExchangeRates({
      fx: {
        sourceUrl: 'https://example.test/rates',
        base: 'USD',
        fetchedAt: '2026-07-30T00:00:00.000Z',
        rates: { USD: 1, CNY: 7.1, JPY: 150 }
      }
    });
    assert.equal(fx.stale, true);
    assert.equal(fx.fetchedAt, '2026-07-30T00:00:00.000Z');
    assert.equal(fx.rates.JPY, 150);
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
      () => getExchangeRates({ fx: { rates: { USD: 1 } } }),
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

test('complete dry-run rejects missing exchange rates and a missing Apple publication date', async () => {
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

  await assert.rejects(
    () => runDryMain({ html: buildAppleHtml(data), fxPayload }),
    new RegExp(`Exchange rates are missing for:.*${missingCurrency}`)
  );
  await assert.rejects(
    () => runDryMain({ html: buildAppleHtml(data, null), fxPayload: { ...fxPayload, rates: data.fx.rates } }),
    /Apple published date was not found/
  );
});

test('builds a structured successful run log with source, counts, and changes', () => {
  const data = {
    source: {
      url: 'https://support.apple.com/en-us/108047',
      publishedDate: 'July 17, 2026',
      parser: 'cross-checked',
      parserStatus: 'Both independent parser paths agreed'
    },
    fx: { fetchedAt: '2026-08-01T00:02:31.000Z', stale: false },
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
  const entry = createRunLogEntry(
    data,
    { observedAt: '2026-08-01', publicationChanges },
    new Date('2026-08-01T04:00:00.000Z'),
    new Date('2026-08-01T04:00:02.500Z')
  );

  assert.equal(entry.status, 'success');
  assert.equal(entry.durationMs, 2500);
  assert.equal(entry.observedAtBeijing, '2026-08-01');
  assert.equal(entry.source.applePublishedDate, 'July 17, 2026');
  assert.equal(entry.source.appleParser, 'cross-checked');
  assert.match(entry.source.appleParserStatus, /agreed/);
  assert.equal(entry.counts.countries, 2);
  assert.equal(entry.counts.pricePoints, 4);
  assert.equal(entry.counts.currencies, 2);
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

test('rejects invalid USD anchors, timestamps, and stale fallback rates', async () => {
  const originalFetch = globalThis.fetch;
  const invalidPayloads = [
    { result: 'success', base_code: 'USD', time_last_update_unix: 1_754_006_400, rates: { USD: 2, CNY: 7.2 } },
    { result: 'success', base_code: 'USD', time_last_update_unix: 0, rates: { USD: 1, CNY: 7.2 } },
    { result: 'success', base_code: 'EUR', time_last_update_unix: 1_754_006_400, rates: { USD: 1, CNY: 7.2 } },
    { result: 'success', base_code: 'USD', time_last_update_unix: 1_754_006_400, rates: { USD: 1, CNY: -7.2 } }
  ];
  try {
    for (const payload of invalidPayloads) {
      globalThis.fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
      await assert.rejects(
        () => getExchangeRates({ fx: { rates: { USD: 0, CNY: -1 } } }),
        /Exchange-rate response is missing required fields/
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
      stale: false
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
  assert.match(rendered, /Apple 解析路径：cross-checked（双解析器一致）/);
  assert.match(rendered, /### 本次变化\n本次变化：无/);
  assert.doesNotMatch(rendered, /本次新增地区：无|本次移除地区：无|缺少汇率：无/);

  const stale = buildActionSummaryLines({
    ...data,
    fx: { ...data.fx, stale: true }
  }, {
    ...summary,
    missingRates: ['JPY']
  }, 'schedule').join('\n');
  assert.match(stale, /### 警告/);
  assert.match(stale, /汇率降级/);
  assert.match(stale, /缺少汇率.*JPY/);
});

test('keeps failure diagnostics compact without duplicate files', async () => {
  const source = await readFile(updaterUrl, 'utf8');
  assert.match(source, /run-report\.json/);
  assert.doesNotMatch(source, /update-failure\.json/);
  assert.doesNotMatch(source, /path\.join\(DIAGNOSTICS_DIR, 'apple-response\.html'\)/);
});
