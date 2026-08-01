import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSnapshotChanges,
  buildRunLog,
  buildActionSummaryLines,
  createRunLogEntry,
  getExchangeRates,
  publicationDateKey,
  updateHistory,
  updatePublishedDateHistory
} from '../scripts/update-prices.mjs';

const TIER_50 = { id: '50GB', label: '50 GB', capacityGb: 50 };
const TIER_200 = { id: '200GB', label: '200 GB', capacityGb: 200 };
const TIER_1TB = { id: '1TB', label: '1 TB', capacityGb: 1024 };

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
  globalThis.fetch = async () => { throw new Error('temporary outage'); };
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
