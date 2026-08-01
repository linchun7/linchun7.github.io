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
  assert.match(workflow, /cron:\s*['"]57 9 \* \* \*['"]/, 'schedule must target 17:57 Beijing time');
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /name: 运行解析与数据安全测试\s+run: pnpm test:core/);
  assert.match(workflow, /name: 验证更新后的页面[\s\S]*?id: ui_after[\s\S]*?continue-on-error: true[\s\S]*?run: pnpm test:ui/);
  assert.doesNotMatch(workflow, /ui_before|运行浏览器界面测试（更新前）/, 'the workflow must not repeat UI tests before fetching data');
  assert.match(workflow, /name: 验证更新后的价格数据\s+run: pnpm test:data/);
  assert.match(workflow, /pnpm update:data/);
  assert.match(workflow, /actions\/upload-artifact@v7/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /git pull --rebase origin main/);
  assert.doesNotMatch(workflow, /git push --force/);
  assert.match(workflow, /name: 记录浏览器界面测试警告[\s\S]*?steps\.ui_after\.outcome == 'failure'/);
  assert.match(workflow, /::warning title=浏览器界面测试未通过/);
  assert.match(workflow, /价格抓取、核心数据校验和提交未因此中断/);
  assert.match(workflow, /RUNNER_TEMP\/icloud-storage-summary\.md/);
  assert.match(workflow, /name: 追加仓库容量摘要[\s\S]*if: always\(\)/);
  assert.match(workflow, /name: 写入失败摘要[\s\S]*if: failure\(\)/);
  assert.match(workflow, /::error title=iCloud\+ 价格更新失败/);
  assert.match(workflow, /上一份有效数据继续保留/);
  assert.match(workflow, /git_kib >= 819200[\s\S]*elif \(\( git_kib >= 512000 \)\)/);

  const firstCoreTest = workflow.indexOf('run: pnpm test:core');
  const duplicateCoreTest = workflow.indexOf('run: pnpm test:core', firstCoreTest + 1);
  const update = workflow.indexOf('run: pnpm update:data');
  const dataTest = workflow.indexOf('run: pnpm test:data');
  const uiTest = workflow.indexOf('run: pnpm test:ui');
  const duplicateUiTest = workflow.indexOf('run: pnpm test:ui', uiTest + 1);
  const commit = workflow.indexOf('name: 提交价格数据变更');
  assert.ok(firstCoreTest >= 0 && firstCoreTest < update, 'core tests must run before the live update');
  assert.equal(duplicateCoreTest, -1, 'the workflow must not repeat unchanged fixture and workflow tests after the update');
  assert.ok(update < dataTest, 'the updated snapshot must pass data validation');
  assert.ok(dataTest < uiTest, 'updated data must pass before the UI test');
  assert.equal(duplicateUiTest, -1, 'the workflow must run the real-browser UI suite only once');
  assert.ok(uiTest < commit, 'the updated UI test must finish before commit');

  const uiGate = workflow.indexOf('name: 记录浏览器界面测试警告');
  assert.ok(commit < uiGate, 'UI failures must be reported only after the data commit step');

  const uiWarningBlock = workflow.slice(uiGate, workflow.indexOf('name: 写入失败摘要'));
  assert.doesNotMatch(uiWarningBlock, /::error|exit 1/, 'UI failures must warn without failing the update job');

  const summaryAppend = workflow.indexOf('name: 追加仓库容量摘要');
  assert.ok(uiTest < summaryAppend, 'the main update summary must be written before capacity details');
});
