import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);

test('keeps the scheduled update workflow guarded and ordered', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(workflow, /cron:\s*['"]0 1 \* \* \*['"]/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm test/);
  assert.match(workflow, /pnpm update:data/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /git pull --rebase origin main/);
  assert.doesNotMatch(workflow, /git push --force/);
  assert.match(workflow, /RUNNER_TEMP\/icloud-storage-summary\.md/);
  assert.match(workflow, /name: Append repository storage summary[\s\S]*if: always\(\)/);
  assert.match(workflow, /git_kib >= 819200[\s\S]*elif \(\( git_kib >= 512000 \)\)/);

  const firstTest = workflow.indexOf('run: pnpm test');
  const update = workflow.indexOf('run: pnpm update:data');
  const secondTest = workflow.indexOf('run: pnpm test', firstTest + 1);
  const commit = workflow.indexOf('name: Commit data changes');
  assert.ok(firstTest >= 0 && firstTest < update, 'fixture tests must run before live update');
  assert.ok(update < secondTest, 'the updated snapshot must be tested before committing');
  assert.ok(secondTest < commit, 'data must pass validation before commit');

  const summaryAppend = workflow.indexOf('name: Append repository storage summary');
  assert.ok(secondTest < summaryAppend, 'the main update summary must be written before capacity details');
});
