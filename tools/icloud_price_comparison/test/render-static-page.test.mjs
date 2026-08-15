import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { load } from 'cheerio';
import {
  assertStaticPageMatches,
  extractStaticFragments,
  publicPayloadFingerprint,
  renderStaticFragments,
  replaceStaticFragments
} from '../scripts/static-page.mjs';

const indexUrl = new URL('../index.html', import.meta.url);
const pricesUrl = new URL('../data/prices.json', import.meta.url);

test('committed raw HTML is the deterministic projection of validated prices', async () => {
  const [html, payload] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(pricesUrl, 'utf8').then(JSON.parse)
  ]);
  assert.equal(assertStaticPageMatches(html, payload), true);
  assert.equal(replaceStaticFragments(html, renderStaticFragments(payload)), html);
  const $ = load(html);
  assert.equal($('#priceRows > tr[data-market-id]').length, payload.countries.length);
  assert.equal($('.price-table thead th[data-tier-header]').length, payload.tiers.length);
  assert.equal($('.price-cell').length, payload.countries.length * payload.tiers.length);
  assert.equal($('.minimum-card').length, payload.tiers.length);
  assert.equal($('meta[name="icloud-price-snapshot"]').attr('content'), payload.generatedAt);
  assert.equal($('meta[name="icloud-price-snapshot"]').attr('data-fingerprint'), publicPayloadFingerprint(payload));
  for (const sourceName of ['China mainland', 'Japan', 'United States']) {
    assert.ok($(`.country-name-en:contains("${sourceName}")`).length, `${sourceName} must be visible in raw HTML`);
  }
  assert.ok($('#priceRows .price-local').first().text());
  assert.ok($('#priceRows .price-cny').first().text().includes('¥'));
});

test('static renderer rejects missing, duplicate, and hand-edited generated regions', async () => {
  const [html, payload] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(pricesUrl, 'utf8').then(JSON.parse)
  ]);
  assert.throws(() => extractStaticFragments(html.replace('<!-- ICLOUD_STATIC_STATUS:END -->', '')), /STATIC_RENDER_MARKER_INVALID:STATUS/);
  assert.throws(() => extractStaticFragments(html.replace('<!-- ICLOUD_STATIC_STATUS:START -->', '<!-- ICLOUD_STATIC_STATUS:START --><!-- ICLOUD_STATIC_STATUS:START -->')), /STATIC_RENDER_MARKER_INVALID:STATUS/);
  assert.throws(() => assertStaticPageMatches(html.replace('United States · USD', 'United States · EUR'), payload), /STATIC_RENDER_MISMATCH:TABLE_BODY/);
});

test('raw product copy avoids engineering-only loading and cache language', async () => {
  const html = await readFile(indexUrl, 'utf8');
  for (const forbidden of ['等待价格数据', '正在加载价格数据', '本地缓存', '7 天有效期', '允许的未来偏差', 'Rates By Exchange Rate API', '页面发布日期', '累计价格变更']) {
    assert.ok(!html.includes(forbidden), `raw HTML must not contain ${forbidden}`);
  }
  for (const required of ['各容量全球最低价', '全球参考排名', 'Apple 当地标价历史', '约合人民币', '价格变动次数', '数据来源与说明']) {
    assert.ok(html.includes(required), `raw HTML must contain ${required}`);
  }
});
