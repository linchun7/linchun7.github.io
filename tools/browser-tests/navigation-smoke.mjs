import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(html, /<script\s+data-cfasync="false"\s+src="scripts\.js\?v=/, 'navigation starts in native script order');
const browser = await browserType.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 320, height: 844 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/googletagmanager.com/**', route => route.abort());
    await page.goto(`${base}/tools/`, { waitUntil: 'domcontentloaded' });
    const count = await page.locator('#toolList a').count();
    assert.ok(count >= 12);
    assert.equal(await page.locator('main').count(), 1);
    assert.equal(await page.getByRole('textbox', { name: '搜索工具' }).count(), 1);
    assert.equal(await page.locator('a[href$="/tools/card_number_new/"]').count(), 1);
    // This action intentionally runs at DOMContentLoaded, not after an arbitrary sleep.
    await page.fill('#searchInput', '复旦');
    await page.waitForFunction(() => document.querySelectorAll('#toolList a').length === 1);
    assert.match(await page.locator('#toolList').textContent(), /复旦/);
    await page.fill('#searchInput', 'ＩＣＬＯＵＤ');
    await page.waitForFunction(() => document.querySelector('#toolList a')?.textContent.includes('iCloud'));
    assert.equal(await page.locator('#toolList a').count(), 1);
    await page.fill('#searchInput', '<img src=x onerror=alert(1)>');
    await page.waitForFunction(() => document.getElementById('noResults').style.display === 'block');
    assert.equal(await page.locator('#toolList img').count(), 0);
    // Programmatic input bypasses maxlength; the search path must still bound its work.
    await page.evaluate(() => {
        const input = document.getElementById('searchInput');
        input.value = 'Z'.repeat(100000);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => currentKeyword.length === 160);
    await page.fill('#searchInput', '');
    await page.waitForFunction(expected => document.querySelectorAll('#toolList a').length === expected, count);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.deepEqual(errors, []);
    console.log(`Navigation smoke passed (${browserName}): startup, routes, accessibility, NFKC, injection and bounded search.`);
} finally {
    await browser.close();
}
