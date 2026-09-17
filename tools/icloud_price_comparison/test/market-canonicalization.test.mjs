import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachMarketIdentity,
  createPublishedMarketResolver,
  resolveMarket
} from '../scripts/market-registry.mjs';

function sourceMarket(country) {
  return {
    country,
    region: 'Asia Pacific',
    currency: 'CNY',
    plans: { '50GB': { price: 6, formattedPrice: '¥6' } }
  };
}

test('reviews transient Apple China spelling as the stable China mainland identity', () => {
  const resolved = resolveMarket('China');
  assert.equal(resolved.id, 'cn');
  assert.equal(resolved.canonicalName, 'China mainland');
  assert.equal(resolved.unknown, false);

  const [attached] = attachMarketIdentity([sourceMarket('China')]);
  assert.equal(attached.marketId, 'cn');
  assert.equal(attached.country, 'China mainland');
  assert.equal(attached.nameZh, '中国大陆');
});

test('canonicalizes a reviewed alias against the published stable identity ledger', () => {
  const previousData = {
    schemaVersion: 4,
    countries: [{ country: 'China mainland', marketId: 'cn' }]
  };
  const previousHistory = {
    schemaVersion: 4,
    markets: { cn: { country: 'China mainland' } }
  };
  const resolve = createPublishedMarketResolver(previousData, previousHistory);
  const [attached] = attachMarketIdentity([sourceMarket('China')], { resolve });
  assert.equal(attached.marketId, 'cn');
  assert.equal(attached.country, 'China mainland');
});

test('keeps genuinely unknown Apple market names uncanonicalized and reviewable', () => {
  const warnings = [];
  const [attached] = attachMarketIdentity([sourceMarket('Future Test Market')], {
    onUnknown: (market) => warnings.push(market.sourceName)
  });
  assert.equal(attached.country, 'Future Test Market');
  assert.match(attached.marketId, /^apple-future-test-market-/);
  assert.deepEqual(warnings, ['Future Test Market']);
});
