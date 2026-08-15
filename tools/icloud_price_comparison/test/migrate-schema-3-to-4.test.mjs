import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { migrateHistoryToSchema4, migratePricesSchema3To4 } from '../scripts/migrate-schema-3-to-4.mjs';
import {
  MARKET_REGISTRY,
  attachMarketIdentity,
  buildPublishedMarketIdentityIndex,
  createMarketResolver,
  createPublishedMarketResolver,
  resolveMarket,
  validateMarketIdentityContinuity,
  validateMarketRegistry
} from '../scripts/market-registry.mjs';
import { validatePriceHistoryConsistency } from '../data-contract.js';
import { getOfficialChineseMarketName } from '../scripts/country-names.mjs';

const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);
const namesUrl = new URL('../scripts/country-names.zh.json', import.meta.url);

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

test('registry resolves current known markets without requiring an active-set equality', async () => {
  const registry = validateMarketRegistry();
  const { prices } = await schema3Fixtures();
  for (const country of prices.countries) assert.equal(resolveMarket(country.country).unknown, false);
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

test('every registry identity has one marketId-keyed Chinese naming authority record', async () => {
  const names = JSON.parse(await readFile(namesUrl, 'utf8'));
  for (const market of Object.values(MARKET_REGISTRY)) {
    assert.ok(Object.hasOwn(names, market.id), market.id);
    assert.ok(names[market.id] === null || typeof names[market.id] === 'string', market.id);
    assert.equal(Object.hasOwn(market, 'zh'), false, market.canonicalName);
  }
  assert.equal(names['euro-zone'], '欧盟');
  assert.equal(names.la, '老挝', 'reviewed Apple zh-CN wording remains approved');
  assert.equal(names.mu, null);
  assert.equal(names.cg, null);
  assert.equal(getOfficialChineseMarketName('mu'), null);
  assert.equal(getOfficialChineseMarketName('cg'), null);
});

test('pending Chinese names fall back to Apple English without blocking identity attachment', () => {
  const pending = [];
  const countries = attachMarketIdentity([
    { country: 'Mauritius' },
    { country: 'Republic of Congo' },
    { country: 'New Apple Market' }
  ], { onChineseNamePending: (market, country) => pending.push({ marketId: market.id, sourceName: country.country }) });
  assert.deepEqual(countries.map(({ nameZh }) => nameZh), ['Mauritius', 'Republic of Congo', 'New Apple Market']);
  assert.deepEqual(pending.map(({ marketId }) => marketId), ['mu', 'cg', resolveMarket('New Apple Market').id]);
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
  const identity = (id, canonicalName, aliases = []) => ({ id, canonicalName, zh: canonicalName, aliases });
  const prices = (country, marketId) => ({ schemaVersion: 4, countries: [{ country, marketId }] });
  const history = (country, marketId) => ({ schemaVersion: 4, markets: { [marketId]: { country } } });
  const validateWith = (previousData, previousHistory, registry) => validateMarketIdentityContinuity(
    previousData,
    previousHistory,
    { registry, resolve: createMarketResolver(registry) }
  );

  assert.doesNotThrow(() => validateMarketIdentityContinuity(prices('Japan', 'jp'), history('Japan', 'jp')));
  const rekeyedJapan = { Japan: identity('jpn', 'Japan') };
  assert.throws(
    () => validateWith(prices('Japan', 'jp'), history('Japan', 'jp'), rekeyedJapan),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  const unknown = resolveMarket('New Apple Market');
  const registeredUnknown = { 'New Apple Market': identity(unknown.id, 'New Apple Market') };
  assert.doesNotThrow(() => validateWith(
    prices('New Apple Market', unknown.id),
    history('New Apple Market', unknown.id),
    registeredUnknown
  ));
  const rekeyedUnknown = { 'New Apple Market': identity('new-market', 'New Apple Market') };
  assert.throws(
    () => validateWith(prices('New Apple Market', unknown.id), history('New Apple Market', unknown.id), rekeyedUnknown),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  const removedRegistry = { 'Removed Market': identity('removed', 'Removed Market') };
  assert.doesNotThrow(() => validateWith(null, history('Removed Market', 'removed'), removedRegistry));
  const reservedUnknown = resolveMarket('Removed Unknown Market');
  const stolenRegistry = { 'Different New Market': identity(reservedUnknown.id, 'Different New Market') };
  assert.throws(
    () => validateWith(null, history('Removed Unknown Market', reservedUnknown.id), stolenRegistry),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  const renamedRegistry = { 'New Source Name': identity('stable-id', 'New Source Name', ['Old Source Name']) };
  assert.doesNotThrow(() => validateWith(
    prices('New Source Name', 'stable-id'),
    history('Old Source Name', 'stable-id'),
    renamedRegistry
  ));
});

test('custom registry injection automatically selects its resolver unless explicitly overridden', () => {
  const identity = (id, canonicalName) => ({ id, canonicalName, zh: canonicalName, aliases: [] });
  const prices = { schemaVersion: 4, countries: [{ country: 'Custom Market', marketId: 'custom-id' }] };
  const history = { schemaVersion: 4, markets: { 'custom-id': { country: 'Custom Market' } } };
  const validRegistry = { 'Custom Market': identity('custom-id', 'Custom Market') };
  assert.doesNotThrow(() => validateMarketIdentityContinuity(prices, history, { registry: validRegistry }));

  const rekeyedRegistry = { 'Custom Market': identity('different-id', 'Custom Market') };
  assert.throws(
    () => validateMarketIdentityContinuity(prices, history, { registry: rekeyedRegistry }),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );

  assert.doesNotThrow(() => validateMarketIdentityContinuity(prices, history, {
    registry: rekeyedRegistry,
    resolve: () => ({ ...identity('custom-id', 'Custom Market'), sourceName: 'Custom Market', unknown: false })
  }));
});

test('Euro aliases preserve the euro-zone identity and Apple Chinese display name', () => {
  for (const sourceName of ['Euro', 'Euro Zone', 'Eurozone']) {
    const market = resolveMarket(sourceName);
    assert.equal(market.id, 'euro-zone');
    assert.equal(market.nameZh, '欧盟');
    assert.equal(getOfficialChineseMarketName(market.id), '欧盟');
  }
});

test('unknown market identity is stable, distinct, and fails closed on a generated-ID collision', () => {
  const first = resolveMarket('New Apple Market');
  const repeated = resolveMarket('New Apple Market');
  const different = resolveMarket('Another Apple Market');
  assert.equal(repeated.id, first.id);
  assert.notEqual(different.id, first.id);

  const collisionId = 'apple-forced-collision-12345678';
  assert.throws(
    () => attachMarketIdentity([
      { country: 'First Unknown' },
      { country: 'Second Unknown' }
    ], {
      resolve: (sourceName) => ({
        id: collisionId,
        canonicalName: sourceName,
        sourceName,
        zh: sourceName,
        aliases: [],
        unknown: true
      })
    }),
    /marketId collision.*apple-forced-collision-12345678/
  );
});

test('published unknown identities come from schema 4 history instead of the current generator', () => {
  const previousData = { schemaVersion: 4, countries: [{ country: 'New Apple Market', marketId: 'published-custom-id' }] };
  const previousHistory = { schemaVersion: 4, markets: { 'published-custom-id': { country: 'New Apple Market' } } };
  const resolver = createPublishedMarketResolver(previousData, previousHistory, {
    resolveUnknown: (sourceName) => ({
      id: 'generator-would-change-this', canonicalName: sourceName, sourceName,
      nameZh: sourceName, aliases: [], unknown: true
    })
  });
  assert.equal(resolver('New Apple Market').id, 'published-custom-id');
  assert.equal(resolver('new apple market').id, 'published-custom-id');
  assert.equal(resolver('Brand New Market').id, 'generator-would-change-this');
});

test('historical removed unknown IDs remain reserved against a different generated identity', () => {
  const reservedId = 'apple-test-deadbeef';
  const resolver = createPublishedMarketResolver(null, {
    schemaVersion: 4,
    markets: { [reservedId]: { country: 'Old Unknown' } }
  }, {
    resolveUnknown: (sourceName) => ({
      id: reservedId, canonicalName: sourceName, sourceName,
      nameZh: sourceName, aliases: [], unknown: true
    })
  });
  assert.equal(resolver('old unknown').id, reservedId);
  assert.throws(
    () => resolver('Totally Different Market'),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
      && error.generatedMarketId === reservedId
      && error.newSourceName === 'Totally Different Market'
      && error.reservedOwners.some(({ sourceName, location }) => sourceName === 'Old Unknown' && location === 'history.json')
  );
});

test('published identity ledger fails closed when one normalized source name has two IDs', () => {
  assert.throws(
    () => buildPublishedMarketIdentityIndex(
      { schemaVersion: 4, countries: [{ country: 'Conflicted Market', marketId: 'first-id' }] },
      { schemaVersion: 4, markets: { 'second-id': { country: 'conflicted market' } } }
    ),
    (error) => error.code === 'PUBLISHED_MARKET_IDENTITY_CONFLICT'
  );
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
