import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function routeJson(page, pattern, payload, status = 200) {
    await page.route(pattern, async (route) => {
        await route.fulfill({
            status,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify(payload)
        });
    });
}

async function testMyIp() {
    const context = await browser.newContext();

    // Simulate Safari/WebKit privacy behavior: host candidate is an mDNS name,
    // while all public-IP providers continue to run independently.
    await context.addInitScript(() => {
        class PrivacyPeerConnection {
            constructor() {
                this.onicecandidate = null;
                this.onicecandidateerror = null;
            }
            createDataChannel() {}
            async createOffer() {
                return { type: 'offer', sdp: '' };
            }
            async setLocalDescription() {
                setTimeout(() => {
                    if (this.onicecandidate) {
                        this.onicecandidate({
                            candidate: {
                                candidate: 'candidate:1 1 udp 2122260223 device-123.local 54321 typ host',
                                address: 'device-123.local',
                                type: 'host'
                            }
                        });
                        this.onicecandidate({ candidate: null });
                    }
                }, 0);
            }
            close() {}
        }

        Object.defineProperty(window, 'RTCPeerConnection', {
            configurable: true,
            writable: true,
            value: PrivacyPeerConnection
        });
        Object.defineProperty(window, 'webkitRTCPeerConnection', {
            configurable: true,
            writable: true,
            value: undefined
        });
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await routeJson(page, '**/qifu-api.baidubce.com/**', {
        ip: '203.0.113.10',
        data: {
            country: '中国',
            prov: '四川省',
            city: '成都市',
            district: '',
            isp: '示例运营商'
        }
    });

    // One provider intentionally fails to prove failures are isolated.
    await routeJson(page, '**/api.ip.sb/**', { error: 'temporary' }, 503);

    await routeJson(page, '**/api64.ipify.org/**', { ip: '203.0.113.10' });
    await routeJson(page, '**/ipapi.co/**', {
        country_name: 'China',
        region: 'Sichuan',
        city: 'Chengdu',
        org: 'Example ISP'
    });

    for (const target of [
        '**/www.baidu.com/**',
        '**/music.163.com/**',
        '**/github.com/favicon.ico*',
        '**/www.youtube.com/**'
    ]) {
        await page.route(target, (route) => route.fulfill({ status: 204, body: '' }));
    }

    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });

    await page.waitForFunction(() => document.querySelector('#provider-baidu-status')?.textContent === '正常');
    await page.waitForFunction(() => document.querySelector('#provider-ipify-status')?.textContent === '正常');
    await page.waitForFunction(() => document.querySelector('#provider-ipsb-status')?.textContent === '失败');
    await page.waitForFunction(() => document.querySelector('#webrtc-status')?.textContent === '隐私保护');

    assert.equal(await page.locator('#provider-baidu-ip').textContent(), '203.0.113.10');
    assert.equal(await page.locator('#provider-ipify-ip').textContent(), '203.0.113.10');
    assert.match(await page.locator('#webrtc-ip').textContent(), /本地地址已被浏览器隐藏/);
    assert.equal(await page.locator('#summary-ip').textContent(), '203.0.113.10');
    assert.equal(pageErrors.length, 0, `myip page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testFinance() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/financial_calculator/`, { waitUntil: 'domcontentloaded' });

    await page.fill('#principal1', '10000');
    await page.fill('#days1', '30');
    await page.fill('#interest1', '100');
    await page.selectOption('#rateType1', '365');
    await page.click('#calculate1');
    assert.match(await page.locator('#result1').textContent(), /12\.17%/);

    await page.fill('#principal1', '0');
    await page.click('#calculate1');
    assert.match(await page.locator('#result1').textContent(), /本金必须大于 0/);

    await page.click('#tab3');
    await page.fill('#startDate', '2026-08-10');
    await page.fill('#endDate', '2026-08-09');
    await page.fill('#startNetValue', '1');
    await page.fill('#endNetValue', '1.1');
    await page.click('#calculate3');
    assert.match(await page.locator('#result3').textContent(), /终止日期必须晚于起始日期/);

    await page.click('#tab4');
    await page.fill('#principal3', '10000');
    await page.selectOption('#compoundingFrequency', 'monthly');
    await page.fill('#depositPeriod', '12');
    await page.fill('#annualRate3', '12');
    await page.selectOption('#rateType4', '365');
    await page.click('#calculate4');
    assert.match(await page.locator('#result4').textContent(), /11,268\.25/);
    assert.equal(await page.locator('#result4-table tbody tr').count(), 12);

    await page.fill('#depositPeriod', '2001');
    await page.click('#calculate4');
    assert.match(await page.locator('#result4-table').textContent(), /仅显示汇总结果/);

    assert.equal(pageErrors.length, 0, `finance page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

try {
    await testMyIp();
    await testFinance();
    console.log(`Static tools smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
