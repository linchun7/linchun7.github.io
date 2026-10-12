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

    await check('typed grouping spaces survive and generate the same number', async page => {
        await page.locator('#inputField').pressSequentially('7992 7398 713');
        assert.equal(await page.inputValue('#inputField'), '7992 7398 713');
        assert.equal(await page.locator('#validCount').textContent(), '11');
        await page.click('#calcBtn');
        await done(page);
        assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');
    });
    await check('middle ASCII edits preserve position and surrounding spaces', async page => {
        await page.fill('#inputField', '7992 398 713');
        await page.locator('#inputField').focus();
        await page.locator('#inputField').evaluate(input => input.setSelectionRange(5, 5));
        await page.keyboard.type('7');
        assert.equal(await page.inputValue('#inputField'), '7992 7398 713');
        assert.equal(await page.locator('#inputField').evaluate(input => input.selectionStart), 6);
        await page.keyboard.press('Backspace');
        assert.equal(await page.inputValue('#inputField'), '7992 398 713');
    });
    await check('full-width paste and repeated spaces keep normalization', async page => {
        await page.fill('#inputField', '７９９２　　７３９８　７１３');
        assert.equal(await page.inputValue('#inputField'), '7992 7398 713');
        assert.equal(await page.locator('#validCount').textContent(), '11');
        await page.click('#clearBtn');
        await page.locator('#inputField').pressSequentially('7992   7398  713');
        assert.equal(await page.inputValue('#inputField'), '7992 7398 713');
        await page.click('#calcBtn');
        await done(page);
        assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');
    });

    assert.deepEqual(failures, []);
} finally {
    await browser.close();
}
