import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
async function check(name, run) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/googletagmanager.com/**', route => route.abort());
    try {
        await page.goto(`${baseUrl}/tools/card_number_new/`, { waitUntil: 'domcontentloaded' });
        await run(page);
        assert.deepEqual(errors, [], 'no unhandled page errors');
        console.log(`PASS ${name}`);
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
        console.error(`FAIL ${name}: ${error.stack}`);
    } finally {
        await context.close();
    }
}
async function done(page) {
    await page.waitForFunction(() => document.getElementById('status-bar').textContent.includes('计算完成') && document.getElementById('stopBtn').hidden);
}
try {

    for (const mode of ['constructor', 'error', 'messageerror', 'error-message', 'meta-error']) {
        await check(`worker ${mode} clears pending count and recovers`, async page => {
            await page.evaluate(mode => {
                window.__originalCardWorker = window.Worker;
                window.Worker = class {
                    constructor() {
                        if (mode === 'constructor') throw new Error('worker unavailable');
                    }
                    terminate() {}
                    postMessage() {
                        queueMicrotask(() => {
                            if (mode === 'meta-error') this.onmessage({ data: { type: 'meta', expectedCount: '1' } });
                            if (mode === 'error') this.onerror({ message: 'worker unavailable', preventDefault() {} });
                            else if (mode === 'messageerror') this.onmessageerror();
                            else this.onmessage({ data: { type: 'error', message: 'worker unavailable' } });
                        });
                    }
                };
            }, mode);
            await page.fill('#inputField', '7992739871*');
            await page.click('#calcBtn');
            await page.waitForFunction(() => document.getElementById('status-bar').textContent.includes('计算失败'));
            assert.equal(await page.locator('#expectedCount').textContent(), mode === 'meta-error' ? '1' : '—');
            assert.equal(await page.locator('#resultCount').textContent(), '0');
            assert.equal(await page.locator('#inputField').isDisabled(), false);
            assert.equal(await page.locator('#calcBtn').isVisible(), true);
            assert.equal(await page.locator('#stopBtn').isVisible(), false);
            await page.evaluate(() => { window.Worker = window.__originalCardWorker; });
            await page.click('#calcBtn');
            await done(page);
            assert.equal(await page.locator('#expectedCount').textContent(), '1');
            assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');
        });
    }

    assert.deepEqual(failures, []);
} finally {
    await browser.close();
}
