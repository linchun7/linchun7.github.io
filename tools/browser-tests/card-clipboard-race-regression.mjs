import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const rows = [];
const scenarios = ['clear-reject', 'recalculate-reject', 'page-reject', 'clear-resolve', 'superseded-reject', 'superseded-resolve', 'edit-retains-snapshot', 'filter-retains-snapshot', 'normal-reject', 'normal-resolve', 'normal-warning'];
async function calculate(page, pattern) {
  await page.fill('#inputField', pattern);
  await page.click('#calcBtn');
  await page.waitForFunction(() => document.querySelector('#stopBtn').hidden && document.querySelectorAll('.result-row').length > 0);
}
async function click(page, selector) {
  await page.locator(selector).evaluate(node => { node.focus(); node.click(); });
}
async function settle(page, index, success) {
  await page.evaluate(async ({ index, success }) => {
    const pending = window.__copyProbe.pending[index];
    if (!pending) throw new Error('Missing native copy ' + index);
    if (success) pending.resolve(); else pending.reject(new Error('denied'));
    await new Promise(resolve => setTimeout(resolve, 0));
  }, { index, success });
}
try {
  for (const mode of ['row', 'page']) {
    for (const scenario of scenarios) {
      const context = await browser.newContext();
      const row = { label: 'card-copy-race', browser: browserName, mode, scenario, status: 'failed' };
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/googletagmanager.com/**', route => route.abort());
        const response = await page.goto(baseUrl + '/tools/card_number_new/', { waitUntil: 'load' });
        assert.equal(response.status(), 200);
        await calculate(page, scenario === 'normal-warning' ? '6222****?' : '6222****');
        if (scenario === 'normal-warning') assert.match(await page.locator('#toast').textContent(), /计算时忽略不支持字符/, 'starting calculation preserves new input-normalization feedback');
        assert.equal(await page.locator('.result-row').count(), 200, 'bounded first page ready');
        const selector = mode === 'row' ? '.result-row:first-child' : '#copyPageBtn';
        await page.evaluate(() => {
          window.__copyProbe = { pending: [], legacy: [], failLegacy: false };
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
            writeText(text) { return new Promise((resolve, reject) => window.__copyProbe.pending.push({ text, resolve, reject })); }
          } });
          document.execCommand = command => {
            if (command !== 'copy') throw new Error('Unexpected command');
            window.__copyProbe.legacy.push(document.activeElement.value);
            return !window.__copyProbe.failLegacy;
          };
        });
        await click(page, selector);
        const expected = await page.evaluate(() => window.__copyProbe.pending[0].text);
        assert.ok(expected);
        if (mode === 'row') assert.equal(expected, await page.locator(selector).getAttribute('data-clipboard'));
        else assert.equal(expected.split('\n').length, 200, 'page copy keeps every row');
        if (scenario.startsWith('superseded')) {
          await click(page, mode === 'row' ? '#copyPageBtn' : '.result-row:first-child');
          await page.evaluate(() => { window.__copyProbe.failLegacy = true; });
          await settle(page, 1, scenario === 'superseded-reject');
          const status = await page.locator('#toast').textContent();
          const legacy = await page.evaluate(() => [...window.__copyProbe.legacy]);
          if (scenario === 'superseded-reject') assert.match(status, /成功/);
          else assert.match(status, /失败/);
          await settle(page, 0, scenario === 'superseded-resolve');
          assert.deepEqual(await page.evaluate(() => window.__copyProbe.legacy), legacy, 'older copy cannot fall back after a newer copy');
          assert.equal(await page.locator('#toast').textContent(), status, 'older completion cannot replace newer feedback');
        } else {
          const retains = scenario.endsWith('retains-snapshot') || scenario.startsWith('normal-');
          if (scenario.startsWith('clear')) await page.click('#clearBtn');
          if (scenario.startsWith('recalculate')) await calculate(page, '4111**');
          if (scenario.startsWith('page-')) await page.click('#nextBtn');
          if (scenario === 'edit-retains-snapshot') await page.fill('#inputField', '1234');
          if (scenario === 'filter-retains-snapshot') {
            await page.click('#toggleAdvBtn');
            await page.check('#excludeOdd');
          }
          const before = await page.evaluate(() => ({ input: document.querySelector('#inputField').value, output: document.querySelector('#result-container').innerHTML, count: document.querySelector('#resultCount').textContent, status: document.querySelector('#toast').textContent }));
          await settle(page, 0, scenario.endsWith('resolve'));
          assert.deepEqual(await page.evaluate(() => window.__copyProbe.legacy), retains && !scenario.endsWith('resolve') ? [expected] : [], 'fallback belongs to the visible calculation snapshot');
          if (retains) assert.match(await page.locator('#toast').textContent(), /成功/);
          else assert.equal(await page.locator('#toast').textContent(), before.status, 'obsolete copy has no feedback');
          assert.deepEqual(await page.evaluate(() => ({ input: document.querySelector('#inputField').value, output: document.querySelector('#result-container').innerHTML, count: document.querySelector('#resultCount').textContent })), { input: before.input, output: before.output, count: before.count });
        }
        assert.equal(await page.locator('textarea[readonly]').count(), 0, 'no copy helper leak');
        assert.deepEqual(errors, []);
        row.status = 'passed';
      } catch (error) {
        row.message = error instanceof Error ? error.message : String(error);
      } finally {
        rows.push(row);
        console.log(JSON.stringify(row));
        await context.close();
      }
    }
  }
} finally { await browser.close(); }
const failures = rows.filter(row => row.status !== 'passed');
console.log(JSON.stringify({ label: 'card-copy-summary', browser: browserName, total: rows.length, passed: rows.length - failures.length, failed: failures.length }));
if (process.env.EXPECT_BASELINE === '1') {
  for (const mode of ['row', 'page']) {
    assert.ok(failures.some(row => row.mode === mode && row.scenario === 'clear-reject'));
    assert.ok(failures.some(row => row.mode === mode && row.scenario === 'superseded-resolve'));
    assert.equal(failures.filter(row => row.mode === mode && (row.scenario.endsWith('retains-snapshot') || row.scenario.startsWith('normal-'))).length, 0, 'ordinary copies and retained-result policy must pass');
  }
  console.log('Card baseline races reproduced; retained-result controls pass. NOT candidate acceptance.');
} else assert.deepEqual(failures, [], 'card clipboard regressions');
