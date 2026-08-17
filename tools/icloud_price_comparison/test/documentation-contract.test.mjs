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

test('documents the simple immutable market identity model', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /marketId[\s\S]*(?:永久冻结|永久不可变)/);
    assert.match(document, /apple-\*/);
    assert.match(document, /market-registry\.mjs/);
    assert.doesNotMatch(document, /reserved-market-registry\.mjs|MARKET_SEARCH_ALIASES/);
    assert.doesNotMatch(document, /migrate-market-id\.mjs/);
  }
});

test('documents user-facing search without exposing marketId or search aliases as product features', () => {
  assert.match(readme, /中英文国家\/地区[\s\S]*地区名称[\s\S]*币种/);
  assert.match(readme, /`序N`|`序1`/);
  assert.match(operations, /`序N`/);
  for (const document of [readme, operations]) {
    assert.doesNotMatch(document, /精确 `marketId`|search alias/i);
  }
});

test('PR validation forces critical architecture changes to update both long-lived documents', () => {
  assert.match(validationWorkflow, /强制关键架构更新同步文档/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/README\.md/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/OPERATIONS\.md/);
  assert.match(validationWorkflow, /market-registry/);
  assert.match(validationWorkflow, /data-model/);
});

test('PR validation protects published market IDs across the base and head histories', () => {
  assert.match(validationWorkflow, /强制已发布 marketId 永久保留/);
  assert.match(validationWorkflow, /base-history\.json/);
  assert.match(validationWorkflow, /removed marketId/i);
});
