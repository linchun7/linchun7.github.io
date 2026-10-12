import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
    for (const locationCase of ['empty', 'missing']) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
            await page.addInitScript(locationCase => {
                window.RTCPeerConnection = undefined;
                window.webkitRTCPeerConnection = undefined;
                window.fetch = async url => {
                    const host = new URL(String(url)).hostname;
                    if (host === 'myip.ipip.net') {
                        const data = { ip: '8.8.8.8' };
                        if (locationCase === 'empty') data.location = [];
                        return { ok: true, json: async () => ({ ret: 'ok', data }) };
                    }
                    // Keep this regression entirely offline; all international providers fail.
                    throw new TypeError('Simulated offline provider');
                };
            }, locationCase);
            await page.goto(`${base}/tools/myip/`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.getElementById('summary-status').textContent === '部分结果');
            assert.equal(await page.locator('#domestic-ipv4').textContent(), '8.8.8.8');
            assert.equal(await page.locator('#domestic-status').textContent(), '已获取');
            assert.equal(await page.locator('#summary-main').textContent(), '国内 IP 已获取，国际未确认');
            assert.doesNotMatch(await page.locator('#domestic-detail').textContent(), /正在获取|检测中|请稍候/, 'a successful IP without location is final, not loading');
            assert.deepEqual(pageErrors, []);
        } catch (error) {
            failures.push(`${locationCase}: ${error.message}`);
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'IP empty-location regressions');
    console.log(`IP empty-location regression passed (${browserName}).`);
} finally {
    await browser.close();
}
