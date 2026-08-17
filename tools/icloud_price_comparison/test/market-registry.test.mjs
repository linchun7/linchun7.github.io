import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MARKET_REGISTRY,
  attachMarketIdentity,
  createMarketResolver,
  createPublishedMarketResolver,
  resolveMarket,
  validateMarketIdentityContinuity,
  validateMarketRegistry
} from '../scripts/market-registry.mjs';
import { getOfficialChineseMarketNames } from '../scripts/country-names.mjs';

const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);

function fixtureCountry(country = 'New Apple Market') {
  return {
    country,
    region: 'Americas',
    currency: 'USD',
    plans: { '50GB': { price: 0.99, formattedPrice: '$0.99' } }
  };
}

test('registry resolves current known markets and generates deterministic identities for new Apple markets', () => {
  validateMarketRegistry();
  assert.equal(resolveMarket('United States').id, 'us');
  assert.equal(resolveMarket('United States of America').id, 'us');
  assert.equal(resolveMarket('Eurozone').id, 'euro-zone');
  const first = resolveMarket('New Apple Market');
  const second = resolveMarket('New Apple Market');
  assert.equal(first.unknown, true);
  assert.equal(second.id, first.id);
  assert.match(first.id, /^apple-new-apple-market-[a-f0-9]{8}$/);
});

test('every registry identity has one marketId-keyed Chinese naming authority record', () => {
  const names = getOfficialChineseMarketNames();
  const ids = Object.values(MARKET_REGISTRY).map(({ id }) => id).sort();
  assert.deepEqual(Object.keys(names).sort(), ids);
});

test('pending Chinese names fall back to Apple English without blocking identity attachment', () => {
  const pendingMapping = { ...getOfficialChineseMarketNames(), mu: null };
  const warnings = [];
  const attached = attachMarketIdentity([fixtureCountry('Mauritius')], {
    chineseNames: pendingMapping,
    onChineseNamePending: (market) => warnings.push(market.id)
  });
  assert.equal(attached[0].marketId, 'mu');
  assert.equal(attached[0].nameZh, 'Mauritius');
  assert.deepEqual(warnings, ['mu']);
});

test('committed schema 4 market identities remain continuous with the registry', async () => {
  const [prices, history] = await Promise.all([
    readFile(pricesUrl, 'utf8').then(JSON.parse),
    readFile(historyUrl, 'utf8').then(JSON.parse)
  ]);
  const result = validateMarketIdentityContinuity(prices, history);
  assert.equal(result.status, 'passed');
  assert.ok(result.reservedMarketIds.includes('jp'));
});

test('market identity continuity protects published and historical IDs', () => {
  const identity = (id, canonicalName, aliases = []) => ({ id, canonicalName, aliases });
  const prices = (country, marketId) => ({ schemaVersion: 4, countries: [{ country, marketId }] });
  const history = (country, marketId) => ({ schemaVersion: 4, markets: { [marketId]: { country } } });
  const validateWith = (previousData, previousHistory, registry) => validateMarketIdentityContinuity(
    previousData,
    previousHistory,
    { registry, resolve: createMarketResolver(registry) }
  );

  assert.doesNotThrow(() => validateMarketIdentityContinuity(prices('Japan', 'jp'), history('Japan', 'jp')));
  assert.throws(
    () => validateWith(prices('Japan', 'jp'), history('Japan', 'jp'), { Japan: identity('jpn', 'Japan') }),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  const unknown = resolveMarket('New Apple Market');
  assert.doesNotThrow(() => validateWith(
    prices('New Apple Market', unknown.id),
    history('New Apple Market', unknown.id),
    { 'New Apple Market': identity(unknown.id, 'New Apple Market') }
  ));
  assert.doesNotThrow(() => validateWith(
    prices('New Apple Market', unknown.id),
    history('New Apple Market', unknown.id),
    { 'New Apple Market': identity('new-market', 'New Apple Market') }
  ));

  assert.doesNotThrow(() => validateWith(null, history('Removed Market', 'removed'), {
    'Removed Market': identity('removed', 'Removed Market')
  }));
  const reservedUnknown = resolveMarket('Removed Unknown Market');
  assert.throws(
    () => validateWith(null, history('Removed Unknown Market', reservedUnknown.id), {
      'Different New Market': identity(reservedUnknown.id, 'Different New Market')
    }),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  assert.doesNotThrow(() => validateWith(
    prices('Old Name', 'stable'),
    history('Old Name', 'stable'),
    { 'New Name': identity('stable', 'New Name', ['Old Name']) }
  ));
});

test('custom registry injection automatically selects its resolver unless explicitly overridden', () => {
  const registry = { Example: { id: 'example', canonicalName: 'Example', aliases: [] } };
  assert.doesNotThrow(() => validateMarketIdentityContinuity(
    { schemaVersion: 4, countries: [{ country: 'Example', marketId: 'example' }] },
    { schemaVersion: 4, markets: { example: { country: 'Example' } } },
    { registry }
  ));
});

test('Euro aliases preserve the euro-zone identity and Apple Chinese display name', () => {
  for (const sourceName of ['Euro Zone', 'Euro', 'Eurozone']) {
    const attached = attachMarketIdentity([fixtureCountry(sourceName)]);
    assert.equal(attached[0].marketId, 'euro-zone');
    assert.equal(attached[0].nameZh, '欧盟');
  }
});

test('unknown market identity is stable, distinct, and fails closed on a generated-ID collision', () => {
  const one = resolveMarket('New Apple Market');
  const two = resolveMarket('Another New Apple Market');
  assert.notEqual(one.id, two.id);
  assert.equal(resolveMarket('New Apple Market').id, one.id);

  const collidingRegistry = {
    Existing: { id: one.id, canonicalName: 'Existing', aliases: [] }
  };
  const resolver = createMarketResolver(collidingRegistry);
  assert.throws(
    () => resolver('New Apple Market'),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
  );
});

test('published unknown identities come from schema 4 history instead of the current generator', () => {
  const previousHistory = {
    schemaVersion: 4,
    markets: {
      'apple-legacy-id-12345678': { country: 'New Apple Market' }
    }
  };
  const resolver = createPublishedMarketResolver(null, previousHistory);
  const resolved = resolver('New Apple Market');
  assert.equal(resolved.id, 'apple-legacy-id-12345678');
  assert.equal(resolved.published, true);
});

test('historical removed unknown IDs remain reserved against a different generated identity', () => {
  const generated = resolveMarket('Different New Market');
  const previousHistory = {
    schemaVersion: 4,
    markets: {
      [generated.id]: { country: 'Removed Old Market' }
    }
  };
  const resolver = createPublishedMarketResolver(null, previousHistory);
  assert.throws(
    () => resolver('Different New Market'),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
  );
});

test('published identity ledger fails closed when one normalized source name has two IDs', () => {
  assert.throws(
    () => createPublishedMarketResolver(
      { schemaVersion: 4, countries: [{ country: 'Same Name', marketId: 'one' }] },
      { schemaVersion: 4, markets: { two: { country: 'same name' } } }
    ),
    (error) => error.code === 'PUBLISHED_MARKET_IDENTITY_CONFLICT'
  );
});
