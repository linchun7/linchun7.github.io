import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

const [readme, operations, validationWorkflow] = await Promise.all([
  readProjectFile('README.md'),
  readProjectFile('OPERATIONS.md'),
  readFile(new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url), 'utf8')
]);

test('documents the generated SEO source rather than treating index.html as the source of truth', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /render-static-page\.mjs/);
    assert.match(document, /seoProjection\(\)/);
    assert.match(document, /SEO_PROJECTION_MISMATCH/);
  }
});

test('documents active, reserved, and deterministic fallback market identities', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /reserved-market-registry\.mjs/);
    assert.match(document, /apple-\*/);
    assert.match(document, /prices\.json[\s\S]*history\.json|history\.json[\s\S]*prices\.json/);
  }
  assert.match(readme, /marketId[\s\S]*永久|永久[\s\S]*marketId/);
});

test('documents friendly search aliases separately from permanent market identity', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /MARKET_SEARCH_ALIASES/);
    assert.match(document, /search alias/i);
  }
});

test('documents published market IDs as permanent and removes the routine rekey path', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /marketId[\s\S]*(?:永久冻结|永久不可变)/);
    assert.doesNotMatch(document, /migrate-market-id\.mjs/);
  }
});

test('documents the reviewed same-ID fallback promotion lifecycle', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /apple-\*[\s\S]*(?:active registry|active registry[\s\S]*apple-\*)/i);
    assert.match(document, /future reservation[\s\S]*(?:移除|冲突)|(?:移除|冲突)[\s\S]*future reservation/i);
    assert.match(document, /source alias/i);
    assert.match(document, /中文名称 authority|中文名称.*authority/i);
  }
});

test('documents repriced rename review and normalized bilingual region search', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /NFKC/);
    assert.match(document, /英文 region|Apple 原始英文 region/);
    assert.match(document, /中文.*标签|中文显示标签/);
    assert.match(document, /repricing|repriced/i);
    assert.match(document, /MARKET_IDENTITY_RENAME_REVIEW_REQUIRED|停止并要求/);
  }
});

test('documents current search, mobile sequence, and assistive rank semantics', () => {
  assert.match(readme, /完整 `marketId`[\s\S]*优先|完整 `marketId` 命中优先级最高/);
  assert.match(readme, /币种[\s\S]*完整/);
  assert.match(readme, /`序N`|`序1`/);
  assert.match(operations, /`序N`/);
  for (const document of [readme, operations]) {
    assert.match(document, /全球价格排名第 N|当前列表序号第 N/);
  }
});

test('PR validation keeps the docs gate focused and enforces immutable published IDs', () => {
  assert.match(validationWorkflow, /强制关键架构更新同步文档/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/README\.md/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/OPERATIONS\.md/);
  assert.match(validationWorkflow, /market-registry/);
  assert.match(validationWorkflow, /data-model\.js/);
  const docsGate = validationWorkflow.match(/- name: 强制关键架构更新同步文档[\s\S]*?(?=\n      - name: 强制已发布 marketId 永久保留)/)?.[0] ?? '';
  assert.ok(docsGate, 'documentation gate block must remain detectable');
  assert.doesNotMatch(docsGate, /tools\/icloud_price_comparison\/script\.js/);
  assert.match(validationWorkflow, /强制已发布 marketId 永久保留/);
  assert.match(validationWorkflow, /Published marketId removed from history ledger/);
  assert.match(validationWorkflow, /Published source identity rekeyed/);
  assert.match(validationWorkflow, /git diff --check \"\$BASE_SHA\" HEAD/);
});
