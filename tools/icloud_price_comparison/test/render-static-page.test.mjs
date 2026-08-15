import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { load } from 'cheerio';
import {
  assertStaticPageMatches,
  extractStaticFragments,
  preferredDefaultTier,
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
  assert.equal($('meta[name="icloud-price-snapshot"]').attr('data-fx-stale'), String(payload.fx.stale === true));
  assert.equal($('#resultSummary').text(), `${payload.countries.length} 个地区 · ${preferredDefaultTier(payload).label} 从低到高`);
  assert.equal($('.price-table thead th[aria-sort="ascending"] i[data-lucide="arrow-up"]').length, 1);
  assert.equal(html.includes('↕'), false);
  for (const sourceName of ['China mainland', 'Japan', 'United States']) {
    assert.ok($(`.country-name-en:contains("${sourceName}")`).length, `${sourceName} must be visible in raw HTML`);
  }
  assert.ok($('#priceRows .price-local').first().text());
  assert.ok($('#priceRows .price-cny').first().text().includes('¥'));
});

test('static rendering removes minimum cues and explains rankings when FX is stale', async () => {
  const [html, current] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(pricesUrl, 'utf8').then(JSON.parse)
  ]);
  const payload = structuredClone(current);
  payload.fx.stale = true;
  payload.fx.fallbackReason = 'request-failed';
  const rendered = replaceStaticFragments(html, renderStaticFragments(payload));
  const $ = load(rendered);
  assert.equal(assertStaticPageMatches(rendered, payload), true);
  assert.equal($('.minimum-card, .minimum-badge, .is-minimum, .rank-top').length, 0);
  assert.match($('#minimumSummary').text(), /参考汇率暂未更新/);
  assert.match($('#rankingScopeNote').text(), /最近一次可用汇率/);
  assert.ok($('.price-local').first().text());
  assert.ok($('.price-cny').first().text().includes('¥'));
  assert.equal($('meta[name="icloud-price-snapshot"]').attr('data-fingerprint'), publicPayloadFingerprint(payload));
  assert.equal($('meta[name="icloud-price-snapshot"]').attr('data-fx-stale'), 'true');
});

test('static rendering uses the first tier consistently when 200GB is absent', async () => {
  const [html, current] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(pricesUrl, 'utf8').then(JSON.parse)
  ]);
  const payload = structuredClone(current);
  payload.tiers = payload.tiers.filter(({ id }) => id !== '200GB');
  for (const country of payload.countries) delete country.plans['200GB'];
  payload.run.pricePoints = payload.countries.length * payload.tiers.length;
  const defaultTier = preferredDefaultTier(payload);
  const rendered = replaceStaticFragments(html, renderStaticFragments(payload));
  const $ = load(rendered);
  assert.equal(assertStaticPageMatches(rendered, payload), true);
  assert.equal(defaultTier.id, payload.tiers[0].id);
  assert.equal($('.minimum-card.is-active-tier').length, 1);
  assert.equal($('.price-table thead th[aria-sort="ascending"]').attr('data-tier'), defaultTier.id);
  assert.equal($(`.price-cell[data-tier="${defaultTier.id}"].is-active-tier.is-sorted`).length, payload.countries.length);
  assert.equal($('#priceRows > tr > td:first-child').filter((_, cell) => load(cell).text() === '--').length, 0);
  assert.equal($('#resultSummary').text(), `${payload.countries.length} 个地区 · ${defaultTier.label} 从低到高`);
  assert.equal(rendered.includes('200GB 从低到高'), false);
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
  for (const required of ['各容量全球最低价', '全球参考排名', 'Apple 当地标价历史', '约合人民币', '价格变动次数', '数据来源', 'Apple 实际结算为准']) {
    assert.ok(html.includes(required), `raw HTML must contain ${required}`);
  }
});
