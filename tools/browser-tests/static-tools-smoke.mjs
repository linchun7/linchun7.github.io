await import('./adversarial-interactions-regression.mjs');

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function routeIpip(page, ip, location = ['中国', '四川省', '成都市', '', '电信']) {
    await routeJson(page, '**/myip.ipip.net/json**', {
        ret: 'ok',
        data: { ip, location }
    });
}

async function routeDomesticPool(page, ip, {
    province = '四川省',
    city = '成都市',
    operator = '电信'
} = {}) {
    await routeIpip(page, ip, ['中国', province, city, '', operator]);
}

async function abortDomesticPool(page) {
    await page.route('**/myip.ipip.net/json**', (route) => route.abort());
}

async function routeCommonInternational(page, ipv4, ipv6 = null, backupIpv4 = ipv4) {
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
        ip: backupIpv4,
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

    const methodNotAllowedResponse = await myIpProbeWorker.fetch({
        ...request,
        method: 'POST'
    });
    assert.equal(methodNotAllowedResponse.status, 405);
    assert.equal(methodNotAllowedResponse.headers.get('Allow'), 'GET, HEAD, OPTIONS');

    const missingHeadResponse = await myIpProbeWorker.fetch({
        ...request,
        method: 'HEAD',
        url: 'https://myip.example.workers.dev/not-found'
    });
    assert.equal(missingHeadResponse.status, 404);
    assert.equal(await missingHeadResponse.text(), '');

    const healthResponse = await myIpProbeWorker.fetch({
        ...request,
        url: 'https://myip.example.workers.dev/healthz'
    });
    assert.equal(healthResponse.status, 200);
    assert.deepEqual(await healthResponse.json(), { ok: true, service: 'linchun-myip-probe' });
}

async function testMyIpDomesticAndInternationalSources() {
    const domesticIp = '61.139.2.69';
    const internationalIp = '64.118.146.90';
    const internationalIpv6 = '2404:c140:2005::6f:87ed';
    const { context, page, pageErrors } = await createPage({ stunIp: domesticIp });

    await routeDomesticPool(page, domesticIp);
    await routeCommonInternational(page, internationalIp, internationalIpv6);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');
    await page.waitForFunction(() => document.querySelector('#source-localref-status')?.textContent === '已获取');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), domesticIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#international-ipv6').textContent(), internationalIpv6);

    assert.equal(await page.locator('#source-ipip-status').textContent(), '采用');
    assert.match(await page.locator('#domestic-detail').textContent(), /四川省/);
    assert.equal(await page.locator('#source-pconline-status').count(), 0);
    assert.equal(await page.locator('#source-sohu-status').count(), 0);
    assert.equal(await page.locator('#source-tencent-status').count(), 0);

    assert.equal(await page.locator('#source-firstparty-status').textContent(), '采用');
    assert.equal(await page.locator('#source-ipsb-status').textContent(), '一致');
    assert.equal(await page.locator('#source-ipify4-status').textContent(), '一致');
    assert.equal(await page.locator('#source-backup-status').textContent(), '一致');
    assert.match(await page.locator('#international-detail').textContent(), /4 个来源一致/);

    const summaryMain = await page.locator('#summary-main').textContent();
    const summaryDetail = await page.locator('#summary-detail').textContent();
    assert.doesNotMatch(summaryMain, new RegExp(escapeRegex(domesticIp)));
    assert.doesNotMatch(summaryMain, new RegExp(escapeRegex(internationalIp)));
    assert.doesNotMatch(summaryDetail, new RegExp(escapeRegex(domesticIp)));
    assert.doesNotMatch(summaryDetail, new RegExp(escapeRegex(internationalIp)));

    assert.equal(await page.locator('#source-ipw-status').count(), 0, 'IPW should be removed from the public source pool');
    assert.equal(await page.locator('details.details-card').getAttribute('open'), '');
    assert.equal(pageErrors.length, 0, `myip source-pool page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpKeepsOriginalIpv6WhenCloudflareUsesPseudoIpv4() {
    const domesticIp = '61.139.2.69';
    const pseudoIpv4 = '240.16.0.1';
    const originalIpv6 = '2404:c140:2005::6f:87ed';
    const { context, page, pageErrors } = await createPage();

    await routeDomesticPool(page, domesticIp);
    await routeFirstParty(page, {
        ...firstPartyPayload(pseudoIpv4),
        originalIpv6
    });
    await page.route('**/api.ip.sb/**', (route) => route.abort());
    await page.route('**/api.ipify.org/**', (route) => route.abort());
    await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await page.route('**/ipwho.is/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#international-status')?.textContent === '已获取');

    assert.equal(await page.locator('#international-ipv4').textContent(), '未检测到');
    assert.equal(await page.locator('#international-ipv6').textContent(), originalIpv6);
    assert.equal(await page.locator('#source-firstparty-status').textContent(), '采用');
    assert.equal(await page.locator('#summary-main').textContent(), '国内外 IP 均已获取');
    assert.equal(pageErrors.length, 0, `myip pseudo-IPv4 page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpRejectsInvalidDomesticAndUsesLocalReference() {
    const localReferenceIp = '171.214.166.199';
    const internationalIp = '64.118.146.90';
    const { context, page, pageErrors } = await createPage({ stunIp: localReferenceIp });

    await routeIpip(page, '127.0.0.1');
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#domestic-status')?.textContent === '参考');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), localReferenceIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), '参考 IPv4');
    assert.equal(await page.locator('#source-ipip-status').textContent(), '已忽略');
    assert.equal(await page.locator('#source-localref-status').textContent(), '已获取');
    assert.notEqual(await page.locator('#domestic-ipv4').textContent(), '127.0.0.1');
    assert.equal(pageErrors.length, 0, `myip invalid-domestic page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpInternationalPrimaryFallbackAndDifferentValues() {
    const domesticIp = '61.139.2.69';
    const adoptedInternationalIp = '64.118.146.90';
    const otherInternationalIp = '209.33.172.228';
    const { context, page, pageErrors } = await createPage();

    await routeDomesticPool(page, domesticIp);
    await routeFirstParty(page, { error: 'unavailable' }, 503);
    await routeJson(page, '**/api.ip.sb/**', {
        ip: adoptedInternationalIp,
        country: 'Japan',
        region: 'Tokyo',
        city: 'Tokyo',
        isp: 'Example Proxy'
    });
    await routeJson(page, '**/api.ipify.org/**', { ip: adoptedInternationalIp });
    await page.route('**/api6.ipify.org/**', (route) => route.abort());
    await routeJson(page, '**/ipwho.is/**', {
        success: true,
        ip: otherInternationalIp,
        country: 'Japan',
        region: 'Tokyo',
        city: 'Tokyo',
        connection: { isp: 'Other Proxy' }
    });

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(await page.locator('#international-ipv4').textContent(), adoptedInternationalIp);
    assert.equal(await page.locator('#source-firstparty-status').textContent(), '未响应');
    assert.equal(await page.locator('#source-ipsb-status').textContent(), '采用');
    assert.equal(await page.locator('#source-ipify4-status').textContent(), '一致');
    assert.equal(await page.locator('#source-backup-status').textContent(), '其他出口');
    assert.match(await page.locator('#international-detail').textContent(), /发现 2 个不同出口/);
    assert.match(await page.locator('#source-backup-detail').textContent(), new RegExp(escapeRegex(otherInternationalIp)));
    assert.equal(pageErrors.length, 0, `myip international-fallback page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpUsesLocalNetworkReferenceWhenDomesticPoolFails() {
    const localReferenceIp = '171.214.166.199';
    const internationalIp = '64.118.146.90';
    const { context, page, pageErrors } = await createPage({ stunIp: localReferenceIp });

    await abortDomesticPool(page);
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#domestic-status')?.textContent === '参考');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), localReferenceIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), '参考 IPv4');
    assert.equal(await page.locator('#source-localref-status').textContent(), '已获取');
    assert.match(await page.locator('#domestic-detail').textContent(), /不代表已确认的国内网站出口/);
    assert.equal(pageErrors.length, 0, `myip local-reference page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpAlwaysShowsSafeReferenceWhenDomesticPoolAndStunFail() {
    const internationalIp = '209.33.172.228';
    const { context, page, pageErrors } = await createPage({ disableRtc: true });

    await abortDomesticPool(page);
    await routeCommonInternational(page, internationalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#domestic-status')?.textContent === '参考');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), internationalIp);
    assert.equal(await page.locator('#domestic-ip-label').textContent(), '参考 IPv4');
    assert.equal(await page.locator('#source-localref-status').textContent(), '未获取');
    assert.notEqual(await page.locator('#summary-status').textContent(), '已分流');
    assert.equal(pageErrors.length, 0, `myip safe-reference page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpNormalizesEquivalentIpv4Text() {
    const canonicalIp = '8.8.8.8';
    const nonCanonicalIp = '08.08.08.08';
    const { context, page, pageErrors } = await createPage();

    await routeDomesticPool(page, canonicalIp, {
        province: '',
        city: '',
        operator: ''
    });
    await routeCommonInternational(page, nonCanonicalIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), canonicalIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), canonicalIp);
    assert.equal(pageErrors.length, 0, `myip IPv4 normalization page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpSameExit() {
    const commonIp = '8.8.8.8';
    const { context, page, pageErrors } = await createPage();

    await routeDomesticPool(page, commonIp, {
        province: '',
        city: '',
        operator: ''
    });
    await routeCommonInternational(page, commonIp);

    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), commonIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), commonIp);
    assert.match(await page.locator('#summary-main').textContent(), /国内外访问使用同一出口/);
    assert.equal(pageErrors.length, 0, `myip same-exit page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpSummaryUsesAllSuccessfulSources() {
    const commonIp = '8.8.8.8';
    const otherIp = '1.1.1.1';
    const { context, page, pageErrors } = await createPage({ disableRtc: true });

    await routeDomesticPool(page, commonIp);
    await routeCommonInternational(page, commonIp, null, otherIp);
    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');

    assert.equal(await page.locator('#domestic-ipv4').textContent(), commonIp);
    assert.equal(await page.locator('#international-ipv4').textContent(), commonIp, 'summary warning must not change the preferred source');
    assert.equal(await page.locator('#international-ipv6').textContent(), '未检测到');
    assert.equal(await page.locator('#source-firstparty-status').textContent(), '采用');
    assert.equal(await page.locator('#source-ipsb-status').textContent(), '一致');
    assert.equal(await page.locator('#source-ipify4-status').textContent(), '一致');
    assert.equal(await page.locator('#source-backup-status').textContent(), '其他出口');
    assert.match(await page.locator('#international-detail').textContent(), /发现 2 个不同出口/);
    assert.match(await page.locator('#summary-main').textContent(), /同协议来源.*不同出口/);
    assert.match(await page.locator('#summary-detail').textContent(), /来源优先级/);
    assert.match(await page.locator('#summary-status').getAttribute('class'), /status-warning/);
    assert.equal(pageErrors.length, 0, `myip all-source summary errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpSummaryKeepsProtocolFamiliesSeparate() {
    const commonIpv4 = '8.8.8.8';
    const preferredIpv6 = '2606:4700:4700::1111';
    const otherIpv6 = '2001:4860:4860::8888';
    const { context, page, pageErrors } = await createPage();

    await routeDomesticPool(page, commonIpv4);
    await routeCommonInternational(page, commonIpv4, preferredIpv6);
    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');
    assert.equal(await page.locator('#international-ipv6').textContent(), preferredIpv6, 'a different protocol family is not source disagreement');

    await routeFirstParty(page, { ...firstPartyPayload(commonIpv4), originalIpv6: preferredIpv6 });
    await routeJson(page, '**/api6.ipify.org/**', { ip: otherIpv6 });
    await page.click('#retry-all');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '已分流');
    assert.equal(await page.locator('#domestic-ipv4').textContent(), commonIpv4);
    assert.equal(await page.locator('#international-ipv4').textContent(), commonIpv4);
    assert.equal(await page.locator('#international-ipv6').textContent(), preferredIpv6);
    assert.equal(await page.locator('#source-ipify6-status').textContent(), '其他出口');
    assert.match(await page.locator('#summary-main').textContent(), /同协议来源.*不同出口/, 'IPv6 disagreement must remain visible even without a domestic IPv6 observation');
    assert.equal(pageErrors.length, 0, `myip protocol-family summary errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpSummaryHandlesMissingSourcesAndDomesticReference() {
    const commonIp = '8.8.8.8';
    const { context, page, pageErrors } = await createPage({ disableRtc: true });

    await routeDomesticPool(page, commonIp);
    await routeCommonInternational(page, commonIp);
    await page.route('**/api.ip.sb/**', (route) => route.abort());
    await page.route('**/ipwho.is/**', (route) => route.abort());
    await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');
    assert.match(await page.locator('#international-detail').textContent(), /2 个来源一致/);
    assert.equal(await page.locator('#source-backup-status').textContent(), '未响应', 'a failed source is not a different exit');

    await abortDomesticPool(page);
    await routeJson(page, '**/ipwho.is/**', { success: true, ip: '1.1.1.1' });
    await page.click('#retry-all');
    await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '部分结果');
    assert.equal(await page.locator('#domestic-status').textContent(), '参考');
    assert.equal(await page.locator('#summary-main').textContent(), '国际 IP 已获取，国内未确认');
    assert.match(await page.locator('#summary-detail').textContent(), /国际同协议来源.*不同出口.*国内路径仍未确认/);

    await page.route('**/myip.cfw3.workers.dev/v1/ip', (route) => route.abort());
    await page.route('**/api.ipify.org/**', (route) => route.abort());
    await page.route('**/ipwho.is/**', (route) => route.abort());
    await routeDomesticPool(page, commonIp);
    await page.click('#retry-all');
    await page.waitForFunction(() => document.querySelector('#summary-main')?.textContent === '国内 IP 已获取，国际未确认');
    assert.equal(await page.locator('#summary-status').textContent(), '部分结果');
    assert.equal(await page.locator('#summary-detail').textContent(), '', 'new runs must clear the previous source-disagreement explanation');
    assert.equal(await page.locator('#international-ipv4').textContent(), '未检测到');
    assert.equal(pageErrors.length, 0, `myip missing-source summary errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testMyIpRetryIgnoresOlderSuccessfulResults() {
    const { context, page, pageErrors } = await createPage({ disableRtc: true });
    const deferred = () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
    };
    const withRequestDeadline = async (promise, label) => {
        let timer;
        try {
            await Promise.race([
                promise,
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`${label} exceeded its 10s request deadline`)), 10000);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    };
    const releases = [deferred(), deferred()];
    const observed = [deferred(), deferred()];
    const completed = [deferred(), deferred()];
    const endpointRuns = new Map();
    const pendingCounts = [0, 0];
    const completedCounts = [0, 0];
    const patterns = [
        '**/myip.ipip.net/json**',
        '**/myip.cfw3.workers.dev/v1/ip',
        '**/api.ip.sb/**',
        '**/api.ipify.org/**',
        '**/api6.ipify.org/**',
        '**/ipwho.is/**'
    ];
    const holdResult = async (route) => {
        const host = new URL(route.request().url()).hostname;
        const run = endpointRuns.get(host) || 0;
        endpointRuns.set(host, run + 1);
        assert.ok(run < releases.length, `unexpected extra request to ${host}`);
        pendingCounts[run] += 1;
        if (pendingCounts[run] === patterns.length) observed[run].resolve();
        const { primaryIp, backupIp } = await releases[run].promise;
        let payload;
        if (host === 'myip.ipip.net') payload = { ret: 'ok', data: { ip: primaryIp, location: [] } };
        else if (host === 'myip.cfw3.workers.dev') payload = firstPartyPayload(primaryIp);
        else if (host === 'ipwho.is') payload = { success: true, ip: backupIp };
        else if (host === 'api6.ipify.org') payload = { ip: 'not-an-ip' };
        else payload = { ip: primaryIp };
        await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload) });
        completedCounts[run] += 1;
        if (completedCounts[run] === patterns.length) completed[run].resolve();
    };
    for (const pattern of patterns) await page.route(pattern, holdResult);

    try {
        await page.goto(`${baseUrl}/tools/myip/`, { waitUntil: 'domcontentloaded' });
        await withRequestDeadline(observed[0].promise, 'older request batch');
        await page.click('#retry-all');
        await withRequestDeadline(observed[1].promise, 'newer request batch');
        releases[1].resolve({ primaryIp: '9.9.9.9', backupIp: '9.9.9.9' });
        await withRequestDeadline(completed[1].promise, 'newer responses');
        await page.waitForFunction(() => document.querySelector('#summary-status')?.textContent === '同一出口');
        assert.equal(await page.locator('#international-ipv4').textContent(), '9.9.9.9');

        // The abandoned older run reports a conflict after the newer run is final.
        releases[0].resolve({ primaryIp: '8.8.8.8', backupIp: '1.1.1.1' });
        await withRequestDeadline(completed[0].promise, 'older responses');
        await page.waitForLoadState('networkidle');
        assert.equal(await page.locator('#domestic-ipv4').textContent(), '9.9.9.9');
        assert.equal(await page.locator('#international-ipv4').textContent(), '9.9.9.9');
        assert.equal(await page.locator('#summary-status').textContent(), '同一出口');
        assert.equal(await page.locator('#summary-detail').textContent(), '');
        assert.equal(await page.locator('#source-backup-status').textContent(), '一致');
        assert.match(await page.locator('#source-backup-detail').textContent(), /9\.9\.9\.9/);
        assert.equal(pageErrors.length, 0, `myip stale-run page errors: ${pageErrors.map(String).join('; ')}`);
    } finally {
        for (const release of releases) release.resolve({ primaryIp: '9.9.9.9', backupIp: '9.9.9.9' });
        await context.close();
    }
}

async function testMyIp() {
    const source = await readFile(new URL('../myip/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /createElement\(['"]script|whois\.pconline\.com\.cn|pv\.sohu\.com|r\.inews\.qq\.com/);

    await testMyIpDomesticAndInternationalSources();
    await testMyIpKeepsOriginalIpv6WhenCloudflareUsesPseudoIpv4();
    await testMyIpRejectsInvalidDomesticAndUsesLocalReference();
    await testMyIpInternationalPrimaryFallbackAndDifferentValues();
    await testMyIpUsesLocalNetworkReferenceWhenDomesticPoolFails();
    await testMyIpAlwaysShowsSafeReferenceWhenDomesticPoolAndStunFail();
    await testMyIpNormalizesEquivalentIpv4Text();
    await testMyIpSameExit();
    await testMyIpSummaryUsesAllSuccessfulSources();
    await testMyIpSummaryKeepsProtocolFamiliesSeparate();
    await testMyIpSummaryHandlesMissingSourcesAndDomesticReference();
    await testMyIpRetryIgnoresOlderSuccessfulResults();
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
