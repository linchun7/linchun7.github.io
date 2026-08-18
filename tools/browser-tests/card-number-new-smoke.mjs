import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function waitForDone(page) {
    await page.waitForFunction(() => {
        const status = document.querySelector('#status-bar');
        const stop = document.querySelector('#stopBtn');
        return status && !status.hidden && stop && stop.hidden;
    });
}

try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/card_number_new/`, { waitUntil: 'domcontentloaded' });

    await page.fill('#inputField', '７９９２７３９８７１＊?');
    assert.equal(await page.locator('#inputField').inputValue(), '7992739871*');
    assert.match(await page.locator('#toast').textContent(), /已删除不支持字符/);
    assert.match(await page.locator('#toast').textContent(), /\?/);

    await page.click('#calcBtn');
    await waitForDone(page);
    assert.equal(await page.locator('#expectedCount').textContent(), '1');
    assert.equal(await page.locator('#resultCount').textContent(), '1');
    assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');

    await page.click('#clearBtn');
    await page.fill('#inputField', '12aa');
    await page.click('#calcBtn');
    await waitForDone(page);
    assert.equal(await page.locator('#expectedCount').textContent(), '2');

    await page.click('#clearBtn');
    await page.fill('#inputField', '12**');
    await page.click('#calcBtn');
    await waitForDone(page);
    assert.equal(await page.locator('#expectedCount').textContent(), '10');

    assert.equal(pageErrors.length, 0, `card number page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
    console.log(`Card number smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
