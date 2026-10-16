import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const tools = [
  { name: 'pinyin', input: '#inputInfo', output: '#result1', copy: '[data-result="result1"]', nextCopy: '[data-result="result2"]', status: '#toast', first: '汉字', second: '中国' },
  { name: 'rmb_converter', input: '#inputmoney', output: '#result1', copy: '#copyBtn', status: '#alertText', first: '123.45', second: '678.90' },
  { name: 'space', input: '#info', output: '#result', copy: '#copyBtn', status: '#alertText', first: '\n中文ABC\n下一行test\n', second: '\n中文XYZ\n下一行check\n' }
];
const scenarios = ['edit-reject', 'clear-reject', 'same-value-reject', 'aba-reject', 'composition-reject', 'edit-resolve', 'clear-resolve', 'superseded-reject', 'superseded-failure', 'normal-reject', 'normal-resolve', 'fallback-false', 'fallback-throw', 'legacy-only'];
const browser = await browserType.launch({ headless: true });
const results = [];

async function output(page, tool) {
  return page.locator(tool.output).evaluate(node => node instanceof HTMLTextAreaElement ? node.value : node.textContent.trim());
}
async function fill(page, tool, value, processResult = true) {
  await page.fill(tool.input, value);
  if (tool.name === 'space' && processResult) {
    await page.click('#addBtn');
    await page.waitForFunction(() => document.querySelector('#result').value !== '' && !document.querySelector('#addBtn').hasAttribute('aria-busy'));
  }
}
async function copy(page, selector) {
  await page.locator(selector).evaluate(node => { node.focus(); node.click(); });
}
async function settle(page, index, success) {
  await page.evaluate(async ({ index, success }) => {
    const pending = window.__clipboardProbe.pending[index];
    if (!pending) throw new Error('Expected pending native write ' + index);
    if (success) pending.resolve();
    else pending.reject(new Error('permission denied'));
    await new Promise(resolve => setTimeout(resolve, 0));
  }, { index, success });
}

try {
  for (const tool of tools) {
    for (const scenario of scenarios) {
      const context = await browser.newContext();
      const row = { label: 'clipboard-race', browser: browserName, tool: tool.name, scenario, status: 'failed' };
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/googletagmanager.com/**', route => route.abort());
        const response = await page.goto(baseUrl + '/tools/' + tool.name + '/', { waitUntil: 'load' });
        assert.equal(response.status(), 200);
        if (tool.name === 'pinyin') await page.waitForFunction(() => typeof window.pinyinPro?.pinyin === 'function');
        await fill(page, tool, tool.first);
        const expected = await output(page, tool);
        assert.ok(expected && !expected.includes('等待输入'), 'fixture has an actual result');
        await page.evaluate(({ legacyOnly, legacyMode }) => {
          window.__clipboardProbe = { pending: [], legacy: [], legacyMode };
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: legacyOnly ? undefined : {
            writeText(text) {
              return new Promise((resolve, reject) => window.__clipboardProbe.pending.push({ text, resolve, reject }));
            }
          } });
          document.execCommand = command => {
            if (command !== 'copy') throw new Error('Unexpected legacy command');
            const probe = window.__clipboardProbe;
            probe.legacy.push(document.activeElement?.value);
            if (probe.legacyMode === 'throw') throw new Error('legacy unavailable');
            return probe.legacyMode !== 'false';
          };
        }, { legacyOnly: scenario === 'legacy-only', legacyMode: scenario === 'fallback-throw' ? 'throw' : ['fallback-false', 'superseded-failure'].includes(scenario) ? 'false' : 'success' });
        await copy(page, tool.copy);

        if (scenario === 'legacy-only') {
          assert.deepEqual(await page.evaluate(() => window.__clipboardProbe.legacy), [expected], 'legacy copy preserves exact result including newlines');
          assert.equal(await page.locator(tool.status).textContent(), '已复制');
        } else {
          assert.equal(await page.evaluate(() => window.__clipboardProbe.pending.length), 1, 'one native write');
          assert.equal(await page.evaluate(() => window.__clipboardProbe.pending[0].text), expected, 'native copy preserves exact result');
          if (scenario.startsWith('superseded')) {
            await copy(page, tool.nextCopy || tool.copy);
            assert.equal(await page.evaluate(() => window.__clipboardProbe.pending.length), 2);
            await settle(page, 1, scenario === 'superseded-reject');
            const currentStatus = await page.locator(tool.status).textContent();
            const currentLegacy = await page.evaluate(() => [...window.__clipboardProbe.legacy]);
            assert.equal(currentStatus, scenario === 'superseded-reject' ? '已复制' : tool.name === 'pinyin' ? '复制失败，请手动复制' : '复制失败');
            await settle(page, 0, scenario === 'superseded-failure');
            assert.deepEqual(await page.evaluate(() => window.__clipboardProbe.legacy), currentLegacy, 'superseded native denial must not perform a stale legacy write');
            assert.equal(await page.locator(tool.status).textContent(), currentStatus, 'older completion cannot replace latest copy feedback');
          } else if (['normal-reject', 'normal-resolve', 'fallback-false', 'fallback-throw'].includes(scenario)) {
            await settle(page, 0, scenario === 'normal-resolve');
            const expectedLegacy = scenario === 'normal-resolve' ? [] : [expected];
            assert.deepEqual(await page.evaluate(() => window.__clipboardProbe.legacy), expectedLegacy);
            const failed = scenario.startsWith('fallback-');
            assert.equal(await page.locator(tool.status).textContent(), failed ? tool.name === 'pinyin' ? '复制失败，请手动复制' : '复制失败' : '已复制');
            assert.equal(await page.locator(tool.copy).evaluate(node => document.activeElement === node), true, 'current fallback restores focus');
          } else {
            if (scenario.startsWith('clear')) await page.click('#clearBtn');
            else if (scenario === 'composition-reject') await page.locator(tool.input).dispatchEvent('compositionstart');
            else if (scenario === 'same-value-reject') await page.locator(tool.input).dispatchEvent('input');
            else {
              await fill(page, tool, tool.second, false);
              if (scenario === 'aba-reject') await fill(page, tool, tool.first, false);
            }
            await page.locator(tool.input).evaluate(node => { node.focus(); node.setSelectionRange(0, 1); });
            const before = await page.evaluate(({ input, output, status }) => {
              const node = document.querySelector(input), result = document.querySelector(output);
              return { value: node.value, start: node.selectionStart, end: node.selectionEnd, status: document.querySelector(status).textContent, output: result instanceof HTMLTextAreaElement ? result.value : result.textContent };
            }, tool);
            await settle(page, 0, scenario.endsWith('resolve'));
            assert.deepEqual(await page.evaluate(() => window.__clipboardProbe.legacy), [], 'invalidated copy must not write stale text through legacy fallback');
            const after = await page.evaluate(({ input, output, status }) => {
              const node = document.querySelector(input), result = document.querySelector(output);
              return { value: node.value, start: node.selectionStart, end: node.selectionEnd, status: document.querySelector(status).textContent, output: result instanceof HTMLTextAreaElement ? result.value : result.textContent };
            }, tool);
            assert.deepEqual(after, before, 'stale completion cannot alter newer input, selection, result or feedback');
            assert.equal(await page.locator(tool.input).evaluate(node => document.activeElement === node), true);
          }
        }
        assert.equal(await page.locator('textarea[readonly][style*="position: fixed"]').count(), 0, 'no leaked clipboard helper');
        assert.deepEqual(errors, [], 'no runtime errors');
        row.status = 'passed';
      } catch (error) {
        row.message = error instanceof Error ? error.message : String(error);
      } finally {
        results.push(row);
        console.log(JSON.stringify(row));
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
const failed = results.filter(row => row.status !== 'passed');
console.log(JSON.stringify({ label: 'clipboard-race-summary', browser: browserName, total: results.length, passed: results.length - failed.length, failed: failed.length }));
if (process.env.EXPECT_BASELINE === '1') {
  for (const tool of tools) {
    assert.ok(failed.some(row => row.tool === tool.name && row.scenario === 'edit-reject'), tool.name + ': reproduce stale fallback');
    assert.ok(failed.some(row => row.tool === tool.name && row.scenario === 'superseded-failure'), tool.name + ': reproduce stale feedback');
    assert.equal(failed.filter(row => row.tool === tool.name && ['normal-reject', 'normal-resolve', 'fallback-false', 'fallback-throw', 'legacy-only'].includes(row.scenario)).length, 0, tool.name + ': all ordinary-copy controls pass');
  }
  console.log('Baseline defects reproduced with ordinary-copy controls passing. This is NOT candidate acceptance.');
} else {
  assert.deepEqual(failed, [], 'clipboard lifecycle regressions');
}
