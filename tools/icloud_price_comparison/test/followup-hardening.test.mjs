import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { displayedPublishedDate, visiblePublicationEntries } from '../data-contract.js';
import {
  foldPublicationCountryRenames,
  marketSearchPriority,
  matchesMarketSearch,
  normalizeMarketSearchText,
} from '../data-model.js';
import {
  APPLE_ZH_ICLOUD_URL,
  compareMarketNameSets,
  extractAppleZhMarketNames,
  monitorExitCode,
  parseReviewedMarketBaseline,
  validateObservedMarketSet,
} from '../scripts/check-apple-zh-markets.mjs';
import {
  createMarketResolver,
  createPublishedMarketResolver,
  validateMarketIdentityContinuity
} from '../scripts/market-registry.mjs';
import { renderStaticFragments } from '../scripts/static-page.mjs';

test('publication presentation ignores date-only changes while preserving raw evidence', () => {
  const empty = {
    addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: []
  };
  const substantive = {
    ...empty,
    changedCountries: [{ country: 'Example', tiers: [{ id: '50GB', from: 1, to: 2 }] }]
  };
  const entries = [
    { publishedDate: 'July 17, 2026', kind: 'initial', changes: empty },
    { publishedDate: 'September 15, 2026', kind: 'change', changes: substantive },
    { publishedDate: 'September 16, 2026', kind: 'change', changes: empty }
  ];
  assert.deepEqual(
    visiblePublicationEntries(entries).map(({ publishedDate }) => publishedDate),
    ['July 17, 2026', 'September 15, 2026']
  );
  assert.equal(displayedPublishedDate({ sourcePublishedDates: entries }), 'September 15, 2026');
  assert.equal(entries.length, 3, 'presentation filtering must not mutate raw evidence');
});

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

test('Apple Chinese market monitor survives legacy headings, current-style tables, and future local groups', () => {
  const legacy = `
    <main><h2>iCloud+ 定价</h2>
      <h4>巴哈马<sup>2,3</sup>（美元）</h4><ul><li>50GB：$0.99</li><li>200GB：$2.99</li><li>2TB：$10.99</li></ul>
      <h4>中国大陆（人民币）</h4><ul><li>50GB：¥6</li><li>200GB：¥21</li><li>2TB：¥68</li></ul>
      <p>发布日期：2099 年 01 月 01 日</p>
      <p>脚注：阿根廷（美元）等其他信息不应被当成价格市场。</p>
    </main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(legacy)), new Set(['巴哈马', '中国大陆']));

  const table = `
    <main><table><thead><tr><th>国家或地区（货币）</th><th>100 GB</th><th>500 GB</th><th>4 TB</th></tr></thead>
      <tbody><tr><td>日本（日元）</td><td>¥1</td><td>¥2</td><td>¥3</td></tr>
      <tr><td>新加坡（新加坡元）</td><td>S$1</td><td>S$2</td><td>S$3</td></tr></tbody></table></main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(table)), new Set(['日本', '新加坡']));

  const future = `
    <main><section class="whatever"><div class="card"><strong>韩国</strong><div>100GB ₩1</div><div>500GB ₩2</div><div>4TB ₩3</div></div>
      <div class="card"><span>澳大利亚（澳元）</span><span>100GB $1</span><span>500GB $2</span><span>4TB $3</span></div></section>
      <section><div><h3>储存空间为 100GB 的 iCloud+</h3><p>隐藏邮件地址</p></div><div><h3>储存空间为 500GB 的 iCloud+</h3><p>自定义电子邮件域</p></div></section>
    </main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(future)), new Set(['韩国', '澳大利亚']));
});

test('Apple Chinese market monitor compares only market-name sets and ignores order or unrelated page changes', () => {
  const reviewed = ['巴哈马', '中国大陆', '日本'];
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '巴哈马', '中国大陆']), { added: [], removed: [] });
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '中国大陆', '新加坡']), { added: ['新加坡'], removed: ['巴哈马'] });
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '中国大陆']), { added: [], removed: ['巴哈马'] });
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '中国大陆', '巴哈马']), { added: [], removed: [] });
  assert.doesNotThrow(() => validateObservedMarketSet(
    Array.from({ length: 40 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
    Array.from({ length: 60 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
  ));
  assert.throws(() => validateObservedMarketSet(
    Array.from({ length: 40 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
    Array.from({ length: 20 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
  ), /coverage/i);
  assert.throws(() => validateObservedMarketSet(
    Array.from({ length: 40 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
    Array.from({ length: 20 }, (_, index) => `完全不同${String.fromCharCode(0x5000 + index)}`),
  ), /overlap/i);
});

test('Apple Chinese market monitor fails its own workflow on changes or unavailable fetches', () => {
  assert.equal(monitorExitCode({ status: 'unchanged' }), 0);
  assert.equal(monitorExitCode({ status: 'changed' }), 1);
  assert.equal(monitorExitCode({ status: 'unavailable' }), 1);
  assert.equal(monitorExitCode(null), 1);
});

test('reviewed Chinese page baseline is a sticky history of approved names, independent from marketId mapping', async () => {
  const baseline = JSON.parse(await readFile(new URL('../scripts/apple-zh-reviewed-markets.json', import.meta.url), 'utf8'));
  const names = parseReviewedMarketBaseline(baseline);
  assert.equal(baseline.source, APPLE_ZH_ICLOUD_URL);
  assert.ok(names.includes('刚果共和国'));
  assert.ok(names.includes('老挝'));
  assert.ok(names.includes('毛里求斯'));
  assert.ok(names.includes('莫尔多瓦'));
  assert.equal(names.includes('摩尔多瓦'), false);
});

test('publication UI projection folds only a one-to-one reviewed rename anchored to the current stable market', () => {
  const raw = {
    addedCountries: [
      { country: "Cote D'Ivoire", nameZh: '科特迪瓦' },
      { country: 'New Market', nameZh: 'New Market' },
    ],
    removedCountries: [{ country: 'Ivory Coast', nameZh: '科特迪瓦' }],
    changedCountries: [{ country: 'Pakistan', nameZh: '巴基斯坦', fromRegion: 'Europe, Middle East & Africa', toRegion: 'Asia Pacific' }],
  };
  const display = foldPublicationCountryRenames(raw, [
    { marketId: 'ci', country: "Cote D'Ivoire", nameZh: '科特迪瓦' },
    { marketId: 'us', country: 'United States', nameZh: '美国' },
  ]);
  assert.deepEqual(display.renamedCountries, [{ from: 'Ivory Coast', to: "Cote D'Ivoire", nameZh: '科特迪瓦', marketId: 'ci' }]);
  assert.deepEqual(display.addedCountries, [{ country: 'New Market', nameZh: 'New Market' }]);
  assert.deepEqual(display.removedCountries, []);
  assert.equal(raw.addedCountries.length, 2, 'raw publication evidence remains untouched');
  assert.deepEqual(foldPublicationCountryRenames(raw, []).renamedCountries, [], 'no current stable market means no rename folding');

  const unreviewedSameName = {
    addedCountries: [{ country: 'New Name', nameZh: '同名地区' }],
    removedCountries: [{ country: 'Old Name', nameZh: '同名地区' }],
  };
  assert.deepEqual(
    foldPublicationCountryRenames(unreviewedSameName, [{ marketId: 'example', country: 'New Name', nameZh: '同名地区' }]).renamedCountries,
    [],
    'matching display names alone must never imply one stable identity'
  );
});

test('Chinese market monitor is an isolated read-only service triggered after the price updater', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/monitor-icloud-zh-markets.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*?Update iCloud prices[\s\S]*?completed/);
  assert.match(workflow, /permissions:[\s\S]*?contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/check-apple-zh-markets\.mjs/);
  const updater = await readFile(new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(updater, /check-apple-zh-markets\.mjs/);
  const monitorSource = await readFile(new URL('../scripts/check-apple-zh-markets.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(monitorSource, /readFile\([^)]*country-names\.zh\.json|\bwriteFile\b/);
  assert.match(monitorSource, /仅提示人工复核，不自动修改中文名称/);
  assert.match(monitorSource, /process\.exitCode = monitorExitCode\(result\)/);
});
