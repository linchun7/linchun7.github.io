import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrateHistoryToSchema4, migratePricesSchema3To4 } from '../scripts/migrate-schema-3-to-4.mjs';
import { attachMarketIdentity, resolveMarket, validateMarketRegistry } from '../scripts/market-registry.mjs';
import { validatePriceHistoryConsistency } from '../data-contract.js';

const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);

async function schema3Fixtures() {
  const [schema4Prices, schema4History] = await Promise.all([
    readFile(pricesUrl, 'utf8').then(JSON.parse),
    readFile(historyUrl, 'utf8').then(JSON.parse)
  ]);
  const prices = structuredClone(schema4Prices);
  prices.schemaVersion = 3;
  for (const country of prices.countries) {
    delete country.marketId;
    for (const plan of Object.values(country.plans)) delete plan.cnyRank;
  }
  const history = {
    schemaVersion: 2,
    updatedAt: schema4History.updatedAt,
    countries: Object.fromEntries(Object.values(schema4History.markets).map(({ country, ...record }) => [country, record])),
    sourcePublishedDates: structuredClone(schema4History.sourcePublishedDates)
  };
  return { prices, history };
}

test('registry covers all current Apple markets and unknown markets get stable non-colliding IDs', async () => {
  const registry = validateMarketRegistry();
  assert.equal(Object.keys(registry).length, 73);
  const { prices } = await schema3Fixtures();
  assert.deepEqual(new Set(prices.countries.map(({ country }) => country)), new Set(Object.keys(registry)));
  const first = resolveMarket('New Apple Market');
  const second = resolveMarket('New Apple Market');
  assert.equal(first.id, second.id);
  assert.match(first.id, /^apple-new-apple-market-[0-9a-f]{8}$/);
  assert.equal(Object.values(registry).some(({ id }) => id === first.id), false);
  const warnings = [];
  const [unknown] = attachMarketIdentity([{ country: 'New Apple Market' }], { onUnknown: (market) => warnings.push(market) });
  assert.equal(unknown.marketId, first.id);
  assert.equal(unknown.nameZh, 'New Apple Market');
  assert.equal(warnings.length, 1);
});

test('schema migration preserves every local price, timestamp, and Apple source field', async () => {
  const { prices, history } = await schema3Fixtures();
  const migratedPrices = migratePricesSchema3To4(prices);
  const migratedHistory = migrateHistoryToSchema4(history, migratedPrices);
  assert.equal(migratedPrices.schemaVersion, 4);
  assert.equal(migratedHistory.schemaVersion, 4);
  assert.equal(migratedPrices.generatedAt, prices.generatedAt);
  assert.deepEqual(migratedPrices.source, prices.source);
  assert.equal(migratedHistory.updatedAt, history.updatedAt);
  for (const [index, country] of prices.countries.entries()) {
    const migrated = migratedPrices.countries[index];
    assert.equal(migrated.country, country.country);
    for (const { id } of prices.tiers) {
      assert.equal(migrated.plans[id].price, country.plans[id].price);
      assert.equal(migrated.plans[id].formattedPrice, country.plans[id].formattedPrice);
      assert.ok(Number.isInteger(migrated.plans[id].cnyRank));
    }
    assert.deepEqual(migratedHistory.markets[migrated.marketId].events, history.countries[country.country].events);
  }
  assert.doesNotThrow(() => validatePriceHistoryConsistency(migratedPrices, migratedHistory));
});

test('migration assigns dense ranks independently for each tier', () => {
  const prices = {
    schemaVersion: 3,
    generatedAt: '2026-08-11T00:06:34.089Z',
    source: { name: 'Apple Support', url: 'https://support.apple.com/en-us/108047', publishedDate: 'July 17, 2026', parser: 'cross-checked', parserStatus: 'Both DOM association paths agreed' },
    run: { startedAtUtc: '2026-08-11T00:06:33.433Z', finishedAtUtc: '2026-08-11T00:06:34.089Z', observedAtBeijing: '2026-08-11', observedAtUtc: '2026-08-11T00:06:34.089Z', countries: 3, pricePoints: 3 },
    fx: { sourceUrl: 'https://open.er-api.com/v6/latest/USD', sourceMode: 'open-access', fallbackUsed: false, fallbackReason: null, base: 'USD', fetchedAt: '2026-08-11T00:00:01.000Z', stale: false, derivedCurrency: 'CNY' },
    tiers: [{ id: '50GB', label: '50 GB', capacityGb: 50 }],
    countries: [
      ['Japan', 'JPY', '¥100', 100, 7.1],
      ['Hong Kong', 'HKD', 'HK$ 8', 8, 7.1],
      ['India', 'INR', '₹100', 100, 7.2]
    ].map(([country, currency, formattedPrice, price, cnyPrice]) => ({ country, nameZh: country, region: 'Asia Pacific', currency, plans: { '50GB': { price, formattedPrice, cnyPrice } } }))
  };
  const migrated = migratePricesSchema3To4(prices);
  assert.deepEqual(migrated.countries.map((country) => country.plans['50GB'].cnyRank), [1, 1, 2]);
});
