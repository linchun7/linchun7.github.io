import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  marketSearchPriority,
  matchesMarketSearch,
  normalizeMarketSearchText,
} from '../data-model.js';
import {
  createMarketResolver,
  createPublishedMarketResolver,
  validateMarketIdentityContinuity
} from '../scripts/market-registry.mjs';
import { renderStaticFragments } from '../scripts/static-page.mjs';

test('search normalization covers compatibility forms and both raw/localized region labels', () => {
  const us = { marketId: 'us', country: 'United States', nameZh: '美国', region: 'Americas', currency: 'USD' };
  const cn = { marketId: 'cn', country: 'China mainland', nameZh: '中国大陆', region: 'Asia Pacific', currency: 'CNY' };
  const ng = { marketId: 'ng', country: 'Nigeria', nameZh: '尼日利亚', region: 'Europe, Middle East & Africa', currency: 'NGN' };
  assert.equal(normalizeMarketSearchText(' ＵＳ '), 'us');
  assert.equal(matchesMarketSearch(us, 'ＵＳ'), true);
  assert.equal(marketSearchPriority(us, 'ＵＳ'), 2);
  assert.equal(matchesMarketSearch(cn, '中'), true);
  assert.equal(matchesMarketSearch(ng, '中'), false);
  assert.equal(matchesMarketSearch(ng, '中东'), true);
  assert.equal(matchesMarketSearch(ng, 'Middle East'), true);
  assert.equal(matchesMarketSearch(us, 'Americas'), true);
  assert.equal(matchesMarketSearch(cn, 'Asia Pacific'), true);
});

test('reviewed Apple source aliases preserve an already-published fallback identity', () => {
  const fallbackId = 'apple-legacy-raw-name-12345678';
  const registry = {
    'Reviewed Name': { id: fallbackId, canonicalName: 'Reviewed Name', aliases: ['Legacy Raw Name'], reserved: false }
  };
  const resolve = createMarketResolver(registry);
  const previousHistory = {
    schemaVersion: 4,
    markets: { [fallbackId]: { country: 'Legacy Raw Name' } }
  };
  const resolver = createPublishedMarketResolver(null, previousHistory, { registry, resolveUnknown: resolve });
  const resolved = resolver('Reviewed Name');
  assert.equal(resolved.id, fallbackId);
  assert.equal(resolved.published, true);
  assert.equal(resolved.unknown, false);
  assert.doesNotThrow(() => validateMarketIdentityContinuity(null, previousHistory, { registry, resolve }));
});

test('different identities claiming the same historical ID use the collision error family', () => {
  const registry = {
    'New Owner': { id: 'stable-id', canonicalName: 'New Owner', aliases: [], reserved: false }
  };
  const resolve = createMarketResolver(registry);
  const previousHistory = {
    schemaVersion: 4,
    markets: { 'stable-id': { country: 'Old Owner' } }
  };
  assert.throws(
    () => validateMarketIdentityContinuity(null, previousHistory, { registry, resolve }),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
  );
});

test('static fallback includes an assistive mobile rank label separate from the visual badge', async () => {
  const payload = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
  const fragments = renderStaticFragments(payload);
  const html = typeof fragments === 'string' ? fragments : Object.values(fragments).join('\n');
  assert.match(html, /mobile-rank[^>]*aria-hidden="true"/);
  assert.match(html, /mobile-rank-sr visually-hidden[^>]*>全球价格排名第 /);
});
