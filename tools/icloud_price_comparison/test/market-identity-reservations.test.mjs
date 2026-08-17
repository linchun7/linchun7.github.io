import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createPublishedMarketResolver,
  resolveMarket,
  validateMarketIdentityContinuity,
  validateReservedMarketRegistry
} from '../scripts/market-registry.mjs';
import { RESERVED_MARKET_REGISTRY } from '../scripts/reserved-market-registry.mjs';
import { migrateMarketIdentityPayloads } from '../scripts/migrate-market-id.mjs';

const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);

test('pre-reserves friendly IDs for plausible future markets without claiming they are active', () => {
  const reservations = validateReservedMarketRegistry();
  assert.ok(Object.keys(reservations).length >= 170, 'the future reservation catalog should cover most standard country/region codes');
  assert.equal(resolveMarket('Germany').id, 'de');
  assert.equal(resolveMarket('Germany').reserved, true);
  assert.equal(resolveMarket('Germany').unknown, false);
  assert.equal(resolveMarket('Macau').id, 'mo');
  assert.equal(resolveMarket('Kosovo').id, 'xk');
  assert.equal(Object.values(RESERVED_MARKET_REGISTRY).some(({ id }) => id === 'us'), false, 'active IDs must not be duplicated in reservations');
});

test('keeps deterministic apple-* fallback for a truly unknown market', () => {
  const first = resolveMarket('Example New Apple Market');
  const second = resolveMarket('Example New Apple Market');
  assert.equal(first.unknown, true);
  assert.match(first.id, /^apple-example-new-apple-market-[a-f0-9]{8}$/);
  assert.equal(second.id, first.id);
});

test('published fallback identity wins over a reservation added later', () => {
  const fallbackId = 'apple-germany-0f6a112a';
  const previousData = {
    schemaVersion: 4,
    countries: [{ country: 'Germany', marketId: fallbackId }]
  };
  const previousHistory = {
    schemaVersion: 4,
    markets: { [fallbackId]: { country: 'Germany' } }
  };
  const resolver = createPublishedMarketResolver(previousData, previousHistory);
  const resolved = resolver('Germany');
  assert.equal(resolved.id, fallbackId);
  assert.equal(resolved.preservedPublishedIdentity, true);
  assert.doesNotThrow(() => validateMarketIdentityContinuity(previousData, previousHistory));
});

test('explicit migration can move a reviewed apple-* fallback to a friendly ID atomically at payload level', async () => {
  const [prices, history] = await Promise.all([
    readFile(pricesUrl, 'utf8').then(JSON.parse),
    readFile(historyUrl, 'utf8').then(JSON.parse)
  ]);
  const sourceId = 'apple-united-states-review-test-12345678';
  const testPrices = structuredClone(prices);
  const testHistory = structuredClone(history);
  const country = testPrices.countries.find(({ marketId }) => marketId === 'us');
  assert.ok(country, 'fixture must contain the United States market');
  country.marketId = sourceId;
  testHistory.markets[sourceId] = testHistory.markets.us;
  delete testHistory.markets.us;

  const migrated = migrateMarketIdentityPayloads(testPrices, testHistory, { from: sourceId, to: 'us' });
  assert.equal(migrated.sourceName, 'United States');
  assert.equal(migrated.prices.countries.find(({ country: name }) => name === 'United States').marketId, 'us');
  assert.ok(migrated.history.markets.us);
  assert.equal(Object.hasOwn(migrated.history.markets, sourceId), false);
  assert.equal(country.marketId, sourceId, 'the pure migration helper must not mutate its inputs');
});

test('explicit migration rejects an unreviewed target or non-fallback source', async () => {
  const [prices, history] = await Promise.all([
    readFile(pricesUrl, 'utf8').then(JSON.parse),
    readFile(historyUrl, 'utf8').then(JSON.parse)
  ]);
  assert.throws(
    () => migrateMarketIdentityPayloads(prices, history, { from: 'us', to: 'de' }),
    /Only deterministic apple-\* fallback identities/
  );
});
