import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);
const ciWorkflowUrl = new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url);
const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const dependabotUrl = new URL('../../../.github/dependabot.yml', import.meta.url);

test('keeps the scheduled update workflow guarded and ordered', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  assert.match(
    workflow,
    /cron:\s*['"](?:[0-5]?\d) (?:[01]?\d|2[0-3]) \* \* \*['"]/,
    'workflow must keep a valid daily schedule without locking its execution time',
  );
  assert.match(workflow, /cron:\s*['"]10 0 \* \* \*['"]/, 'GitHub backup must target 08:10 Beijing time');
  assert.doesNotMatch(workflow, /cron:\s*['"]5 1 \* \* \*['"]/, 'the old 09:05 Beijing backup schedule must be removed');
  assert.doesNotMatch(workflow, /cron:\s*['"]5 0 \* \* \*['"]/, 'Cloudflare owns the 08:05 primary trigger');
  assert.match(workflow, /workflow_dispatch:[\s\S]*?trigger_source:[\s\S]*?default: manual[\s\S]*?options:[\s\S]*?- manual[\s\S]*?- cloudflare/);
  assert.match(workflow, /name: 检查每日幂等状态[\s\S]*?id: daily_guard[\s\S]*?node scripts\/daily-run-guard\.mjs/);
  assert.match(workflow, /git show origin\/main:tools\/icloud_price_comparison\/data\/run-log\.json/);
  assert.match(workflow, /ICLOUD_RUN_LOG_PATH:\s*\$\{\{ runner\.temp \}\}\/icloud-run-log\.json/);
  assert.match(workflow, /update:[\s\S]*?needs: prepare[\s\S]*?if: needs\.prepare\.outputs\.should_run == 'true'/);
  assert.match(workflow, /ICLOUD_TRIGGER_SOURCE:\s*\$\{\{ needs\.prepare\.outputs\.trigger_source \}\}/);
  assert.match(workflow, /ICLOUD_AUTOMATIC_RUN_DATE_BEIJING:\s*\$\{\{ needs\.prepare\.outputs\.automatic_run_date_beijing \}\}/);
  assert.match(workflow, /concurrency:[\s\S]*?group: update-icloud-prices[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s+contents: read/, 'the workflow must default to read-only repository access');
  assert.match(workflow, /update:[\s\S]*?permissions:\s+contents: read/, 'generation and tests must remain read-only');
  assert.match(workflow, /publish:[\s\S]*?permissions:\s+contents: write/, 'only the dependency-free publisher may write committed data');
  assert.match(workflow, /persist-credentials: false/g);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /name: 运行解析与数据安全测试[\s\S]*?id: core_tests[\s\S]*?run: pnpm test:core/);
  assert.match(workflow, /name: 验证更新后的页面[\s\S]*?run: pnpm test:ui/);
  assert.doesNotMatch(workflow, /ui_failed|pnpm test:ui\s*\|\||记录浏览器界面测试警告/);
  assert.doesNotMatch(workflow, /name: 验证更新后的页面[\s\S]*?playwright install|name: 验证更新后的页面[\s\S]*?pnpm test:browsers/);
  assert.doesNotMatch(workflow, /ui_before|运行浏览器界面测试（更新前）/, 'the workflow must not repeat UI tests before fetching data');
  assert.match(workflow, /name: 验证更新后的价格数据[\s\S]*?id: data_tests[\s\S]*?run: pnpm test:data/);
  assert.match(workflow, /name: 抓取并校验 Apple 价格[\s\S]*?id: update_data[\s\S]*?EXCHANGE_RATE_API_KEY:\s*\$\{\{ secrets\.EXCHANGE_RATE_API_KEY \}\}[\s\S]*?run: pnpm update:data/);
  assert.doesNotMatch(workflow, /v6\/\$\{\{ secrets\.EXCHANGE_RATE_API_KEY \}\}/, 'the API key must not be placed in a request URL');
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7/);
  assert.match(workflow, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/);
  assert.match(workflow, /retention-days:\s*14/);
  assert.match(workflow, /GENERATION_BASE_SHA/);
  assert.match(
    workflow,
    /git rev-parse origin\/main[\s\S]*?GENERATION_BASE_SHA[\s\S]*?push origin HEAD:main/,
  );
  assert.doesNotMatch(workflow, /git pull --rebase origin main/);
  assert.doesNotMatch(workflow, /git push --force/);
  assert.match(workflow, /RUNNER_TEMP\/icloud-storage-summary\.md/);
  assert.match(workflow, /name: 追加仓库容量摘要[\s\S]*if: always\(\)/);
  assert.match(workflow, /name: 补充未报告的失败摘要[\s\S]*if: failure\(\)/);
  assert.match(workflow, /steps\.update_data\.outcome[\s\S]*artifacts\/run-report\.json[\s\S]*Updater already wrote a detailed failure summary/);
  assert.match(workflow, /::error title=iCloud\+ 价格更新失败/);
  assert.match(workflow, /上一份有效数据继续保留/);
  assert.match(workflow, /git_kib >= 819200[\s\S]*elif \(\( git_kib >= 512000 \)\)/);
  assert.match(workflow, /ICLOUD_HEALTHCHECK_PING_URL[\s\S]*?HEALTHCHECK_PING_URL%\/\}\/\$status/);
  assert.match(workflow, /classify_prepare[\s\S]*?steps\.daily_guard\.outcome[\s\S]*?severe_failure/);
  assert.match(workflow, /classify_update[\s\S]*?report\.healthcheckSeverity === "transient"[\s\S]*?source\?\.parser[\s\S]*?cross-checked/);
  assert.match(workflow, /classify_publish[\s\S]*?steps\.validate_data_artifact\.outcome[\s\S]*?severe_failure/);
  assert.match(workflow, /PREPARE_SEVERE_FAILURE:[\s\S]*?UPDATE_SEVERE_FAILURE:[\s\S]*?PUBLISH_SEVERE_FAILURE:/);
  assert.match(workflow, /PREPARE_SEVERE_FAILURE[\s\S]*?status=1[\s\S]*?PREPARE_RESULT[\s\S]*?status=0[\s\S]*?单次暂时故障[\s\S]*?exit 0/);
  assert.doesNotMatch(
    workflow,
    /PREPARE_RESULT" != success[\s\S]*?status=1/,
    'one ordinary failed run must not immediately signal a Healthchecks failure',
  );
  assert.match(workflow, /sha256sum --check icloud-price-data\.tar\.sha256/);
  assert.match(workflow, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}[\s\S]*?push origin HEAD:main/);

  const firstCoreTest = workflow.indexOf('run: pnpm test:core');
  const duplicateCoreTest = workflow.indexOf('run: pnpm test:core', firstCoreTest + 1);
  const update = workflow.indexOf('run: pnpm update:data');
  const dataTest = workflow.indexOf('run: pnpm test:data');
  const browserTest = workflow.indexOf('run: pnpm test:ui');
  const duplicateBrowserTest = workflow.indexOf('pnpm test:ui', browserTest + 'pnpm test:ui'.length);
  const packageData = workflow.indexOf('name: 打包已测试的数据工件');
  assert.ok(firstCoreTest >= 0 && firstCoreTest < update, 'core tests must run before the live update');
  assert.equal(duplicateCoreTest, -1, 'the workflow must not repeat unchanged fixture and workflow tests after the update');
  assert.ok(update < dataTest, 'the updated snapshot must pass data validation');
  assert.ok(dataTest < browserTest, 'updated data must pass before the browser tests');
  assert.equal(duplicateBrowserTest, -1, 'the workflow must run the system Chrome suite only once');
  assert.ok(browserTest < packageData, 'the updated browser tests must finish before packaging for publication');

  const uiStepBlock = workflow.slice(browserTest, workflow.indexOf('name: 上传诊断信息'));
  assert.doesNotMatch(uiStepBlock, /continue-on-error|\|\|/, 'the updated UI validation must block production commits');

  const summaryAppend = workflow.indexOf('name: 追加仓库容量摘要');
  assert.ok(browserTest < summaryAppend, 'the main update summary must be written before capacity details');
});

test('keeps pull-request validation read-only, complete, and SHA-pinned', async () => {
  const [updateWorkflow, ciWorkflow, autoMergeWorkflow] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(ciWorkflowUrl, 'utf8'),
    readFile(autoMergeWorkflowUrl, 'utf8'),
  ]);
  const workflows = `${updateWorkflow}\n${ciWorkflow}\n${autoMergeWorkflow}`;
  const actionReferences = [...workflows.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map(([, reference]) => reference);
  assert.ok(actionReferences.length >= 5);
  assert.ok(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference)), 'all third-party actions must use full commit SHAs');

  assert.match(ciWorkflow, /pull_request:[\s\S]*?\.github\/dependabot\.yml[\s\S]*?push:[\s\S]*?\.github\/dependabot\.yml[\s\S]*?workflow_dispatch:/);
  assert.match(ciWorkflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(ciWorkflow, /contents: write|secrets\./);
  assert.match(ciWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(ciWorkflow, /pnpm exec playwright install --with-deps chromium webkit/);
  assert.match(ciWorkflow, /run: pnpm test:core/);
  assert.match(ciWorkflow, /schedule:[\s\S]*?cron:\s*['"]5 22 \* \* 0['"]/);
  assert.match(ciWorkflow, /run: pnpm validate:snapshots/);
  assert.doesNotMatch(ciWorkflow, /if: github.event_name == 'schedule' \\|\\| github.event_name == 'workflow_dispatch'/);
  assert.match(ciWorkflow, /cancel-in-progress: false/);
  assert.match(ciWorkflow, /run: pnpm test:browsers/);
  assert.match(ciWorkflow, /run: pnpm audit --audit-level low/);
});

test('automates only official GitHub Actions updates after exact-SHA validation', async () => {
  const [autoMergeWorkflow, dependabot] = await Promise.all([
    readFile(autoMergeWorkflowUrl, 'utf8'),
    readFile(dependabotUrl, 'utf8'),
  ]);

  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(dependabot, /interval: weekly/);
  assert.match(dependabot, /allow:[\s\S]*?dependency-name: ["']actions\/\*["']/);
  assert.match(dependabot, /groups:[\s\S]*?official-github-actions:[\s\S]*?patterns:[\s\S]*?["']actions\/\*["']/);
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*?directory: \/tools\/icloud_price_comparison/);
  assert.doesNotMatch(dependabot, /pip|docker/);

  assert.match(autoMergeWorkflow, /workflow_run:[\s\S]*?Validate iCloud price comparison[\s\S]*?completed/);
  assert.match(autoMergeWorkflow, /workflow_run\.conclusion == 'success'[\s\S]*?workflow_run\.event == 'pull_request'[\s\S]*?workflow_run\.actor\.login == 'dependabot\[bot\]'[\s\S]*?startsWith\(github\.event\.workflow_run\.head_branch, 'dependabot\/github_actions\/'\)[\s\S]*?pull_requests\[0\]\.number > 0/);
  assert.match(autoMergeWorkflow, /permissions:\s+contents: write\s+pull-requests: write/);
  assert.doesNotMatch(autoMergeWorkflow, /pull_request_target|secrets\.(?!GITHUB_TOKEN)/);
  assert.match(autoMergeWorkflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}[\s\S]*?persist-credentials: false/);
  assert.match(autoMergeWorkflow, /actions\/setup-node@[a-f0-9]{40} # v\d+[\s\S]*?node-version: 22/);
  assert.match(autoMergeWorkflow, /RUN_BASE_SHA: \$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.base\.sha \}\}/);
  assert.match(autoMergeWorkflow, /RUN_HEAD_SHA: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(autoMergeWorkflow, /node tools\/icloud_price_comparison\/scripts\/auto-merge-official-actions\.mjs/);
});
