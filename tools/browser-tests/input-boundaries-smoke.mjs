import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
let passed = 0;

async function check(name, tool, run, prepare = async () => {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route('**/googletagmanager.com/**', route => route.abort());
    try {
        await prepare(page);
        await page.goto(`${baseUrl}/tools/${tool}/`, { waitUntil: 'domcontentloaded' });
        await run(page);
        assert.deepEqual(errors, [], 'no unhandled browser errors');
        passed++;
        console.log(`PASS ${name}`);
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
        console.error(`FAIL ${name}: ${error.stack}`);
    } finally {
        await context.close();
    }
}

try {
    await check('legacy rejects empty and non-digit Luhn inputs', 'card_number', async page => {
        assert.equal(await page.evaluate(() => luhnCheck('')), false);
        assert.equal(await page.evaluate(() => luhnCheck('12x')), false);
        assert.equal(await page.evaluate(() => luhnCheck('79927398713')), true);
    });
    await check('legacy bounds rules without silently calculating a truncated card', 'card_number', async page => {
        await page.fill('#inputField', '0'.repeat(101));
        assert.equal((await page.locator('#result').textContent()).trim(), '');
        assert.match(await page.locator('#count').textContent(), /100/);
        assert.equal(await page.inputValue('#inputField'), '0'.repeat(101));
        await page.fill('#inputField', '７９９２７３９８７１３');
        assert.equal(await page.inputValue('#inputField'), '79927398713');
        assert.match(await page.locator('#result').textContent(), /7992 7398 713/);
    });
    await check('new card IME does not mutate unfinished input or submit on confirmation Enter', 'card_number_new', async page => {
        await page.evaluate(() => {
            const input = document.getElementById('inputField');
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.value = 'Ａ';
            input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
        });
        assert.equal(await page.inputValue('#inputField'), 'Ａ');
        assert.equal(await page.locator('#inputField').isDisabled(), false);
        await page.evaluate(() => document.getElementById('inputField').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
        assert.equal(await page.inputValue('#inputField'), 'A');
    });
    await check('RMB limits scientific expansion before calling the converter', 'rmb_converter', async page => {
        // Stub the expensive library so this regression is safe even on unfixed code.
        await page.evaluate(() => {
            window.__conversionCalls = 0;
            Nzh.cn.toMoney = () => { window.__conversionCalls++; return 'converted'; };
        });
        for (const input of ['1e1000000000', '1e-1000000000', '9'.repeat(2001)]) {
            await page.fill('#inputmoney', input);
            assert.equal(await page.locator('#result1').evaluate(el => el.classList.contains('error')), true, input.slice(0, 40));
        }
        assert.equal(await page.evaluate(() => window.__conversionCalls), 0);
        await page.evaluate(() => {
            const input = document.getElementById('inputmoney');
            input.value = '1e3';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(await page.evaluate(() => window.__conversionCalls), 1);
        assert.equal(await page.locator('#result1').textContent(), 'converted');
    });
    await check('RMB clipboard rejection falls back and removes its temporary textarea', 'rmb_converter', async page => {
        await page.fill('#inputmoney', '123.45');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
            document.execCommand = () => { window.__copied = document.querySelector('textarea').value; return true; };
        });
        await page.evaluate(() => {
            const button = document.getElementById('copyBtn');
            button.focus();
            button.click();
        });
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '已复制');
        assert.equal(await page.evaluate(() => window.__copied), await page.locator('#result1').textContent());
        assert.equal(await page.locator('textarea').count(), 0);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'copyBtn');
        await page.evaluate(() => { document.execCommand = () => { throw new Error('copy unavailable'); }; });
        await page.click('#copyBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '复制失败');
        assert.equal(await page.locator('textarea').count(), 0);
    });
    await check('financial dates preserve years below 100 and reject impossible dates', 'financial_calculator', async page => {
        await page.click('#tab3');
        await page.fill('#startDate', '0099-12-31');
        await page.fill('#endDate', '0100-01-01');
        await page.fill('#startNetValue', '1');
        await page.fill('#endNetValue', '1');
        await page.click('#calculate3');
        assert.match(await page.locator('#result3').textContent(), /持有 1 天/);
        // Native date inputs sanitize impossible dates, so test the parser independently of that UI protection.
        await page.evaluate(() => { document.getElementById('startDate').type = 'text'; });
        await page.fill('#startDate', '2026-02-30');
        await page.fill('#endDate', '2026-03-10');
        await page.click('#calculate3');
        assert.equal(await page.locator('#result3').evaluate(el => el.classList.contains('result-error')), true);
    });
    await check('financial rejects periods outside the exact integer range', 'financial_calculator', async page => {
        await page.fill('#principal1', '10000');
        await page.fill('#days1', '9007199254740992');
        await page.fill('#interest1', '100');
        await page.click('#calculate1');
        assert.equal(await page.locator('#result1').evaluate(el => el.classList.contains('result-error')), true);
    });
    await check('bank search treats half-width and full-width parentheses equally', 'bank_rank', async page => {
        await page.waitForFunction(() => !document.getElementById('bankSearch').disabled);
        await page.fill('#bankSearch', '（中国）');
        const fullWidthCount = await page.locator('#bankList tr.data-row').count();
        assert.ok(fullWidthCount > 0);
        await page.fill('#bankSearch', '(中国)');
        assert.equal(await page.locator('#bankList tr.data-row').count(), fullWidthCount);
    });
    for (const tool of ['bank_rank', 'hospital_rank']) {
        for (const phase of ['headers', 'body']) {
            await check(`${tool} falls back from stalled ${phase}`, tool, async page => {
                await page.waitForFunction(() => document.getElementById('dataStatus').textContent.includes('失败'));
                assert.match(await page.locator('#dataStatus').textContent(), /静态/);
                assert.ok(await page.locator('tr[data-static-prerendered="true"]').count() > 0);
                assert.equal(await page.locator('#yearSelect').isDisabled(), true);
                assert.ok(await page.evaluate(() => window.__requestAborts) > 0);
            }, page => page.addInitScript(phase => {
                const originalTimeout = window.setTimeout.bind(window);
                window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 15000 ? 30 : ms, ...args);
                const originalFetch = window.fetch.bind(window);
                window.__requestAborts = 0;
                window.fetch = (url, options = {}) => {
                    if (!String(url).includes('data/')) return originalFetch(url, options);
                    const pending = () => new Promise((resolve, reject) => {
                        const abort = () => { window.__requestAborts++; reject(new DOMException('aborted', 'AbortError')); };
                        if (options.signal?.aborted) abort();
                        else options.signal?.addEventListener('abort', abort, { once: true });
                    });
                    return phase === 'headers' ? pending() : Promise.resolve({ ok: true, json: pending });
                };
            }, phase));
        }
    }
    for (const withoutAbortController of [false, true]) {
        await check(`IP body deadline works ${withoutAbortController ? 'without' : 'with'} AbortController`, 'myip', async page => {
            await page.waitForFunction(() => document.getElementById('summary-status').textContent !== '检测中');
            assert.equal(await page.locator('#domestic-ipv4').textContent(), '未检测到');
            assert.equal(await page.locator('#international-ipv4').textContent(), '未检测到');
            assert.match(await page.locator('body').textContent(), /超时/);
            assert.ok(await page.evaluate(() => window.__bodyReads) > 0);
        }, page => page.addInitScript(withoutAbortController => {
            window.RTCPeerConnection = undefined;
            window.webkitRTCPeerConnection = undefined;
            if (withoutAbortController) window.AbortController = undefined;
            const originalTimeout = window.setTimeout.bind(window);
            window.setTimeout = (fn, ms, ...args) => originalTimeout(fn, [4500, 2800].includes(ms) ? 30 : ms, ...args);
            window.__bodyReads = 0;
            window.fetch = async () => ({ ok: true, json: () => { window.__bodyReads++; return new Promise(() => {}); } });
        }, withoutAbortController));
    }
    await check('spacing clipboard denial falls back without losing input or focus', 'space', async page => {
        await page.fill('#info', '中文 ABC');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } });
            document.execCommand = () => { window.__copied = document.querySelector('textarea[readonly]').value; return true; };
            const button = document.getElementById('copyBtn');
            button.focus();
            button.click();
        });
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '已复制');
        assert.equal(await page.evaluate(() => window.__copied), '中文 ABC');
        assert.equal(await page.locator('textarea').count(), 1);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'copyBtn');
        await page.evaluate(() => { document.execCommand = () => { throw new Error('unavailable'); }; });
        await page.click('#copyBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '复制失败');
        assert.equal(await page.locator('textarea').count(), 1);
        assert.equal(await page.inputValue('#info'), '中文 ABC');
    });
    const addresses = [
        ['0:0:0:0:0:0:0:1', null],
        ['0000:0000:0000:0000:0000:0000:0000:0000', null],
        ['0:0:0:0:0:ffff:a00:1', null],
        ['2001:0db8:0:0:0:0:0:1', null],
        ['2606:4700:4700::1111%eth0', null],
        ['2001:db80::1', '2001:db80::1'],
        ['2606:4700:4700:0000:0000:0000:0000:ABCD', '2606:4700:4700::abcd']
    ];
    for (const [ip, expected] of addresses) {
        await check(`IPv6 classification and normalization: ${ip}`, 'myip', async page => {
            await page.waitForFunction(() => document.getElementById('summary-status').textContent !== '检测中');
            assert.equal(await page.locator('#international-ipv6').textContent(), expected || '未检测到');
            if (expected) assert.match(await page.locator('#international-detail').textContent(), /来源一致/);
        }, page => page.addInitScript(ip => {
            window.RTCPeerConnection = undefined;
            window.webkitRTCPeerConnection = undefined;
            window.fetch = async () => ({ ok: true, json: async () => ({ schemaVersion: 1, role: 'international-first-party', ip, data: { ip, location: [] } }) });
        }, ip));
    }
    console.log(`Input boundary regressions (${browserName}): ${passed} passed, ${failures.length} failed`);
    assert.deepEqual(failures, []);
} finally {
    await browser.close();
}
