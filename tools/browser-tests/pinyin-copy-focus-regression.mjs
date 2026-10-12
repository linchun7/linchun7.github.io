import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
    for (const mode of ['success', 'false', 'throw']) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/googletagmanager.com/**', route => route.abort());
            await page.goto(`${baseUrl}/tools/pinyin/`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => typeof window.pinyinPro?.pinyin === 'function');
            await page.fill('#inputInfo', '汉字');
            assert.equal(await page.locator('#result2').textContent(), 'hàn zì');

            await page.evaluate(mode => {
                window.__copyCalls = 0;
                window.__copyValue = null;
                Object.defineProperty(navigator, 'clipboard', {
                    configurable: true,
                    value: { writeText: async () => { throw new Error('permission denied'); } }
                });
                document.execCommand = command => {
                    if (command !== 'copy') throw new Error('unexpected command');
                    window.__copyCalls++;
                    window.__copyValue = document.querySelector('textarea[readonly]')?.value;
                    if (mode === 'throw') throw new Error('copy unavailable');
                    return mode === 'success';
                };
                const button = document.querySelector('[data-result="result1"]');
                button.focus();
                button.click();
            }, mode);
            await page.waitForFunction(() => window.__copyCalls === 1);
            assert.equal(await page.evaluate(() => window.__copyValue), 'han zi', mode);
            assert.equal(await page.locator('textarea[readonly]').count(), 0, mode);
            assert.equal(await page.inputValue('#inputInfo'), '汉字', mode);
            assert.equal(
                await page.evaluate(() => document.activeElement?.getAttribute('data-result')),
                'result1',
                `fallback ${mode} must restore the initiating copy button's focus`
            );
            assert.equal(
                await page.locator('#toast').textContent(),
                mode === 'success' ? '已复制' : '复制失败，请手动复制',
                mode
            );
            await page.keyboard.press('Tab');
            assert.equal(
                await page.evaluate(() => document.activeElement?.getAttribute('data-result')),
                'result2',
                `fallback ${mode} must preserve sequential keyboard navigation`
            );
            assert.deepEqual(errors, []);
        } catch (error) {
            failures.push({ mode, message: error.message });
            console.error(JSON.stringify({ label: 'pinyin-copy-focus', browser: browserName, mode, status: 'failed', message: error.message }));
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'pinyin fallback-focus regressions');
    console.log(`Pinyin fallback-focus regression passed (${browserName}).`);
} finally {
    await browser.close();
}
