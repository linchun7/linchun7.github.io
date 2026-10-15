import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { displayedPublishedDate, visiblePublicationEntries, validateMinimumHistoryPayload, validatePayload, assertValidatedPriceHistoryConsistency } from '../data-contract.js';
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

test('reviewed Chinese page names are sticky history, independent from marketId mapping', async () => {
  const baseline = JSON.parse(await readFile(new URL('../scripts/apple-zh-reviewed-markets.json', import.meta.url), 'utf8'));
  const names = parseReviewedMarketBaseline(baseline);
  assert.equal(baseline.source, APPLE_ZH_ICLOUD_URL);
  assert.ok(names.includes('刚果共和国'));
  assert.ok(names.includes('老挝'));
  assert.ok(names.includes('毛里求斯'));
  assert.ok(names.includes('莫尔多瓦'));
  assert.ok(names.includes('摩尔多瓦'), 'newly reviewed wording must coexist with historical spelling');
  const displayNames = JSON.parse(await readFile(new URL('../scripts/country-names.zh.json', import.meta.url), 'utf8'));
  assert.equal(displayNames.cg, '刚果共和国', 'explicit human-reviewed binding now exists');
  assert.equal(displayNames.mu, '毛里求斯', 'explicit human-reviewed binding now exists');
  const futureName = '尚未复核测试地区';
  assert.equal(names.includes(futureName), false);
  assert.deepEqual(compareMarketNameSets(names, [...names, futureName]), { added: [futureName], removed: [] });
  assert.deepEqual(compareMarketNameSets(names, names.filter((name) => name !== '莫尔多瓦')), {
    added: [], removed: ['莫尔多瓦']
  });
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


test('review: Chinese market labels support mixed Unicode footnotes without stripping interior digits', () => {
  for (const label of ['巴哈马²𝄒³（美元）', '巴哈马²,³（美元）', '巴哈马<sup>2,3</sup>（美元）', '巴哈马（美元）']) {
    const table = `<main><table><thead><tr><th>国家或地区（货币）</th><th>50 GB</th><th>200 GB</th></tr></thead><tbody><tr><td>${label}</td><td>$0.99</td><td>$2.99</td></tr></tbody></table></main>`;
    assert.deepEqual(extractAppleZhMarketNames(table), ['巴哈马'], label);
    const legacy = `<main><h4>${label}</h4><ul><li>50GB：$0.99</li><li>200GB：$2.99</li><li>2TB：$10.99</li></ul></main>`;
    assert.deepEqual(extractAppleZhMarketNames(legacy), ['巴哈马'], label);
  }
  const invalid = `<main><table><thead><tr><th>国家或地区（货币）</th><th>50 GB</th></tr></thead><tbody><tr><td>巴2哈马（美元）</td><td>$0.99</td></tr></tbody></table></main>`;
  assert.throws(() => extractAppleZhMarketNames(invalid), /Chinese market table contains an empty or unexplained country cell/);
});

test('minimum history uses a short guarded FX-gap badge without changing raw evidence', async () => {
  const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
  const match = source.match(/function minimumHistoryCauseLabel\(event\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const label = runInNewContext('(' + match[0] + ')', { MINIMUM_CAUSE_LABELS: {unknown:'原因未确定',fx:'汇率变化'} });
  const evidence = {pricesChanged:false,scopeChanged:false,basisChanged:false,fxChanged:true,gap:true};
  const event = {cause:'unknown',evidence};
  const before = JSON.stringify(event);
  assert.equal(label(event),'汇率等因素');
  for (const [key,value] of [['pricesChanged',true],['scopeChanged',true],['basisChanged',true],['fxChanged',false],['fxChanged',null],['gap',false],['pricesChanged','false']]) {
    assert.equal(label({cause:'unknown',evidence:{...evidence,[key]:value}}),'原因未确定');
  }
  assert.equal(label({cause:'unknown',evidence:{}}),'原因未确定');
  assert.equal(label({cause:'fx',evidence}),'汇率变化');
  assert.equal(JSON.stringify(event),before);
  assert.match(source,/minimumHistoryNode\('span', minimumHistoryCauseLabel\(event\), 'minimum-history-cause'\)/);
});


test('four date helpers reuse three fixed formatters without changing date semantics', async () => {
  const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
  const names = ['formatDate', 'formatBeijingDateTime', 'formatBeijingDate', 'formatPublishedDate'];
  const declarations = ['dateFormatter', 'beijingDateTimeFormatter', 'beijingDateFormatter'].map(name => {
    const match = source.match(new RegExp('const ' + name + ' = new Intl\\.DateTimeFormat\\([^]*?\\n\\}\\);'));
    assert.ok(match, name);
    return match[0];
  });
  const functions = names.map(name => {
    const match = source.match(new RegExp('function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, name);
    return match[0];
  });
  let constructions = 0;
  class CountedDateTimeFormat extends Intl.DateTimeFormat {
    constructor(...args) { super(...args); constructions += 1; }
  }
  const api = runInNewContext(
    [...declarations, ...functions, '({ ' + names.join(', ') + ' })'].join('\n'),
    { Intl: { DateTimeFormat: CountedDateTimeFormat }, Date },
  );
  assert.equal(constructions, 3, 'UTC date-only helpers share the same formatter');
  const utc = new Intl.DateTimeFormat('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', timeZone:'UTC' });
  const beijing = new Intl.DateTimeFormat('zh-CN', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit',
    minute:'2-digit', hour12:false, timeZone:'Asia/Shanghai',
  });
  for (let repeat = 0; repeat < 25; repeat += 1) {
    for (const name of names) assert.equal(api[name](null), '--', name);
    assert.equal(api.formatDate('2026-10-01T23:59:59-07:00'), utc.format(new Date('2026-10-01T00:00:00Z')));
    assert.throws(() => api.formatDate('invalid'), /Invalid time value/);
    assert.equal(api.formatBeijingDateTime('2026-10-01T16:00:00Z'), beijing.format(new Date('2026-10-01T16:00:00Z')));
    assert.equal(api.formatBeijingDateTime('invalid'), '--');
    assert.equal(api.formatBeijingDate('2026-10-01T15:59:59Z'), '2026-10-01');
    assert.equal(api.formatBeijingDate('2026-10-01T16:00:00Z'), '2026-10-02');
    assert.equal(api.formatBeijingDate('invalid'), '--');
    assert.equal(api.formatPublishedDate('Published date: October 1, 2026'), utc.format(new Date('2026-10-01T00:00:00Z')));
    assert.equal(api.formatPublishedDate('2026-10-01T23:00:00-07:00'), utc.format(new Date('2026-10-02T06:00:00Z')));
    assert.equal(api.formatPublishedDate('Published date: unknown'), 'unknown');
  }
  assert.equal(constructions, 3, 'repeated renders must not construct more formatters');
});

test('country and minimum history preserve their deliberately different snapshot acceptance', async () => {
  const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
  const [prices, countryHistory, minimumHistory] = await Promise.all([
    readFile(new URL('../data/prices.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../data/history.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../data/minimum-history.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const futureCountry = structuredClone(countryHistory);
  futureCountry.updatedAt = new Date(Date.parse(prices.generatedAt) + 1).toISOString();
  const laterMinimum = structuredClone(minimumHistory);
  laterMinimum.checkedAt = new Date(Math.max(Date.parse(prices.generatedAt), Date.parse(minimumHistory.checkedAt)) + 1000).toISOString();
  laterMinimum.pendingGap = true;
  laterMinimum.excludedVersions += 1;
  assert.equal(validateMinimumHistoryPayload(laterMinimum), laterMinimum);
  class SnapshotDate extends Date {
    static now() { throw new Error('Frontend acceptance must not read the device clock'); }
  }
  const state = { data:prices, history:null, historyStatus:'idle', historyRequestId:0, historyPromise:null };
  const minimumHistoryUi = { data:structuredClone(minimumHistory), status:'ready', promise:null };
  let countryFetches = 0;
  let nextMinimum = laterMinimum;
  const functions = ['ensureHistoryLoaded', 'loadMinimumHistory'].map(name => {
    const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, name);
    return match[0].replaceAll('import.meta.url', 'moduleUrl');
  });
  const api = runInNewContext(
    [...functions, '({ ensureHistoryLoaded, loadMinimumHistory })'].join('\n'), {
      state, minimumHistoryUi, Date:SnapshotDate, URL, AbortController, setTimeout, clearTimeout,
      moduleUrl: new URL('../script.js', import.meta.url).href,
      REQUEST_TIMEOUT_MS:8000,
      assertValidatedPriceHistoryConsistency, validateMinimumHistoryPayload,
      fetchJson:async () => { countryFetches += 1; return validatePayload('history.json', futureCountry); },
      fetch:async () => ({ ok:true, headers:{get:() => 'application/json'}, payload:nextMinimum }),
      readBoundedJsonResponse:async response => response.payload,
      refreshOpenHistoryViews:() => {}, renderMinimumHistory:() => {}, renderMinimumHistoryStatus:() => {},
      console:{warn:() => {}},
    },
  );
  assert.equal(await api.ensureHistoryLoaded(), null);
  assert.equal(countryFetches, 2, 'incompatible country history gets one forced-refresh retry');
  assert.equal(state.history, null);
  assert.equal(state.historyStatus, 'unavailable');
  await api.loadMinimumHistory();
  assert.equal(minimumHistoryUi.status, 'ready');
  assert.equal(minimumHistoryUi.data, laterMinimum, 'later independent minimum evidence is accepted');

  // Structurally valid responses still cannot roll back accepted checked time or checkpoint.
  for (const checkedAt of [minimumHistory.checkedAt, laterMinimum.checkedAt]) {
    nextMinimum = {
      schemaVersion:1, projectSince:minimumHistory.projectSince, firstObservedAt:null, checkedAt,
      observations:0, excludedVersions:1, pendingGap:true, gaps:[], events:[], checkpoint:null,
    };
    assert.equal(validateMinimumHistoryPayload(nextMinimum), nextMinimum);
    await api.loadMinimumHistory();
    assert.equal(minimumHistoryUi.status, 'error');
    assert.equal(minimumHistoryUi.data, laterMinimum, 'failure retains the accepted record');
    assert.equal(minimumHistoryUi.promise, null);
  }
});

test('history loading validates each response once and retries only cross-file mismatches', async () => {
  const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
  const [prices, history] = await Promise.all([
    readFile(new URL('../data/prices.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../data/history.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  validatePayload('prices.json', prices);
  const inconsistent = structuredClone(history);
  inconsistent.sourcePublishedDates = inconsistent.sourcePublishedDates.slice(0, 1);
  assert.ok(history.sourcePublishedDates.length > 1);
  const malformed = structuredClone(history);
  Object.values(malformed.markets)[0].events[0].currency = 'bad';
  const legacy = { ...history, schemaVersion: 2 };
  const functions = ['fetchJson', 'ensureHistoryLoaded'].map(name => {
    const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
    assert.ok(match, name);
    return match[0];
  });
  const scenarios = [
    { responses: [history], caches: ['default'], checks: 1, accepted: true },
    { responses: [inconsistent, history], caches: ['default', 'reload'], checks: 2, accepted: true },
    { responses: [inconsistent, inconsistent], caches: ['default', 'reload'], checks: 2 },
    { responses: [malformed, history], caches: ['default'], checks: 0 },
    { responses: [legacy, history], caches: ['default'], checks: 0 },
  ];
  for (const scenario of scenarios) {
    const acceptedBefore = structuredClone(history);
    const state = { data: prices, history: acceptedBefore, historyStatus: 'idle', historyRequestId: 0 };
    const caches = [];
    let structureChecks = 0;
    let relationshipChecks = 0;
    let historyPasses = 0;
    let pricePasses = 0;
    prices.countries[Symbol.iterator] = function* () {
      pricePasses += 1;
      yield* Array.prototype.values.call(this);
    };
    const api = runInNewContext(
      [...functions, '({ ensureHistoryLoaded })'].join('\n'), {
        state, AbortController, setTimeout, clearTimeout, REQUEST_TIMEOUT_MS: 8000,
        fetch: async (_url, options) => {
          const payload = structuredClone(scenario.responses[caches.length]);
          caches.push(options.cache);
          const events = Object.values(payload.markets)[0].events;
          events[Symbol.iterator] = function* () {
            historyPasses += 1;
            yield* Array.prototype.values.call(this);
          };
          return { ok: true, payload };
        },
        readBoundedJsonResponse: async response => response.payload,
        validatePayload: (name, payload) => { structureChecks += 1; return validatePayload(name, payload); },
        assertValidatedPriceHistoryConsistency: (data, payload) => {
          relationshipChecks += 1;
          return assertValidatedPriceHistoryConsistency(data, payload);
        },
        refreshOpenHistoryViews: () => {}, console: { warn: () => {} },
      },
    );
    const result = await api.ensureHistoryLoaded();
    assert.deepEqual(caches, scenario.caches);
    assert.equal(structureChecks, scenario.caches.length);
    assert.equal(relationshipChecks, scenario.checks);
    assert.equal(pricePasses, scenario.checks, 'validated prices get only the latest-value relationship pass');
    if (scenario.accepted) {
      assert.equal(historyPasses, scenario.caches.length, 'each history event list is structurally traversed once');
      assert.equal(result, state.history);
      assert.equal(state.historyStatus, 'ready');
      await api.ensureHistoryLoaded();
      assert.deepEqual(caches, scenario.caches, 'accepted history is reused');
    } else {
      assert.equal(result, null);
      assert.equal(state.history, acceptedBefore, 'failure preserves accepted history');
      assert.equal(state.historyStatus, 'unavailable');
    }
    assert.equal(state.historyPromise, null);
  }
});
