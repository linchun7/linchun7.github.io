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

test('documents current search and mobile sequence semantics', () => {
  assert.match(readme, /精确 `marketId`[\s\S]*优先/);
  assert.match(readme, /币种[\s\S]*完整/);
  assert.match(readme, /`序N`|`序1`/);
  assert.match(operations, /`序N`/);
});


test('PR validation forces critical architecture changes to update both long-lived documents', () => {
  assert.match(validationWorkflow, /强制关键架构更新同步文档/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/README\.md/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/OPERATIONS\.md/);
  assert.match(validationWorkflow, /market-registry/);
  assert.match(validationWorkflow, /data-model/);
});
