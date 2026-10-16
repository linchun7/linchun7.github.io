import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
  for (const scenario of ['load-before-reject', 'load-before-resolve', 'load-after-resolve']) {
    const context = await browser.newContext();
    let releaseLoad;
    const gate = new Promise(resolve => { releaseLoad = resolve; });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/googletagmanager.com/**', route => route.abort());
      // A test-only same-origin image keeps the browser's REAL load pending.
      // Never replace application bytes or synthesize a load event. Third-party
      // analytics may be blocked by browsers and are not a reliable load gate.
      await page.route('**/__clipboard-load-gate.png', async route => { await gate; await route.abort(); });
      await page.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const image = document.createElement('img');
          image.alt = ''; image.hidden = true;
          image.src = '/__clipboard-load-gate.png';
          document.body.appendChild(image);
          window.__loadGateImage = image;
        }, { once: true });
      });
      const response = await page.goto(baseUrl + '/tools/pinyin/', { waitUntil: 'domcontentloaded' });
      assert.equal(response.status(), 200);
      await page.waitForFunction(() => typeof window.pinyinPro?.pinyin === 'function' && window.__loadGateImage?.isConnected);
      assert.notEqual(await page.evaluate(() => document.readyState), 'complete', 'real page load is still pending');
      await page.fill('#inputInfo', '汉字');
      assert.equal(await page.locator('#result1').textContent(), 'han zi');
      await page.evaluate(() => {
        window.__lateCopy = { legacy: [] };
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText(text) {
            window.__lateCopy.text = text;
            return new Promise((resolve, reject) => Object.assign(window.__lateCopy, { resolve, reject }));
          }
        } });
        document.execCommand = command => {
          if (command !== 'copy') throw new Error('Unexpected copy command');
          window.__lateCopy.legacy.push(document.activeElement.value);
          return true;
        };
        const button = document.querySelector('[data-result="result1"]');
        button.focus(); button.click();
      });
      const settle = success => page.evaluate(async success => {
        if (success) window.__lateCopy.resolve();
        else window.__lateCopy.reject(new Error('permission denied'));
        await new Promise(resolve => setTimeout(resolve, 0));
      }, success);
      if (scenario === 'load-after-resolve') await settle(true);
      releaseLoad();
      await page.waitForLoadState('load');
      if (scenario !== 'load-after-resolve') await settle(scenario === 'load-before-resolve');
      assert.equal(await page.locator('#toast').textContent(), '已复制', 'unchanged load render preserves current copy feedback');
      assert.equal(await page.locator('#result1').textContent(), 'han zi');
      assert.equal(await page.inputValue('#inputInfo'), '汉字');
      assert.deepEqual(await page.evaluate(() => window.__lateCopy.legacy), scenario === 'load-before-reject' ? ['han zi'] : [], 'current denied request still uses the valid fallback');
      assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-result')), 'result1');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ label: 'pinyin-late-load-copy', browser: browserName, scenario, status: 'passed' }));
    } catch (error) {
      failures.push({ scenario, message: error instanceof Error ? error.message : String(error) });
    } finally {
      releaseLoad();
      await context.close();
    }
  }
} finally { await browser.close(); }
assert.deepEqual(failures, [], 'actual late-load copy regression');
