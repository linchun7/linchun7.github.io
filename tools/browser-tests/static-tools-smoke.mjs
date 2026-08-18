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

async function routePconline(page, payload) {
    await page.route('**/whois.pconline.com.cn/**', async (route) => {
        const callback = new URL(route.request().url()).searchParams.get('callback');
        assert.ok(callback, 'PConline JSONP callback should be present');
        await route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: `${callback}(${JSON.stringify(payload)});`
        });
    });
}

async function routeSohu(page, payload) {
    await page.route('**/pv.sohu.com/cityjson**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: `var returnCitySN = ${JSON.stringify(payload)};`
        });
    });
}

async function createMyIpContext() {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        class PrivacyPeerConnection {
            constructor() {
                this.onicecandidate = null;
                this.onicecandidateerror = null;
            }
            createDataChannel() {}
            async createOffer() { return { type: 'offer', sdp: '' }; }
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
    return context;
}

async function testMyIpSplitRouting() {
    const context = await createMyIpContext();
    const page = await context.newPage();
    const pageErrors = [];
    let domesticFallbackCalls = 0;
    page.on('pageerror', (error) => pageErrors.push(error));

    await routePconline(page, {
        ip: '203.0.113.10',
        pro: '四川省',
        city: '成都市',
        region: '',
        addr: '四川省成都市 示例运营商'
    });
    await page.route('**/pv.sohu.com/cityjson**', async (route) => {
        domesticFallbackCalls += 1;
        await route.abort();
    });
    await routeJson(page, '**/api.ip.sb/**', {
        ip: '198.51.100.20',
        country: 'Japan',
        region: 'Tokyo',
        city: 'Tokyo',
        isp: 'Example Proxy'
    });
    await routeJson(page, '**/api.ipify.org/**', { ip: '198.51.100.20' });
    await routeJson(page, '**/api6.ipify.org/**', { ip: '2001:db8::20' });
    await page.route('**/ipwho.is/**', (route) => route.abort());
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(domesticFallbackCalls, 0, 'Sohu fallback should not run when PConline succeeds');
    assert.equal(await page.locator('#domestic-ipv4').textContent(), '203.0.113.10');
    assert.equal(await page.locator('#international-ipv4').textContent(), '198.51.100.20');
    assert.equal(await page.locator('#international-ipv6').textContent(), '2001:db8::20');
    assert.match(await page.locator('#summary-main').textContent(), /国内 \/ 国际不同出口/);
    assert.equal(await page.locator('#summary-routing').textContent(), '国内 / 国际不同出口');
    assert.equal(await page.locator('#webrtc-status').textContent(), '隐私保护');
    assert.equal(pageErrors.length, 0, `myip split page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpDomesticFallbackAndOptionalIpv6() {
    const context = await createMyIpContext();
    const page = await context.newPage();
    const pageErrors = [];
    let domesticPrimaryAttempts = 0;
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.route('**/whois.pconline.com.cn/**', async (route) => {
        domesticPrimaryAttempts += 1;
        await route.abort();
    });
    await routeSohu(page, {
        cip: '203.0.113.30',
        cid: '510100',
        cname: '四川省成都市'
    });
    await routeJson(page, '**/api.ip.sb/**', { error: 'temporary' }, 503);
    await routeJson(page, '**/api.ipify.org/**', { ip: '198.51.100.77' });
    await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await page.route('**/ipwho.is/**', (route) => route.abort());
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(domesticPrimaryAttempts, 2, 'PConline should retry once before Sohu fallback');
    assert.equal(await page.locator('#source-domestic-status').textContent(), '备用成功');
    assert.equal(await page.locator('#domestic-ipv4').textContent(), '203.0.113.30');
    assert.equal(await page.locator('#international-ipv4').textContent(), '198.51.100.77');
    assert.equal(await page.locator('#source-ipify6-status').textContent(), '未检测到');
    assert.equal(await page.locator('#source-fallback-status').textContent(), '待命');
    assert.equal(pageErrors.length, 0, `myip fallback page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpDifferentFamiliesAreNotSplit() {
    const context = await createMyIpContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await routePconline(page, {
        ip: '203.0.113.80',
        pro: '广东省',
        city: '深圳市',
        region: '',
        addr: '广东省深圳市 示例运营商'
    });
    await page.route('**/pv.sohu.com/cityjson**', (route) => route.abort());
    await routeJson(page, '**/api.ip.sb/**', {
        ip: '2001:db8::80',
        country: 'Singapore',
        region: 'Singapore',
        city: 'Singapore',
        isp: 'Example IPv6 Proxy'
    });
    await routeJson(page, '**/api.ipify.org/**', { error: 'no ipv4' }, 503);
    await routeJson(page, '**/api6.ipify.org/**', { ip: '2001:db8::80' });
    await page.route('**/ipwho.is/**', (route) => route.abort());
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-routing')?.textContent === '地址族不同');

    assert.equal(await page.locator('#summary-status').textContent(), '已获取');
    assert.equal(await page.locator('#domestic-ipv4').textContent(), '203.0.113.80');
    assert.equal(await page.locator('#international-ipv6').textContent(), '2001:db8::80');
    assert.match(await page.locator('#summary-detail').textContent(), /IPv4 与 IPv6 不同本身不能证明存在代理分流/);
    assert.equal(pageErrors.length, 0, `myip family page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpAllFailuresReachFinalState() {
    const context = await createMyIpContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.route('**/whois.pconline.com.cn/**', (route) => route.abort());
    await page.route('**/pv.sohu.com/cityjson**', (route) => route.abort());
    for (const pattern of [
        '**/api.ip.sb/**',
        '**/api.ipify.org/**',
        '**/ipwho.is/**'
    ]) {
        await routeJson(page, pattern, { error: 'unavailable' }, 503);
    }
    await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '未确认');

    assert.equal(await page.locator('#summary-routing').textContent(), '无法判断');
    assert.match(await page.locator('#summary-main').textContent(), /未能确认当前公网出口/);
    assert.equal(await page.locator('#domestic-status').textContent(), '未确认');
    assert.equal(await page.locator('#international-status').textContent(), '未确认');
    assert.equal(await page.locator('#source-ipify6-status').textContent(), '未检测到');
    assert.equal(pageErrors.length, 0, `myip failure page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIp() {
    await testMyIpSplitRouting();
    await testMyIpDomesticFallbackAndOptionalIpv6();
    await testMyIpDifferentFamiliesAreNotSplit();
    await testMyIpAllFailuresReachFinalState();
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
