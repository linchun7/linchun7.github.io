import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildChineseNameSyncSummary, diffChineseNamePending } from '../scripts/report-chinese-name-sync.mjs';

function pendingMarket(index) {
  const id = `m-${String(index).padStart(3, '0')}`;
  const sourceName = `Market ${String(index).padStart(3, '0')}`;
  return { marketId: id, country: sourceName, nameZh: sourceName };
}

function reviewedMarket(index) {
  const market = pendingMarket(index);
  return { ...market, nameZh: `中文 ${index}` };
}

function priceData(countries) {
  return { schemaVersion: 4, countries };
}

test('reports the exact newly pending member when the count moves from 85 to 86', () => {
  const previous = priceData(Array.from({ length: 85 }, (_, index) => pendingMarket(index)));
  const current = priceData(Array.from({ length: 86 }, (_, index) => pendingMarket(index)));
  const diff = diffChineseNamePending(previous, current);
  assert.equal(diff.previousCount, 85);
  assert.equal(diff.currentCount, 86);
  assert.deepEqual(diff.added, [{ marketId: 'm-085', sourceName: 'Market 085' }]);
  assert.deepEqual(diff.removed, []);
  const summary = buildChineseNameSyncSummary(previous, current).join('\n');
  assert.match(summary, /85 → 86；新增 1，退出 0/);
  assert.match(summary, /新增待确认：Market 085 \(`m-085`\)/);
});

test('detects one-in one-out membership replacement even when the count stays at 86', () => {
  const previousCountries = Array.from({ length: 86 }, (_, index) => pendingMarket(index));
  const currentCountries = [
    ...previousCountries.slice(1),
    pendingMarket(999)
  ];
  const previous = priceData(previousCountries);
  const current = priceData(currentCountries);
  const diff = diffChineseNamePending(previous, current);
  assert.equal(diff.previousCount, 86);
  assert.equal(diff.currentCount, 86);
  assert.deepEqual(diff.added, [{ marketId: 'm-999', sourceName: 'Market 999' }]);
  assert.deepEqual(diff.removed, [{ marketId: 'm-000', sourceName: 'Market 000' }]);
  const summary = buildChineseNameSyncSummary(previous, current).join('\n');
  assert.match(summary, /86 → 86；总数不变，但成员发生变化（新增 1，退出 1）/);
  assert.match(summary, /新增待确认：Market 999 \(`m-999`\)/);
  assert.match(summary, /退出待确认：Market 000 \(`m-000`\)/);
});

test('a newly reviewed Chinese name exits the pending set without inventing a market removal', () => {
  const previous = priceData([pendingMarket(1), pendingMarket(2)]);
  const current = priceData([reviewedMarket(1), pendingMarket(2)]);
  const diff = diffChineseNamePending(previous, current);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, [{ marketId: 'm-001', sourceName: 'Market 001' }]);
  assert.match(buildChineseNameSyncSummary(previous, current).join('\n'), /可能是中文名已复核，也可能是英文价格页活跃市场发生变化/);
});

test('workflow snapshots the pre-update prices, emits the membership diff, and keeps human-readable verifier output Chinese', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cp tools\/icloud_price_comparison\/data\/prices\.json "\$RUNNER_TEMP\/icloud-prices-before-update\.json"/);
  assert.match(workflow, /name: 比较中文名称待确认成员[\s\S]*?report-chinese-name-sync\.mjs[\s\S]*?--previous "\$RUNNER_TEMP\/icloud-prices-before-update\.json"[\s\S]*?--current data\/prices\.json/);
  assert.doesNotMatch(workflow, /Current main artifact validated from/);
  assert.match(workflow, /已验证当前 main 数据工件/);
  assert.match(workflow, /validate-data-artifact\.mjs[\s\S]{0,220}>\s*\/dev\/null/);
});
