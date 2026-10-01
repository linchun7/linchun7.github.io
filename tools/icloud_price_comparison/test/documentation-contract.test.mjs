import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const project = name => readFile(new URL('../' + name, import.meta.url), 'utf8');
const repo = name => readFile(new URL('../../../' + name, import.meta.url), 'utf8');
const documents = async () => (await Promise.all([
  project('README.md'),
  project('OPERATIONS.md'),
])).join('\n');

test('identity documentation preserves the stable ledger and source aliases', async () => {
  const text = await documents();
  for (const required of [
    /identity ledger/i, /market-registry\.mjs/, /apple-\*/,
    /prices\.json/, /history\.json/, /marketId.*永久|永久.*marketId/i,
    /source alias/i, /不 rekey|不得.*rekey|永久.*identity/i, /中文名称/,
  ]) assert.match(text, required);
  assert.doesNotMatch(text, /reserved-market-registry\.mjs|future reservation/i);
});

test('search documentation describes canonical inputs without a second alias catalog', async () => {
  const text = await documents();
  for (const required of [/NFKC/, /marketId/, /中英文/, /地区/, /币种/]) {
    assert.match(text, required);
  }
  assert.doesNotMatch(text, /MARKET_SEARCH_ALIASES|search alias/i);
});

test('generated page and SEO remain derived output', async () => {
  const text = await documents();
  for (const required of [/seoProjection\(\)/, /SEO Projection/, /render:static:check/, /index\.html/]) {
    assert.match(text, required);
  }
});

test('daily token and pinned browser behavior remain documented accurately', async () => {
  const operations = await project('OPERATIONS.md');
  const workflow = await repo('.github/workflows/update-icloud-prices.yml');
  assert.match(operations, /GITHUB_TOKEN.*不会再触发普通 push 验证/);
  assert.match(workflow, /GITHUB_TOKEN 发布提交不会再次触发 push workflow/);
  assert.match(workflow, /固定 Playwright Chromium/);
  assert.match(workflow, /Chromium \+ Firefox \+ WebKit/);
});

test('critical-change gate requires only the two maintained guides', async () => {
  const workflow = await repo('.github/workflows/validate-icloud-price-comparison.yml');
  assert.match(workflow, /market-registry\.mjs/);
  assert.match(workflow, /data-model\.js/);
  assert.match(workflow, /for doc in tools\/icloud_price_comparison\/README\.md tools\/icloud_price_comparison\/OPERATIONS\.md; do/);
  assert.doesNotMatch(workflow, /ARCHITECTURE\.md|TROUBLESHOOTING\.md|reserved-market-registry\.mjs/);
  assert.match(workflow, /github\.event_name == 'pull_request' \|\| github\.event_name == 'push'/);
});

test('concise guides retain data recovery and symptom troubleshooting', async () => {
  const text = await documents();
  for (const required of [
    /唯一事实源/, /A → B → A/, /控制面.*不能.*证明|不能由仓库单独证明|不能由仓库.*证明/,
    /pnpm test:core/, /pnpm validate:artifact/, /不要用 `pnpm update:data`/,
    /bad tree object/, /不要逐个手拼 JSON/, /revert 完整/,
    /不设展示期限/, /原源日期|源日期保持真实/,
  ]) assert.match(text, required);
});

test('maintained Markdown links resolve without retired document references', async () => {
  for (const name of ['README.md', 'OPERATIONS.md', 'data/apple-snapshots/README.md']) {
    const text = await project(name);
    assert.doesNotMatch(text, /ARCHITECTURE\.md|TROUBLESHOOTING\.md/);
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      await access(new URL(target, new URL('../' + name, import.meta.url)));
    }
  }
});

test('dependency documentation matches the independent tested-update policy', async () => {
  const operations = await project('OPERATIONS.md');
  const dependabot = await repo('.github/dependabot.yml');
  const merger = await project('scripts/auto-merge-official-actions.mjs');
  for (const time of ['10:20', '11:20', '12:20']) {
    assert.ok(operations.includes(time));
    assert.ok(dependabot.includes('time: "' + time + '"'));
  }
  assert.match(operations, /独立 PR|单独 PR/);
  assert.match(operations, /major.*minor.*patch|patch.*minor.*major/i);
  assert.match(operations, /Playwright.*Chromium.*Firefox.*WebKit|Chromium.*Firefox.*WebKit.*Playwright/i);
  assert.match(operations, /Action.*major.*人工|major.*Action.*人工/i);
  assert.doesNotMatch(operations, /patch\/minor 更新合并为一个|所有版本只能向前做 patch\/minor|npm major 更新.*不会自动合并/);
  assert.match(dependabot, /directory: \/tools\/browser-tests/);
  assert.doesNotMatch(dependabot, /\bgroups:/);
  for (const name of ['cheerio', 'lucide', 'playwright']) {
    assert.match(merger, new RegExp('[\'"]' + name + '[\'"]'));
  }
  assert.match(merger, /major update requires manual review/);
});
