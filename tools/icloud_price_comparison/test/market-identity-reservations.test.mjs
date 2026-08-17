import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MARKET_REGISTRY,
  createPublishedMarketResolver,
  resolveMarket,
  validateMarketIdentityContinuity,
  validateReservedMarketRegistry
} from '../scripts/market-registry.mjs';
import { RESERVED_MARKET_REGISTRY } from '../scripts/reserved-market-registry.mjs';
import { MARKET_SEARCH_ALIASES, validateMarketSearchAliases } from '../data-model.js';

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

test('future reservations fail in CI when a friendly ID is already owned by different history', () => {
  const previousHistory = {
    schemaVersion: 4,
    markets: { de: { country: 'Legacy German Code Owner' } }
  };
  assert.throws(
    () => validateMarketIdentityContinuity(null, previousHistory),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
      && error.generatedMarketId === 'de'
      && error.newSourceName === 'Germany'
      && error.reservedOwners.some(({ sourceName }) => sourceName === 'Legacy German Code Owner')
  );
});

test('search aliases are unique, safe, and cannot shadow active or future identity codes', () => {
  const marketIds = [
    ...Object.values(MARKET_REGISTRY).map(({ id }) => id),
    ...Object.values(RESERVED_MARKET_REGISTRY).map(({ id }) => id)
  ];
  assert.equal(validateMarketSearchAliases(MARKET_SEARCH_ALIASES, marketIds), MARKET_SEARCH_ALIASES);
  assert.throws(
    () => validateMarketSearchAliases({ us: ['friendly'], gb: ['friendly'] }, marketIds),
    /belongs to both/
  );
  assert.throws(
    () => validateMarketSearchAliases({ us: ['de'] }, marketIds),
    /shadows marketId de/
  );
});

test('does not ship a routine marketId rekey tool after an identity has been published', async () => {
  await assert.rejects(
    import('../scripts/migrate-market-id.mjs'),
    (error) => error?.code === 'ERR_MODULE_NOT_FOUND'
  );
});
