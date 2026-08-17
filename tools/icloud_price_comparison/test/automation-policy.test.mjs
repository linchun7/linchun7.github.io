import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const workflowsDirUrl = new URL('../../../.github/workflows/', import.meta.url);
const dependabotUrl = new URL('../../../.github/dependabot.yml', import.meta.url);
const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const validationWorkflowUrl = new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url);
const updateWorkflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);
const manifestUrl = new URL('../vendor/manifest.json', import.meta.url);
const noticesUrl = new URL('../THIRD_PARTY_NOTICES.md', import.meta.url);

const LONG_LIVED_WORKFLOWS = [
  'auto-merge-official-actions.yml',
  'icloud-repository-maintenance.yml',
  'update-icloud-prices.yml',
  'validate-icloud-price-comparison.yml',
];

test('keeps the automation surface limited to four long-lived workflows', async () => {
  const workflows = (await readdir(workflowsDirUrl))
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  assert.deepEqual(workflows, LONG_LIVED_WORKFLOWS);
});

test('pins every long-lived GitHub Action to a full SHA with a stable release annotation', async () => {
  for (const workflowName of LONG_LIVED_WORKFLOWS) {
    const workflow = await readFile(new URL(workflowName, workflowsDirUrl), 'utf8');
    const usesLines = workflow.split(/\r?\n/).filter((line) => /^\s*uses:\s*/.test(line));
    assert.ok(usesLines.length > 0, `${workflowName} must contain at least one reviewed Action reference`);
    for (const line of usesLines) {
      assert.match(
        line,
        /^\s*uses:\s+actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*@[a-f0-9]{40}\s+#\s+v\d+\.\d+\.\d+\s*$/,
        `${workflowName} contains an unreviewed or non-stable Action reference: ${line.trim()}`
      );
    }
  }
});

test('stages maintenance after production and groups only routine version updates', async () => {
  const [dependabot, updateWorkflow] = await Promise.all([
    readFile(dependabotUrl, 'utf8'),
    readFile(updateWorkflowUrl, 'utf8'),
  ]);

  assert.match(updateWorkflow, /cron:\s*['"]10 0 \* \* \*['"]/, 'daily GitHub fallback stays at 08:10 Beijing');
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*?day: monday[\s\S]*?time: ["']10:20["'][\s\S]*?timezone: Asia\/Shanghai/);
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*?day: monday[\s\S]*?time: ["']12:20["'][\s\S]*?timezone: Asia\/Shanghai/);

  const npmStart = dependabot.indexOf('package-ecosystem: npm');
  const actionsStart = dependabot.indexOf('package-ecosystem: github-actions');
  assert.ok(npmStart >= 0 && actionsStart > npmStart);
  const npmBlock = dependabot.slice(npmStart, actionsStart);
  const actionsBlock = dependabot.slice(actionsStart);

  assert.match(npmBlock, /routine-icloud-dependencies:[\s\S]*?applies-to: version-updates[\s\S]*?patterns:[\s\S]*?- ["']\*["'][\s\S]*?update-types:[\s\S]*?- ["']minor["'][\s\S]*?- ["']patch["']/);
  assert.doesNotMatch(npmBlock, /update-types:[\s\S]*?- ["']major["']/);
  assert.match(actionsBlock, /open-pull-requests-limit:\s*5/);
  assert.match(actionsBlock, /official-github-actions:[\s\S]*?applies-to: version-updates[\s\S]*?patterns:[\s\S]*?- ["']actions\/\*["'][\s\S]*?update-types:[\s\S]*?- ["']minor["'][\s\S]*?- ["']patch["']/);
  assert.doesNotMatch(actionsBlock, /update-types:[\s\S]*?- ["']major["']/);
});

test('superseded PR validations cancel while main, manual, and scheduled validation remain complete', async () => {
  const workflow = await readFile(validationWorkflowUrl, 'utf8');
  assert.match(workflow, /group: validate-icloud-price-comparison-\$\{\{ github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/);
  assert.doesNotMatch(workflow, /cancel-in-progress:\s*true/);
});

test('auto-merge is serialized, least-privileged, and limited to trusted Dependabot validations', async () => {
  const workflow = await readFile(autoMergeWorkflowUrl, 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*?workflows:[\s\S]*?Validate iCloud price comparison[\s\S]*?branches:[\s\S]*?- ['"]dependabot\/\*\*['"][\s\S]*?types:[\s\S]*?- completed/);
  assert.match(workflow, /permissions:\s*\{\}[\s\S]*?concurrency:[\s\S]*?group: auto-merge-verified-dependabot[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /merge:[\s\S]*?permissions:\s+contents: write\s+pull-requests: write/);
  assert.match(workflow, /workflow_run\.conclusion == 'success'/);
  assert.match(workflow, /workflow_run\.actor\.login == 'dependabot\[bot\]'/);
  assert.match(workflow, /dependabot\/github_actions\//);
  assert.match(workflow, /dependabot\/npm_and_yarn\/tools\/icloud_price_comparison\//);
  assert.match(workflow, /RUN_BASE_SHA:[\s\S]*?RUN_HEAD_SHA:/);
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
  assert.match(notices, /^## Lucide\r?$/m);
  assert.match(notices, /exact reviewed version[\s\S]*?package\.json[\s\S]*?pnpm-lock\.yaml/i);
  assert.doesNotMatch(notices, /^## Lucide \d+\.\d+\.\d+\r?$/m);
});
