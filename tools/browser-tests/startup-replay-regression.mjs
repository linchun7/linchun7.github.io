import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
  for (const tool of ['renovation_calculator', 'hospital_rank']) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname.endsWith('/hospital_rank/data/rankings.json')) requests.push(request.url());
      });
      await page.route('**/googletagmanager.com/**', route => route.abort());
      await page.addInitScript(() => {
        window.__startupReplay = { bindings: {}, renders: 0, trustedClicks: 0 };
        const add = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function (type, listener, options) {
          if ((this.id === 'calculateBtn' && type === 'click') ||
              (this.id === 'yearSelect' && type === 'change') ||
              (this.id === 'hospitalSearch' && type === 'input')) {
            const key = this.id + ':' + type;
            window.__startupReplay.bindings[key] = (window.__startupReplay.bindings[key] || 0) + 1;
          }
          return add.call(this, type, listener, options);
        };
        add.call(document, 'click', event => {
          if (event.target?.id === 'calculateBtn' && event.isTrusted) window.__startupReplay.trustedClicks++;
        }, true);
      });
      const response = await page.goto(baseUrl + '/tools/' + tool + '/', { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await page.waitForFunction(tool => tool === 'renovation_calculator'
        ? (window.__startupReplay.bindings['calculateBtn:click'] || 0) > 0
        : !document.getElementById('yearSelect').disabled, tool);
      await page.waitForLoadState('networkidle');
      const before = await page.evaluate(() => structuredClone(window.__startupReplay.bindings));
      const requestsBefore = requests.length;
      let actual;
      if (tool === 'renovation_calculator') {
        await page.evaluate(() => {
          const render = window.renderTable;
          window.renderTable = function (...args) {
            window.__startupReplay.renders++;
            return render.apply(this, args);
          };
        });
        await page.fill('#loanAmount', '100000.01');
        await page.fill('#loanTerm', '12');
        await page.fill('#serviceFee', '0.25');
        await page.click('#calculateBtn');
        const initial = await page.evaluate(() => ({ result: JSON.stringify(window.lastExportData), renders: window.__startupReplay.renders }));
        await page.evaluate(() => {
          document.dispatchEvent(new Event('DOMContentLoaded'));
          document.dispatchEvent(new Event('DOMContentLoaded'));
        });
        await page.click('#calculateBtn');
        const clickRenders = await page.evaluate(() => window.__startupReplay.renders);
        await page.locator('#serviceFee').press('Enter');
        actual = await page.evaluate(() => ({
          trace: window.__startupReplay, result: JSON.stringify(window.lastExportData),
          rows: document.querySelectorAll('tbody tr').length
        }));
        console.log(JSON.stringify({ label: 'startup-replay', browser: browserName, tool, before, firstClickRenders: initial.renders, clickRenders, after: actual.trace }));
        assert.deepEqual(before, { 'calculateBtn:click': 1 }, 'natural startup binds one calculate handler');
        assert.deepEqual(actual.trace.bindings, before, 'replayed readiness events cannot rebind controls');
        assert.equal(initial.renders, 1, 'one trusted click renders once');
        assert.equal(clickRenders, 2, 'second trusted click renders once');
        assert.equal(actual.trace.renders, 3, 'Enter submits exactly once after readiness replay');
        assert.equal(actual.trace.trustedClicks, 2);
        assert.equal(actual.rows, 13);
        assert.equal(actual.result, initial.result, 'complete computed result is unchanged');
      } else {
        await page.evaluate(() => {
          const display = window.displayHospitals;
          window.displayHospitals = function (...args) {
            window.__startupReplay.renders++;
            return display.apply(this, args);
          };
        });
        await page.selectOption('#yearSelect', '2020');
        await page.fill('#hospitalSearch', '北京');
        await page.waitForFunction(() => window.__startupReplay.renders >= 2);
        const selected = await page.evaluate(() => ({ year: document.getElementById('yearSelect').value, text: document.getElementById('hospitalList').textContent }));
        await page.evaluate(() => {
          document.dispatchEvent(new Event('DOMContentLoaded'));
          document.dispatchEvent(new Event('DOMContentLoaded'));
        });
        await page.waitForLoadState('networkidle');
        actual = await page.evaluate(() => ({
          trace: window.__startupReplay, year: document.getElementById('yearSelect').value,
          query: document.getElementById('hospitalSearch').value,
          text: document.getElementById('hospitalList').textContent,
          disabled: document.getElementById('yearSelect').disabled
        }));
        console.log(JSON.stringify({ label: 'startup-replay', browser: browserName, tool, before, after: actual.trace, requestsBefore, requestsAfter: requests.length, selectedYear: selected.year, finalYear: actual.year }));
        assert.deepEqual(before, { 'yearSelect:change': 1, 'hospitalSearch:input': 1 });
        assert.deepEqual(actual.trace.bindings, before, 'readiness replay does not duplicate filters');
        assert.equal(requestsBefore, 1, 'one initial ranking request');
        assert.equal(requests.length, requestsBefore, 'readiness replay never refetches data');
        assert.equal(actual.year, selected.year, 'selected year survives replay');
        assert.equal(actual.query, '北京');
        assert.equal(actual.text, selected.text, 'filtered results survive replay');
        assert.equal(actual.disabled, false);
      }
      assert.deepEqual(errors, [], tool + ' runtime errors');
    } catch (error) {
      failures.push({ tool, message: error instanceof Error ? error.message : String(error) });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(failures, [], 'startup replay failures');
  console.log('Startup replay regression passed (' + browserName + ').');
} finally {
  await browser.close();
}
