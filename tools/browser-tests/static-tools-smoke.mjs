import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import myIpProbeWorker from '../myip/worker/src/index.js';

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

async function routeText(page, pattern, payload, status = 200) {
    await page.route(pattern, async (route) => {
        await route.fulfill({
            status,
            contentType: 'text/plain; charset=utf-8',
            body: payload
        });
    });
}

function firstPartyPayload(ip, network = {}) {
    return {
        schemaVersion: 1,
        role: 'international-first-party',
        ip,
        family: ip.includes(':') ? 6 : 4,
        originalIpv6: null,
        network: {
            country: 'JP',
            region: 'Tokyo',
            city: 'Tokyo',
            asn: 138997,
            organization: 'Example Proxy',
            colo: 'NRT',
            ...network
        },
        observedAt: '2026-08-18T06:00:00.000Z'
    };
}

async function routeFirstParty(page, payload, status = 200) {
    await routeJson(page, '**/myip.cfw3.workers.dev/v1/ip', payload, status);
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

async function routeCommonInternational(page, ipv4, ipv6 = null) {
    await routeFirstParty(page, firstPartyPayload(ipv4));
    await routeJson(page, '**/api.ip.sb/**', {
        ip: ipv4,
        country: 'Japan',
        region: 'Tokyo',
        city: 'Tokyo',
        isp: 'Example Proxy'
    });
    await routeJson(page, '**/api.ipify.org/**', { ip: ipv4 });
    if (ipv6) await routeJson(page, '**/api6.ipify.org/**', { ip: ipv6 });
    else await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await routeJson(page, '**/ipwho.is/**', {
        success: true,
        ip: ipv4,
        country: 'Japan',
        region: 'Tokyo',
        city: 'Tokyo',
        connection: { isp: 'Example Proxy' }
    });
}

async function createPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
    return { context, page, pageErrors };
}

async function testMyIpWorkerProbe() {
    const request = {
        method: 'GET',
        url: 'https://myip.example.workers.dev/v1/ip',
        headers: new Headers({
            Origin: 'https://www.linchun.com.cn',
            'CF-Connecting-IP': '198.51.100.42'
        }),
        cf: {
            country: 'JP',
            region: 'Tokyo',
            regionCode: '13',
            city: 'Tokyo',
            timezone: 'Asia/Tokyo',
            asn: 64500,
            asOrganization: 'Example Network',
            colo: 'NRT',
            clientTcpRtt: 18
        }
    };

    const response = await myIpProbeWorker.fetch(request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://www.linchun.com.cn');
    assert.match(response.headers.get('Cache-Control') || '', /no-store/);
    const payload = await response.json();
    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.role, 'international-first-party');
    assert.equal(payload.ip, '198.51.100.42');

    const forbiddenResponse = await myIpProbeWorker.fetch({
        ...request,
        headers: new Headers({
            Origin: 'https://untrusted.example',
            'CF-Connecting-IP': '198.51.100.42'
        })
    });
    assert.equal(forbiddenResponse.status, 403);

    const healthResponse = await myIpProbeWorker.fetch({
        ...request,
        url: 'https://myip.example.workers.dev/healthz'
    });
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, service: 'linchun-myip-probe' });
}

async function testMyIpSplitRouting() {
    const { context, page, pageErrors } = await createPage();
    const domesticIp = '61.139.2.69';
    const internationalIp = '64.118.146.90';
    const internationalIpv6 = '2404:c140:2005::6f:87ed';

    await routePconline(page, {
        ip: domesticIp,
        pro: '四川省',
        city: '成都市',
        region: '',
        addr: '四川省成都市 示例运营商'
    });
    await routeText(page, '**/4.ipw.cn/**', domesticIp);
    await routeCommonInternational(page, internationalIp, internationalIpv6);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), domesticIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#international-ipv6').textContent(), internationalIpv6);
    assert.equal(await page.locator('#source-ipw-status').textContent(), '备用正常');
    assert.equal(await page.locator('#source-backup-status').textContent(), '备用正常');
    assert.match(await page.locator('#summary-main').textContent(), /国内和国际网站使用不同 IP/);
    assert.match(await page.locator('#summary-detail').textContent(), new RegExp(domesticIp.replaceAll('.', '\\.')));
    assert.equal(await page.locator('#webrtc-status').count(), 0, 'WebRTC diagnostics should be removed from the simplified page');
    assert.equal(pageErrors.length, 0, `myip split page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpRejectsLoopbackAndUsesDomesticBackup() {
    const { context, page, pageErrors } = await createPage();
    const domesticBackupIp = '202.96.209.5';
    const internationalIp = '64.118.146.90';

    await routePconline(page, {
        ip: '127.0.0.1',
        pro: '',
        city: '',
        region: '',
        addr: ''
    });
    await routeText(page, '**/4.ipw.cn/**', domesticBackupIp);
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), domesticBackupIp);
    assert.equal(await page.locator('#source-pconline-status').textContent(), '未响应');
    assert.match(await page.locator('#source-pconline-detail').textContent(), /非公网 IP/);
    assert.equal(await page.locator('#source-ipw-status').textContent(), '备用正常');
    assert.notEqual(await page.locator('#domestic-ipv4').textContent(), '127.0.0.1');
    assert.equal(pageErrors.length, 0, `myip loopback page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpSameExit() {
    const { context, page, pageErrors } = await createPage();
    const commonIp = '8.8.8.8';

    await routePconline(page, { ip: commonIp, pro: '', city: '', region: '', addr: '' });
    await routeText(page, '**/4.ipw.cn/**', commonIp);
    await routeCommonInternational(page, commonIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), commonIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), commonIp);
    assert.match(await page.locator('#summary-main').textContent(), /使用同一个 IP/);
    assert.equal(pageErrors.length, 0, `myip same-exit page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpBackupFailureDoesNotBreakPrimary() {
    const { context, page, pageErrors } = await createPage();
    const domesticIp = '61.139.2.69';
    const internationalIp = '64.118.146.90';

    await routePconline(page, { ip: domesticIp, pro: '四川省', city: '成都市', region: '', addr: '' });
    await routeText(page, '**/4.ipw.cn/**', domesticIp);
    await routeFirstParty(page, firstPartyPayload(internationalIp));
    await routeJson(page, '**/api.ip.sb/**', { error: 'unavailable' }, 503);
    await routeJson(page, '**/api.ipify.org/**', { error: 'unavailable' }, 503);
    await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await routeJson(page, '**/ipwho.is/**', { success: false, message: 'rate limit' }, 429);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(await page.locator('#international-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#source-firstparty-status').textContent(), '正常');
    assert.equal(await page.locator('#source-backup-status').textContent(), '备用未响应');
    assert.equal(pageErrors.length, 0, `myip backup page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIp() {
    await testMyIpSplitRouting();
    await testMyIpRejectsLoopbackAndUsesDomesticBackup();
    await testMyIpSameExit();
    await testMyIpBackupFailureDoesNotBreakPrimary();
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
    await testMyIpWorkerProbe();
    await testMyIp();
    await testFinance();
    console.log(`Static tools smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
