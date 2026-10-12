import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
    await page.goto(`${base}/tools/`, { waitUntil: 'domcontentloaded' });
    for (const width of [320, 600, 601, 620, 639, 768]) {
        await page.setViewportSize({ width, height: 844 });
        const geometry = await page.evaluate(() => ({
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            inputRight: document.getElementById('searchInput').getBoundingClientRect().right
        }));
        try {
            assert.ok(geometry.scrollWidth <= geometry.width + 1, `${width}px: page overflows (${JSON.stringify(geometry)})`);
            assert.ok(geometry.inputRight <= geometry.width + 1, `${width}px: search input leaves viewport`);
        } catch (error) {
            failures.push(error.message);
        }
    }
    assert.deepEqual(pageErrors, [], 'navigation must not produce page errors');
    assert.deepEqual(failures, [], 'navigation breakpoint regressions');
    console.log(`Navigation breakpoint regression passed (${browserName}).`);
} finally {
    await browser.close();
}
