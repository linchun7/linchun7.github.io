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
        const url = new URL(route.request().url());
        const callback = url.searchParams.get('callback');
        assert.ok(callback, 'PConline JSONP callback should be present');
        assert.equal(url.searchParams.has('json'), false, 'PConline JSONP must not request raw json=true mode');
        await route.fulfill({
            status: 200,
            contentType: 'application/javascript; charset=utf-8',
            body: `if(window.${callback}) { ${callback}(${JSON.stringify(payload)}); }`
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

async function createPage({ stunIp = null, disableRtc = true } = {}) {
    const context = await browser.newContext();

    if (stunIp) {
        await context.addInitScript((ip) => {
            class ReferencePeerConnection {
                constructor() {
                    this.onicecandidate = null;
                    this.onicecandidateerror = null;
                }
                createDataChannel() {}
                async createOffer() { return { type: 'offer', sdp: '' }; }
                async setLocalDescription() {
                    setTimeout(() => {
                        if (!this.onicecandidate) return;
                        this.onicecandidate({
                            candidate: {
                                candidate: `candidate:1 1 udp 1686052607 ${ip} 54321 typ srflx raddr 0.0.0.0 rport 0`,
                                address: ip,
                                type: 'srflx'
                            }
                        });
                        this.onicecandidate({ candidate: null });
                    }, 0);
                }
                close() {}
            }
            Object.defineProperty(window, 'RTCPeerConnection', {
                configurable: true,
                writable: true,
                value: ReferencePeerConnection
            });
            Object.defineProperty(window, 'webkitRTCPeerConnection', {
                configurable: true,
                writable: true,
                value: undefined
            });
        }, stunIp);
    } else if (disableRtc) {
        await context.addInitScript(() => {
            Object.defineProperty(window, 'RTCPeerConnection', {
                configurable: true,
                writable: true,
                value: undefined
            });
            Object.defineProperty(window, 'webkitRTCPeerConnection', {
                configurable: true,
                writable: true,
                value: undefined
            });
        });
    }

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
    return { context, page, pageErrors };
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

async function testMyIpSplitRoutingAndInformationHierarchy() {
    const domesticIp = '61.139.2.69';
    const internationalIp = '64.118.146.90';
    const internationalIpv6 = '2404:c140:2005::6f:87ed';
    const { context, page, pageErrors } = await createPage({ stunIp: domesticIp });

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
    await page.waitForFunction(() => document.querySelector('#source-localref-status')?.textContent === '已获取');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), domesticIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), 'IPv4');
    assert.equal(await page.locator('#international-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#international-ipv6').textContent(), internationalIpv6);

    const summaryMain = await page.locator('#summary-main').textContent();
    const summaryDetail = await page.locator('#summary-detail').textContent();
    assert.match(summaryMain, /国内外访问使用不同出口/);
    assert.doesNotMatch(summaryMain, new RegExp(escapeRegex(domesticIp)));
    assert.doesNotMatch(summaryMain, new RegExp(escapeRegex(internationalIp)));
    assert.doesNotMatch(summaryDetail, new RegExp(escapeRegex(domesticIp)));
    assert.doesNotMatch(summaryDetail, new RegExp(escapeRegex(internationalIp)));

    const domesticDetail = await page.locator('#domestic-detail').textContent();
    const internationalDetail = await page.locator('#international-detail').textContent();
    assert.match(domesticDetail, /四川省/);
    assert.match(domesticDetail, /成都市/);
    assert.match(domesticDetail, /示例运营商/);
    assert.doesNotMatch(domesticDetail, new RegExp(escapeRegex(domesticIp)));
    assert.match(internationalDetail, /JP/);
    assert.match(internationalDetail, /Tokyo/);
    assert.match(internationalDetail, /AS138997/);
    assert.match(internationalDetail, /Example Proxy/);
    assert.doesNotMatch(internationalDetail, new RegExp(escapeRegex(internationalIp)));

    const pconlineDetail = await page.locator('#source-pconline-detail').textContent();
    const firstPartyDetail = await page.locator('#source-firstparty-detail').textContent();
    const localRefDetail = await page.locator('#source-localref-detail').textContent();
    assert.match(pconlineDetail, /whois\.pconline\.com\.cn/);
    assert.match(pconlineDetail, new RegExp(escapeRegex(domesticIp)));
    assert.match(firstPartyDetail, /myip\.cfw3\.workers\.dev/);
    assert.match(firstPartyDetail, new RegExp(escapeRegex(internationalIp)));
    assert.match(localRefDetail, /stun\.cloudflare\.com/);
    assert.match(localRefDetail, new RegExp(escapeRegex(domesticIp)));
    assert.match(localRefDetail, /不参与分流判断/);

    assert.equal(await page.locator('#source-ipw-status').textContent(), '备用正常');
    assert.equal(await page.locator('#source-localref-status').textContent(), '已获取');
    assert.equal(await page.locator('#source-backup-status').textContent(), '备用正常');
    assert.equal(await page.locator('details.details-card').getAttribute('open'), '');
    assert.equal(await page.locator('#webrtc-status').count(), 0, 'WebRTC diagnostics should not be exposed as a standalone UI section');
    assert.equal(pageErrors.length, 0, `myip split page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpRejectsLoopbackAndUsesDomesticBackup() {
    const domesticBackupIp = '202.96.209.5';
    const internationalIp = '64.118.146.90';
    const { context, page, pageErrors } = await createPage({ stunIp: '171.214.166.199' });

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
    assert.equal(await page.locator('#source-pconline-status').textContent(), '已忽略');
    assert.match(await page.locator('#source-pconline-detail').textContent(), /非公网 IP/);
    assert.equal(await page.locator('#source-ipw-status').textContent(), '备用正常');
    assert.equal(await page.locator('#source-localref-status').textContent(), '已获取');
    assert.notEqual(await page.locator('#domestic-ipv4').textContent(), '127.0.0.1');
    assert.equal(pageErrors.length, 0, `myip loopback page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpUsesLocalNetworkReferenceWhenDomesticServicesFail() {
    const localReferenceIp = '171.214.166.199';
    const internationalIp = '64.118.146.90';
    const { context, page, pageErrors } = await createPage({ stunIp: localReferenceIp });

    await page.route('**/whois.pconline.com.cn/**', (route) => route.abort());
    await page.route('**/4.ipw.cn/**', (route) => route.abort());
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#domestic-status')?.textContent === '参考');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), localReferenceIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), '参考 IPv4');
    assert.equal(await page.locator('#source-localref-status').textContent(), '已获取');
    assert.match(await page.locator('#source-localref-detail').textContent(), new RegExp(escapeRegex(localReferenceIp)));
    assert.match(await page.locator('#domestic-detail').textContent(), /不代表已确认的国内网站出口/);
    assert.match(await page.locator('#summary-detail').textContent(), /不参与分流判断/);
    assert.equal(pageErrors.length, 0, `myip local-reference page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpAlwaysShowsSafeReferenceWhenDomesticPathCannotBeConfirmed() {
    const internationalIp = '209.33.172.228';
    const { context, page, pageErrors } = await createPage({ disableRtc: true });

    await page.route('**/whois.pconline.com.cn/**', (route) => route.abort());
    await page.route('**/4.ipw.cn/**', (route) => route.abort());
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#domestic-status')?.textContent === '参考');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), '参考 IPv4');
    assert.equal(await page.locator('#source-localref-status').textContent(), '未获取');
    assert.match(await page.locator('#source-localref-detail').textContent(), /STUN/);
    assert.match(await page.locator('#domestic-detail').textContent(), /国内路径未确认/);
    assert.notEqual(await page.locator('#summary-status').textContent(), '已分流');
    assert.equal(pageErrors.length, 0, `myip safe-reference page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpSameExit() {
    const commonIp = '8.8.8.8';
    const { context, page, pageErrors } = await createPage();

    await routePconline(page, { ip: commonIp, pro: '', city: '', region: '', addr: '' });
    await routeText(page, '**/4.ipw.cn/**', commonIp);
    await routeCommonInternational(page, commonIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), commonIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), commonIp);
    assert.match(await page.locator('#summary-main').textContent(), /国内外访问使用同一出口/);
    assert.doesNotMatch(await page.locator('#summary-detail').textContent(), new RegExp(escapeRegex(commonIp)));
    assert.equal(pageErrors.length, 0, `myip same-exit page errors: ${pageErrors.map(String).join('; ')}`);

    await context.close();
}

async function testMyIpBackupFailureDoesNotBreakPrimary() {
    const domesticIp = '61.139.2.69';
    const internationalIp = '64.118.146.90';
    const { context, page, pageErrors } = await createPage();

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
    await testMyIpSplitRoutingAndInformationHierarchy();
    await testMyIpRejectsLoopbackAndUsesDomesticBackup();
    await testMyIpUsesLocalNetworkReferenceWhenDomesticServicesFail();
    await testMyIpAlwaysShowsSafeReferenceWhenDomesticPathCannotBeConfirmed();
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
