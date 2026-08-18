import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function routeJson(page, pattern, payload, status = 200) {
    await page.route(pattern, (route) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) }));
}

async function installPrivacyWebRtc(context) {
    await context.addInitScript(() => {
        class PrivacyPeerConnection {
            constructor() { this.onicecandidate = null; this.onicecandidateerror = null; }
            createDataChannel() {}
            async createOffer() { return { type: 'offer', sdp: '' }; }
            async setLocalDescription() {
                setTimeout(() => {
                    if (!this.onicecandidate) return;
                    this.onicecandidate({ candidate: { candidate: 'candidate:1 1 udp 2122260223 device-123.local 54321 typ host', address: 'device-123.local', type: 'host' } });
                    this.onicecandidate({ candidate: null });
                }, 0);
            }
            close() {}
        }
        Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, writable: true, value: PrivacyPeerConnection });
        Object.defineProperty(window, 'webkitRTCPeerConnection', { configurable: true, writable: true, value: undefined });
    });
}

async function mockReachability(page) {
    for (const target of ['**/www.baidu.com/**', '**/github.com/favicon.ico*', '**/www.youtube.com/**']) {
        await page.route(target, (route) => route.fulfill({ status: 204, body: '' }));
    }
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
}

async function testMyIpSplitRouting() {
    const context = await browser.newContext();
    await installPrivacyWebRtc(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    await page.route('**/myip.ipip.net/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: '当前 IP：203.0.113.10  来自于：中国 四川 成都 示例运营商' }));
    await page.route('**/4.ipw.cn/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: '203.0.113.11' }));
    await routeJson(page, '**/api.ip.sb/**', { ip: '198.51.100.20', country: 'Japan', city: 'Tokyo', organization: 'Example Proxy' });
    await routeJson(page, '**/api64.ipify.org/**', { ip: '198.51.100.21' });
    await routeJson(page, '**/api.ipify.org/**', { ip: '198.51.100.20' });
    await routeJson(page, '**/api6.ipify.org/**', { ip: '2001:db8::20' });
    await mockReachability(page);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '分流生效');
    await page.waitForFunction(() => document.querySelector('#webrtc-status')?.textContent === '隐私保护');

    assert.equal(await page.locator('#route-cn-ip').textContent(), '203.0.113.10');
    assert.equal(await page.locator('#route-global-ip').textContent(), '198.51.100.20');
    assert.match(await page.locator('#summary-title-value').textContent(), /国内 \/ 国际分流出口/);
    assert.equal(await page.locator('#ipv4-ip').textContent(), '198.51.100.20');
    assert.equal(await page.locator('#ipv6-ip').textContent(), '2001:db8::20');
    assert.match(await page.locator('#webrtc-ip').textContent(), /本地地址已被浏览器隐藏/);
    assert.equal(pageErrors.length, 0, `myip split page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpFallbackAndTerminalState() {
    const context = await browser.newContext();
    await installPrivacyWebRtc(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    // Primary domestic and international sources fail; fallbacks must still finish the page.
    await page.route('**/myip.ipip.net/**', (route) => route.fulfill({ status: 503, body: 'temporary' }));
    await page.route('**/4.ipw.cn/**', (route) => route.fulfill({ status: 200, contentType: 'text/plain', body: '203.0.113.30' }));
    await page.route('**/api.ip.sb/**', (route) => route.fulfill({ status: 503, body: 'temporary' }));
    await routeJson(page, '**/api64.ipify.org/**', { ip: '203.0.113.30' });
    await routeJson(page, '**/api.ipify.org/**', { ip: '203.0.113.30' });
    await page.route('**/api6.ipify.org/**', (route) => route.fulfill({ status: 503, body: 'no ipv6' }));
    await mockReachability(page);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');
    await page.waitForFunction(() => document.querySelector('#ipv6-status')?.textContent === '未确认');

    assert.equal(await page.locator('#route-cn-ip').textContent(), '203.0.113.30');
    assert.match(await page.locator('#route-cn-source').textContent(), /IPW IPv4/);
    assert.equal(await page.locator('#route-global-ip').textContent(), '203.0.113.30');
    assert.match(await page.locator('#route-global-source').textContent(), /IPify/);
    assert.doesNotMatch(await page.locator('#summary-title-value').textContent(), /正在/);
    assert.equal(pageErrors.length, 0, `myip fallback page errors: ${pageErrors.map(String).join('; ')}`);
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
    await testMyIpSplitRouting();
    await testMyIpFallbackAndTerminalState();
    await testFinance();
    console.log(`Static tools smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
