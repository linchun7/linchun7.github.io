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

    for (const commitKey of ['Enter', 'Tab']) {
        await check(`page input clamps on ${commitKey}`, async page => {
            await page.fill('#inputField', '*****');
            await page.click('#calcBtn');
            await done(page);
            assert.equal(await page.locator('#totalPages').textContent(), '50');
            await page.fill('#pageInput', '999');
            await page.locator('#pageInput').press(commitKey);
            assert.equal(await page.inputValue('#pageInput'), '50');
            assert.equal(await page.locator('#nextBtn').isDisabled(), true);
            assert.equal(await page.locator('#prevBtn').isDisabled(), false);
            await page.fill('#pageInput', '');
            await page.locator('#pageInput').press(commitKey);
            assert.equal(await page.inputValue('#pageInput'), '1');
            assert.equal(await page.locator('#prevBtn').isDisabled(), true);
        });
    }

    assert.deepEqual(failures, []);
} finally {
    await browser.close();
}
