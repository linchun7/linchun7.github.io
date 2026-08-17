import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dependabotUrl = new URL('../../../.github/dependabot.yml', import.meta.url);
const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const updateWorkflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);
const manifestUrl = new URL('../vendor/manifest.json', import.meta.url);
const noticesUrl = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);

test('stages automated maintenance after the daily production update window', async () => {
  const [dependabot, updateWorkflow] = await Promise.all([
    readFile(dependabotUrl, 'utf8'),
    readFile(updateWorkflowUrl, 'utf8'),
  ]);

  assert.match(updateWorkflow, /cron:\s*['"]10 0 \* \* \*['"]/, 'daily GitHub fallback stays at 08:10 Beijing');
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*?day: monday[\s\S]*?time: ["']10:20["'][\s\S]*?timezone: Asia\/Shanghai/);
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*?day: monday[\s\S]*?time: ["']12:20["'][\s\S]*?timezone: Asia\/Shanghai/);
  assert.match(dependabot, /icloud-price-dependencies:[\s\S]*?update-types:[\s\S]*?- ["']minor["'][\s\S]*?- ["']patch["']/);
});

test('auto-merge is limited to trusted Dependabot scopes after successful full validation', async () => {
  const workflow = await readFile(autoMergeWorkflowUrl, 'utf8');
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.actor\.login == 'dependabot\[bot\]'/);
  assert.match(workflow, /dependabot\/github_actions\//);
  assert.match(workflow, /dependabot\/npm_and_yarn\/tools\/icloud_price_comparison\//);
  assert.match(workflow, /RUN_BASE_SHA:[\s\S]*?RUN_HEAD_SHA:/);
  assert.match(workflow, /permissions:\s+contents: write\s+pull-requests: write/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\./);
});

test('vendored Lucide metadata does not duplicate the package version pin', async () => {
  const [manifestText, notices] = await Promise.all([
    readFile(manifestUrl, 'utf8'),
    readFile(noticesUrl, 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 2);
  assert.ok(manifest.assets.length > 0);
  for (const asset of manifest.assets) {
    assert.equal(Object.hasOwn(asset, 'version'), false);
  }
  assert.match(notices, /^## Lucide$/m);
  assert.match(notices, /exact reviewed version[\s\S]*?package\.json[\s\S]*?pnpm-lock\.yaml/i);
  assert.doesNotMatch(notices, /^## Lucide \d+\.\d+\.\d+$/m);
});
