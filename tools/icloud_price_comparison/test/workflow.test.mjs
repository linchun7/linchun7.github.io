import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);

test('keeps the scheduled update workflow guarded and ordered', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(
    workflow,
    /cron:\s*['"](?:[0-5]?\d) (?:[01]?\d|2[0-3]) \* \* \*['"]/,
    'workflow must keep a valid daily schedule without locking its execution time',
  );
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /name: 运行解析与数据安全测试\s+run: pnpm test:core/);
  assert.match(workflow, /name: 运行浏览器界面测试\s+run: pnpm test:ui/);
  assert.match(workflow, /pnpm update:data/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /git pull --rebase origin main/);
  assert.doesNotMatch(workflow, /git push --force/);
  assert.match(workflow, /RUNNER_TEMP\/icloud-storage-summary\.md/);
  assert.match(workflow, /name: 追加仓库容量摘要[\s\S]*if: always\(\)/);
  assert.match(workflow, /name: 写入失败摘要[\s\S]*if: failure\(\)/);
  assert.match(workflow, /::error title=iCloud\+ 价格更新失败/);
  assert.match(workflow, /上一份有效数据继续保留/);
  assert.match(workflow, /git_kib >= 819200[\s\S]*elif \(\( git_kib >= 512000 \)\)/);

  const firstCoreTest = workflow.indexOf('run: pnpm test:core');
  const firstUiTest = workflow.indexOf('run: pnpm test:ui');
  const update = workflow.indexOf('run: pnpm update:data');
  const secondCoreTest = workflow.indexOf('run: pnpm test:core', firstCoreTest + 1);
  const secondUiTest = workflow.indexOf('run: pnpm test:ui', firstUiTest + 1);
  const commit = workflow.indexOf('name: 提交价格数据变更');
  assert.ok(firstCoreTest >= 0 && firstCoreTest < firstUiTest, 'core tests must run before UI tests');
  assert.ok(firstUiTest < update, 'all fixture tests must run before live update');
  assert.ok(update < secondCoreTest, 'the updated snapshot must pass core validation');
  assert.ok(secondCoreTest < secondUiTest, 'updated data must pass before the final UI test');
  assert.ok(secondUiTest < commit, 'all updated output must pass before commit');

  const summaryAppend = workflow.indexOf('name: 追加仓库容量摘要');
  assert.ok(secondUiTest < summaryAppend, 'the main update summary must be written before capacity details');
});
