import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { APPLE_ZH_ICLOUD_URL, extractAppleZhMarketNames, parseReviewedMarketBaseline, runAppleZhMarketMonitor } from '../scripts/check-apple-zh-markets.mjs';
import { foldPublicationCountryRenames } from '../data-model.js';
import { buildPresentationMarketChanges } from '../scripts/update-prices.mjs';

const prices = '<ul><li>50GB：¥6</li><li>200GB：¥21</li><li>2TB：¥68</li></ul>';
const table = (rows, header = '<th>国家或地区（货币）</th><th>50GB</th><th>200GB</th>') => `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
const row = (name) => `<tr><td>${name}</td><td>¥6</td><td>¥21</td></tr>`;

test('seal: feature headings and capacity cards are not new Chinese markets', () => {
  const html = `<main><h2>家庭共享（最多五人）</h2><p>与家人分享服务。</p><div><strong>隐藏邮件地址</strong><p>50GB 方案与 200GB 方案均可使用</p></div><h3>日本（日元）</h3>${prices}<h3>中国大陆（人民币）</h3>${prices}</main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(html)), new Set(['日本', '中国大陆']));
});

test('seal: country column reordering does not ingest feature-table rows', () => {
  const html = `<main>${table('<tr><td>¥21</td><td>日本（日元）</td><td>¥6</td></tr>', '<th>200GB</th><th>国家/地区（货币）</th><th>50GB</th>')}${table('<tr><td>家庭共享</td><td>支持</td><td>支持</td></tr>', '<th>功能</th><th>50GB</th><th>200GB</th>')}</main>`;
  assert.deepEqual(extractAppleZhMarketNames(html), ['日本']);
});

test('seal: an empty country cell is unavailable, never a plausible market deletion', () => {
  assert.throws(() => extractAppleZhMarketNames(`<main>${table(row('日本（日元）') + row('') + row('韩国（韩元）'))}</main>`), /market|country|地区|国家|incomplete|unexplained/i);
});

test('seal: arbitrary wrappers, h1 labels and symbolic superscript footnotes preserve names', () => {
  const html = `<main><price-market><header><h1>日本<sup>*</sup>（日元）</h1></header><price-values>${prices}</price-values></price-market><price-market><label><span>中国大陆</span>（人民币）<sup>†</sup></label><price-values>${prices}</price-values></price-market></main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(html)), new Set(['日本', '中国大陆']));
});

test('seal: table footnotes never become countries', () => {
  const html = `<main><table><thead><tr><th>国家或地区</th><th>50GB</th><th>200GB</th></tr></thead><tbody>${row('日本')}</tbody><tfoot><tr><td colspan="3">更多信息</td></tr></tfoot></table></main>`;
  assert.deepEqual(extractAppleZhMarketNames(html), ['日本']);
});

test('seal: reviewed baseline schema is independent of extraction guesses and rejects coercion', () => {
  assert.deepEqual(parseReviewedMarketBaseline({ source: APPLE_ZH_ICLOUD_URL, markets: ['示例地区（辖区）', '新地区甲'] }), ['示例地区(辖区)', '新地区甲']);
  assert.throws(() => parseReviewedMarketBaseline({ source: APPLE_ZH_ICLOUD_URL, markets: [true] }), /name|string|名称/i);
});

test('seal: response size limit aborts the stream before it has been buffered', async () => {
  let reads = 0;
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { reads += 1; if (reads > 24) controller.close(); else controller.enqueue(new Uint8Array(256 * 1024).fill(32)); }, cancel() { cancelled = true; } });
  const result = await runAppleZhMarketMonitor({ fetchImpl: async () => new Response(stream), report: false });
  assert.equal(result.status, 'unavailable');
  assert.ok(reads <= 11, `oversized body consumed ${reads} chunks`);
  assert.equal(cancelled, true);
});

test('seal: real CLI exit codes and summary distinguish unchanged, changed, HTTP failure and malformed partial tables', async () => {
  const root = new URL('../', import.meta.url);
  const baseline = JSON.parse(await readFile(new URL('scripts/apple-zh-reviewed-markets.json', root), 'utf8'));
  const protectedPaths = ['scripts/apple-zh-reviewed-markets.json', 'scripts/country-names.zh.json', 'data/prices.json', 'data/history.json', 'data/run-log.json'];
  const before = await Promise.all(protectedPaths.map((path) => readFile(new URL(path, root), 'utf8')));
  const directory = await mkdtemp(join(tmpdir(), 'icloud-seal-cli-'));
  try {
    const cases = [
      { title: 'unchanged', names: baseline.markets, code: 0, summary: /未发现新的中文地区名称/ },
      { title: 'removed-only', names: baseline.markets.slice(1), code: 0, summary: /不告警/ },
      { title: 'changed', names: [...baseline.markets.slice(1), '新增测试岛'], code: 1, summary: /新增测试岛/ },
      { title: 'http-unavailable', http: 503, code: 1, summary: /不可用/ },
      { title: 'partial-unavailable', names: ['', ...baseline.markets.slice(1)], code: 1, summary: /不可用/ },
    ];
    for (const entry of cases) {
      const html = `<main>${table((entry.names ?? []).map(row).join(''))}</main>${' '.repeat(1000)}`;
      const setup = `globalThis.fetch = async () => new Response(${JSON.stringify(html)}, {status:${entry.http ?? 200}});`;
      const summary = join(directory, `${entry.title}.md`);
      const child = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(setup)}`, fileURLToPath(new URL('scripts/check-apple-zh-markets.mjs', root))], { env: { ...process.env, GITHUB_STEP_SUMMARY: summary }, encoding: 'utf8', timeout: 20000, windowsHide: true });
      assert.equal(child.error, undefined);
      assert.equal(child.status, entry.code, `${entry.title}: ${child.stderr}\n${child.stdout}`);
      assert.match(await readFile(summary, 'utf8'), entry.summary);
    }
    assert.deepEqual(await Promise.all(protectedPaths.map((path) => readFile(new URL(path, root), 'utf8'))), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('seal: reviewed aliases use the same UI and Action rename projection', () => {
  const raw = { addedCountries: [{ country: 'Türkiye', nameZh: '土耳其' }, { country: 'New Market' }], removedCountries: [{ country: 'Turkey', nameZh: '土耳其' }, { country: 'Removed Market' }], changedCountries: [{ country: 'Pakistan', fromRegion: 'Europe, Middle East & Africa', toRegion: 'Asia Pacific' }] };
  const before = structuredClone(raw);
  const previous = { countries: [{ marketId: 'tr', country: 'Turkey', nameZh: '土耳其' }] };
  const current = [{ marketId: 'tr', country: 'Türkiye', nameZh: '土耳其' }];
  const ui = foldPublicationCountryRenames(raw, current);
  const action = buildPresentationMarketChanges(previous, current, raw);
  assert.deepEqual(ui.renamedCountries, [{ marketId: 'tr', from: 'Turkey', to: 'Türkiye', nameZh: '土耳其' }]);
  assert.deepEqual(action.renamedCountries.map(({ fromCountry: from, toCountry: to, ...rest }) => ({ ...rest, from, to })), ui.renamedCountries);
  assert.deepEqual(ui.addedCountries, [{ country: 'New Market' }]);
  assert.deepEqual(ui.removedCountries, [{ country: 'Removed Market' }]);
  assert.deepEqual(ui.changedCountries, before.changedCountries);
  assert.deepEqual(raw, before);
});

test('seal: historical rename display survives another reviewed current spelling', () => {
  const raw = { addedCountries: [{ country: "Cote D'Ivoire" }], removedCountries: [{ country: 'Ivory Coast' }] };
  assert.deepEqual(foldPublicationCountryRenames(raw, [{ marketId: 'ci', country: 'Côte d’Ivoire', nameZh: '科特迪瓦' }]).renamedCountries, [{ from: 'Ivory Coast', to: "Cote D'Ivoire", nameZh: '科特迪瓦', marketId: 'ci' }]);
});

test('seal: ambiguous duplicate stable identities never fold in the Action or browser', () => {
  const raw = { addedCountries: [{ country: "Cote D'Ivoire" }], removedCountries: [{ country: 'Ivory Coast' }] };
  const current = [{ marketId: 'ci', country: "Cote D'Ivoire" }, { marketId: 'ci', country: 'Ivory Coast' }];
  assert.deepEqual(foldPublicationCountryRenames(raw, current).renamedCountries, []);
  assert.deepEqual(buildPresentationMarketChanges({ countries: [{ marketId: 'ci', country: 'Ivory Coast' }] }, current, raw).renamedCountries, []);
});

test('seal: monitor workflow rejects non-main dispatch and foreign upstream instead of a skipped green check', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/monitor-icloud-zh-markets.yml', import.meta.url), 'utf8');
  const block = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/);
  assert.ok(block, 'explicit executable trust gate must precede checkout');
  assert.ok(workflow.indexOf(block[0]) < workflow.indexOf('uses: actions/checkout@'));
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /if: failure\(\)[\s\S]*GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(workflow, /continue-on-error|secrets\.|contents: write|pages: write/);
  const base = { MONITOR_REF: 'refs/heads/main', MONITOR_EVENT: 'workflow_run', MONITOR_REPOSITORY: 'owner/site', UPSTREAM_REPOSITORY: 'owner/site', UPSTREAM_BRANCH: 'main' };
  for (const [env, expected] of [[base, 0], [{ ...base, MONITOR_EVENT: 'workflow_dispatch' }, 0], [{ ...base, MONITOR_EVENT: 'workflow_dispatch', MONITOR_REF: 'refs/heads/review' }, 1], [{ ...base, UPSTREAM_REPOSITORY: 'attacker/site' }, 1], [{ ...base, UPSTREAM_BRANCH: 'untrusted' }, 1]]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', block[1]], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, expected, result.stderr);
  }
});

test('seal: price, tier, order, repetition and non-target country tables do not change monitored sets', () => {
  const original = `<main><h3>日本（日元）</h3>${prices}<h3>韩国（韩元）</h3>${prices}</main>`;
  const expected = new Set(extractAppleZhMarketNames(original));
  const variants = [
    `<main><h6>韩国（别的货币）</h6><ol><li>123 PB：0.01</li></ol><h1>日本（日元）</h1><x-values>250 GB：999,999.99</x-values></main>`,
    `<main>${table(row('韩国') + row('日本') + row('韩国'))}<time>2099-12-31</time></main>`,
    `<main>${table(row('日本') + row('韩国'))}${table('<tr><td>功能测试岛</td><td>支持</td></tr>', '<th>国家或地区</th><th>家庭共享</th>')}</main>`,
  ];
  for (const html of variants) assert.deepEqual(new Set(extractAppleZhMarketNames(html)), expected);
});

test('seal: explicit conflicting IDs and equal Chinese names never establish a rename', () => {
  const raw = { addedCountries: [{ country: "Cote D'Ivoire", marketId: 'other', nameZh: '同名' }], removedCountries: [{ country: 'Ivory Coast', marketId: 'ci', nameZh: '同名' }] };
  const current = [{ marketId: 'ci', country: "Cote D'Ivoire", nameZh: '同名' }];
  assert.deepEqual(foldPublicationCountryRenames(raw, current).renamedCountries, []);
  const sameZh = { addedCountries: [{ country: 'Different', nameZh: '同名' }], removedCountries: [{ country: 'Unrelated', nameZh: '同名' }] };
  assert.deepEqual(foldPublicationCountryRenames(sameZh, [{ marketId: 'one', country: 'Different', nameZh: '同名' }]).renamedCountries, []);
});

test('seal: colon-separated feature descriptions are not price records', () => {
  const html = `<main><section><b>隐藏邮件地址</b><ul><li>50GB：隐藏邮件地址</li><li>200GB：自定义域名</li></ul></section><h3>日本（日元）</h3>${prices}</main>`;
  assert.deepEqual(extractAppleZhMarketNames(html), ['日本']);
});