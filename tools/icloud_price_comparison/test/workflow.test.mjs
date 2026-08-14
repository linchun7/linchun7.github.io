import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const workflowUrl = new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url);
const ciWorkflowUrl = new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url);
const maintenanceWorkflowUrl = new URL('../../../.github/workflows/icloud-repository-maintenance.yml', import.meta.url);
const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const dependabotUrl = new URL('../../../.github/dependabot.yml', import.meta.url);
const gitignoreUrl = new URL('../../../.gitignore', import.meta.url);
const notFoundUrl = new URL('../../../404.html', import.meta.url);
const packageUrl = new URL('../package.json', import.meta.url);
const browserRunnerUrl = new URL('../scripts/test-browsers.mjs', import.meta.url);
const firefoxRunnerUrl = new URL('../scripts/test-firefox.mjs', import.meta.url);
const webkitRunnerUrl = new URL('../scripts/test-webkit.mjs', import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

test('keeps the shared 404 page local, private, and CSP-safe', async () => {
  const html = await readFile(notFoundUrl, 'utf8');
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /<meta name="referrer" content="origin">/);
  assert.match(html, /script-src 'none'/);
  assert.doesNotMatch(html, /<script\b|\sstyle=|googletagmanager|google-analytics|googleapis|gstatic|staticfile|jquery/i);
});

test('keeps only long-lived public Markdown in the project', () => {
  const trackedMarkdown = execFileSync('git', ['ls-files'], {
    cwd: repositoryRoot,
    encoding: 'utf8'
  })
    .split(/\r?\n/)
    .filter((file) => file.startsWith('tools/icloud_price_comparison/')
      && file.endsWith('.md')
      && existsSync(path.join(repositoryRoot, file)))
    .sort();
  assert.deepEqual(trackedMarkdown, [
    'tools/icloud_price_comparison/OPERATIONS.md',
    'tools/icloud_price_comparison/README.md',
    'tools/icloud_price_comparison/THIRD_PARTY_NOTICES.md',
    'tools/icloud_price_comparison/data/apple-snapshots/README.md'
  ]);
});

test('keeps updater locks, recovery journals, temporary writes, and diagnostics out of Git', async () => {
  const gitignore = await readFile(gitignoreUrl, 'utf8');
  for (const pattern of [
    'tools/icloud_price_comparison/artifacts/',
    'tools/icloud_price_comparison/.icloud-price-update.lock',
    'tools/icloud_price_comparison/.icloud-price-update.lock.claim-*',
    'tools/icloud_price_comparison/data/.icloud-price-update-transaction.json',
    'tools/icloud_price_comparison/data/*.tmp-*',
    'tools/icloud_price_comparison/data/apple-snapshots/*.tmp-*',
    'tools/icloud_price_comparison/data/.apple-snapshot-import-*'
  ]) {
    assert.ok(gitignore.split(/\r?\n/).includes(pattern), `missing ignored runtime path: ${pattern}`);
  }
});

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
  assert.match(workflow, /name: 读取并深验最新 main 的每日幂等状态[\s\S]*?id: validate_main_data[\s\S]*?git archive --format=tar origin\/main tools\/icloud_price_comparison\/data[\s\S]*?tar --extract --file=-/);
  assert.match(workflow, /validate-data-artifact\.mjs[\s\S]*?--data-dir "\$main_snapshot\/tools\/icloud_price_comparison\/data"/);
  assert.match(workflow, /ICLOUD_RUN_LOG_PATH:\s*\$\{\{ runner\.temp \}\}\/icloud-main-snapshot\/tools\/icloud_price_comparison\/data\/run-log\.json/);
  assert.match(workflow, /update:[\s\S]*?needs: prepare[\s\S]*?if: needs\.prepare\.outputs\.should_run == 'true'/);
  assert.match(workflow, /ICLOUD_TRIGGER_SOURCE:\s*\$\{\{ needs\.prepare\.outputs\.trigger_source \}\}/);
  assert.match(workflow, /ICLOUD_AUTOMATIC_RUN_DATE_BEIJING:\s*\$\{\{ needs\.prepare\.outputs\.automatic_run_date_beijing \}\}/);
  assert.match(workflow, /concurrency:[\s\S]*?group: update-icloud-prices[\s\S]*?cancel-in-progress: false/);
  assert.match(workflow, /permissions:\s+contents: read/, 'the workflow must default to read-only repository access');
  assert.match(workflow, /update:[\s\S]*?permissions:\s+contents: read/, 'generation and tests must remain read-only');
  assert.match(workflow, /publish:[\s\S]*?permissions:\s+contents: write/, 'only the dependency-free publisher may write committed data');
  assert.match(workflow, /persist-credentials: false/g);
  assert.match(workflow, /name: 启用并校验 pnpm[\s\S]*?corepack enable[\s\S]*?pnpm --version/);
  assert.doesNotMatch(workflow, /npm install[^\n]*pnpm/);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/);
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
  assert.doesNotMatch(workflow, /fetch-depth: 0|git count-objects|git_kib >=/, 'daily jobs must not fetch or audit full history');
  assert.equal((workflow.match(/fetch-depth: 1/g) ?? []).length, 2, 'update and publish checkouts must be shallow');
  assert.match(workflow, /name: 补充未报告的失败摘要[\s\S]*if: failure\(\)/);
  assert.match(workflow, /steps\.update_data\.outcome[\s\S]*artifacts\/run-report\.json[\s\S]*Updater already wrote a detailed failure summary/);
  assert.match(workflow, /::error title=iCloud\+ 价格更新失败/);
  assert.match(workflow, /上一份有效数据继续保留/);
  assert.match(workflow, /ICLOUD_HEALTHCHECK_PING_URL[\s\S]*?HEALTHCHECK_PING_URL%\/\}\/\$status/);
  assert.match(workflow, /prepare:[\s\S]*?runs-on: ubuntu-latest\s+timeout-minutes: 5[\s\S]*?\n  update:/);
  assert.match(workflow, /classify_prepare[\s\S]*?steps\.validate_main_data\.outcome[\s\S]*?steps\.daily_guard\.outcome[\s\S]*?severe_failure/);
  assert.match(workflow, /classify_update[\s\S]*?steps\.package_data\.outcome[\s\S]*?update_failure_severe=true[\s\S]*?report\.healthcheckSeverity === "transient"[\s\S]*?2>\/dev\/null[\s\S]*?source\?\.parser[\s\S]*?2>\/dev\/null[\s\S]*?cross-checked/);
  assert.match(workflow, /classify_publish[\s\S]*?steps\.validate_data_artifact\.outcome[\s\S]*?severe_failure/);
  assert.match(workflow, /PREPARE_SEVERE_FAILURE:[\s\S]*?UPDATE_SEVERE_FAILURE:[\s\S]*?PUBLISH_SEVERE_FAILURE:/);
  assert.match(workflow, /PREPARE_SEVERE_FAILURE[\s\S]*?status=1[\s\S]*?PREPARE_RESULT[\s\S]*?status=0[\s\S]*?单次暂时故障[\s\S]*?exit 0/);
  assert.doesNotMatch(
    workflow,
    /PREPARE_RESULT" != success[\s\S]*?status=1/,
    'one ordinary failed run must not immediately signal a Healthchecks failure',
  );
  assert.match(workflow, /sha256sum --check icloud-price-data\.tar\.sha256/);
  assert.match(workflow, /validate-data-artifact\.mjs --data-dir tools\/icloud_price_comparison\/data[\s\S]*?tar --format=ustar/);
  assert.match(workflow, /validate-data-artifact\.mjs"[\s\S]*?--archive icloud-price-data\.tar[\s\S]*?tar --extract[\s\S]*?--no-same-owner --no-same-permissions[\s\S]*?--data-dir unpacked\/tools\/icloud_price_comparison\/data/);
  assert.doesNotMatch(workflow, /tar -tf icloud-price-data\.tar|find unpacked\/tools\/icloud_price_comparison\/data/);
  assert.match(workflow, /validated_data=.*unpacked\/tools\/icloud_price_comparison\/data[\s\S]*?rm -rf tools\/icloud_price_comparison\/data[\s\S]*?cp -a "\$validated_data" tools\/icloud_price_comparison\/data/);
  assert.match(workflow, /git add --all tools\/icloud_price_comparison\/data/);
  assert.doesNotMatch(workflow, /cp -a .*data\/\." tools\/icloud_price_comparison\/data\//, 'publisher must replace the complete validated data directory');
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

});

test('moves full-history growth checks into a weekly read-only workflow', async () => {
  const workflow = await readFile(maintenanceWorkflowUrl, 'utf8');
  assert.match(workflow, /schedule:[\s\S]*?cron:\s*['"]15 22 \* \* 6['"]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s+contents: read/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|pnpm install|npm install/);
  assert.match(workflow, /actions\/checkout@[a-f0-9]{40} # v\d+[\s\S]*?fetch-depth: 0[\s\S]*?persist-credentials: false/);
  assert.match(workflow, /git count-objects -vH/);
  assert.match(workflow, /history\.json/);
  assert.match(workflow, /git_kib >= 819200[\s\S]*?::error[\s\S]*?exit 1[\s\S]*?git_kib >= 512000[\s\S]*?::warning/);
});

test('keeps pull-request validation read-only, complete, and SHA-pinned', async () => {
  const [updateWorkflow, ciWorkflow, maintenanceWorkflow, autoMergeWorkflow] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(ciWorkflowUrl, 'utf8'),
    readFile(maintenanceWorkflowUrl, 'utf8'),
    readFile(autoMergeWorkflowUrl, 'utf8'),
  ]);
  const workflows = `${updateWorkflow}\n${ciWorkflow}\n${maintenanceWorkflow}\n${autoMergeWorkflow}`;
  const actionReferences = [...workflows.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)].map(([, reference]) => reference);
  assert.ok(actionReferences.length >= 5);
  assert.ok(actionReferences.every((reference) => /^[a-f0-9]{40}$/.test(reference)), 'all third-party actions must use full commit SHAs');

  assert.match(ciWorkflow, /pull_request:[\s\S]*?\.github\/dependabot\.yml[\s\S]*?push:[\s\S]*?\.github\/dependabot\.yml[\s\S]*?workflow_dispatch:/);
  assert.match(ciWorkflow, /permissions:\s+contents: read/);
  assert.match(ciWorkflow, /uses: actions\/checkout@[a-f0-9]{40}[^]*?persist-credentials: false/);
  assert.doesNotMatch(ciWorkflow, /contents: write|secrets\./);
  assert.match(ciWorkflow, /name: 启用并校验 pnpm[\s\S]*?corepack enable[\s\S]*?pnpm --version/);
  assert.doesNotMatch(ciWorkflow, /npm install[^\n]*pnpm/);
  assert.match(ciWorkflow, /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(ciWorkflow, /pnpm exec playwright install --with-deps chromium firefox webkit/);
  assert.match(ciWorkflow, /run: pnpm test:core/);
  assert.match(ciWorkflow, /run: pnpm validate:artifact/);
  assert.match(ciWorkflow, /schedule:[\s\S]*?cron:\s*['"]5 22 \* \* 0['"]/);
  assert.match(ciWorkflow, /run: pnpm validate:snapshots/);
  assert.doesNotMatch(ciWorkflow, /if: github.event_name == 'schedule' \\|\\| github.event_name == 'workflow_dispatch'/);
  assert.match(ciWorkflow, /cancel-in-progress: false/);
  assert.match(ciWorkflow, /run: pnpm test:browsers/);
  assert.match(ciWorkflow, /run: pnpm audit --audit-level low/);
});

test('runs the same UI acceptance suite in Chromium, Firefox, and WebKit', async () => {
  const [packageText, browserRunner, firefoxRunner, webkitRunner] = await Promise.all([
    readFile(packageUrl, 'utf8'),
    readFile(browserRunnerUrl, 'utf8'),
    readFile(firefoxRunnerUrl, 'utf8'),
    readFile(webkitRunnerUrl, 'utf8')
  ]);
  const packageJson = JSON.parse(packageText);

  assert.equal(
    packageJson.packageManager,
    'pnpm@10.14.0+sha512.ad27a79641b49c3e481a16a805baa71817a04bbe06a38d17e60e2eaee83f6a146c6a688125f5792e48dd5ba30e7da52a5cda4c3992b9ccf333f9ce223af84748'
  );
  assert.match(browserRunner, /\['chromium', 'firefox', 'webkit'\]\.map\(runBrowserSuite\)/);
  assert.equal(packageJson.scripts['test:firefox'], 'node --test scripts/test-firefox.mjs');
  assert.equal(packageJson.scripts['test:webkit'], 'node --test scripts/test-webkit.mjs');
  assert.match(firefoxRunner, /PLAYWRIGHT_BROWSER = 'firefox'[\s\S]*?import\('\.\.\/test\/ui-smoke\.test\.mjs'\)/);
  assert.match(webkitRunner, /PLAYWRIGHT_BROWSER = 'webkit'[\s\S]*?import\('\.\.\/test\/ui-smoke\.test\.mjs'\)/);
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
