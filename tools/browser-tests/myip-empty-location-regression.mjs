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
    // Exercise provider parsing, adoption, final summaries and retry through the real page.
    // Near-prefix controls preserve existing behavior, not a claim of actual routability.
    const addressCases = [
        ['discard-base', '100::', false],
        ['discard-expanded', '0100:0:0:0:8000:0:0:1', false],
        ['discard-last', '100:0:0:0:ffff:ffff:ffff:ffff', false],
        ['discard-neighbor', '100:0:0:2::1', true],
        ['benchmark-base', '2001:2::', false],
        ['benchmark-expanded', '2001:0002:0000:abcd:1234:0000:0000:0001', false],
        ['benchmark-last', '2001:2:0:ffff:ffff:ffff:ffff:ffff', false],
        ['benchmark-neighbor-in-non-global-parent', '2001:2:1::1', false],
        ['documentation-base', '3fff::', false],
        ['documentation-expanded', '3FFF:0001:ABCD:0000:0000:0000:0000:0001', false],
        ['documentation-last', '3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', false],
        ['documentation-neighbor', '3fff:1000::1', true],
        ['local-translation-base', '64:ff9b:1::', false],
        ['local-translation-expanded', '0064:FF9B:0001:1234:0:0:0:1', false],
        ['local-translation-last', '64:ff9b:1:ffff:ffff:ffff:ffff:ffff', false],
        ['local-translation-neighbor', '64:ff9b:2::1', true],
        ['global-translation', '64:ff9b::808:808', true],
        ['dummy-base', '100:0:0:1::', false],
        ['dummy-expanded', '0100:0000:0000:0001:8000:0000:0000:0001', false],
        ['dummy-last', '100:0:0:1:ffff:ffff:ffff:ffff', false],
        ['srv6-base', '5f00::', false],
        ['srv6-expanded', '5F00:1234:5678:0000:0000:0000:0000:0001', false],
        ['srv6-last', '5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false],
        ['srv6-before', '5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true],
        ['srv6-after', '5f01::1', true],
        ['protocol-parent-middle', '2001:100::1', false],
        ['protocol-parent-last', '2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', false],
        ['protocol-parent-after', '2001:200::1', true],
        ['teredo-na-preserved', '2001::1234', true],
        ['anycast-pcp', '2001:1::1', true],
        ['anycast-turn', '2001:1::2', true],
        ['anycast-dnssd-expanded', '2001:0001:0000:0000:0000:0000:0000:0003', true],
        ['anycast-before', '2001:1::', false],
        ['anycast-after', '2001:1::4', false],
        ['anycast-nonzero-middle', '2001:1:0:0:0:0:1:1', false],
        ['amt-last', '2001:3:ffff:ffff:ffff:ffff:ffff:ffff', true],
        ['as112-before', '2001:4:111:ffff:ffff:ffff:ffff:ffff', false],
        ['as112-last', '2001:4:112:ffff:ffff:ffff:ffff:ffff', true],
        ['as112-after', '2001:4:113::', false],
        ['orchid-before', '2001:1f:ffff:ffff:ffff:ffff:ffff:ffff', false],
        ['orchid-last', '2001:2f:ffff:ffff:ffff:ffff:ffff:ffff', true],
        ['dets-last', '2001:3f:ffff:ffff:ffff:ffff:ffff:ffff', true],
        ['dets-after', '2001:40::', false],
        ['six-to-four-na-preserved', '2002::1', true],
        ['global-v6', '2001:4860:4860::8888', true],
        ['global-amt', '2001:3::1', true],
        ['global-as112', '2001:4:112::1', true],
        ['global-orchid', '2001:20::1', true],
        ['global-dets', '2001:30::1', true],
        ['relay-before', '192.88.99.1', true],
        ['relay-exact', '192.88.99.2', false],
        ['relay-after', '192.88.99.3', true],
        ['prior-documentation', '2001:db8::1', false],
        ['prior-private', 'fd00::1', false]
    ];
    const scenarios = [
        ...addressCases.map(([label, ip, accepted]) => ({ label, ip, accepted, mode: 'all-sources' })),
        { label: 'invalid-original-with-valid-v4', ip: '100::1', mode: 'original' },
        { label: 'invalid-primary-valid-fallback', ip: '3fff:fff::1', mode: 'fallback' },
        { label: 'invalid-local-translation-original', ip: '64:ff9b:1::1', mode: 'original' },
        { label: 'invalid-dummy-original', ip: '100:0:0:1::1', mode: 'original' },
        { label: 'invalid-srv6-original', ip: '5f00::1', mode: 'original' },
        { label: 'invalid-srv6-primary-valid-fallback', ip: '5f00::1', mode: 'fallback' }
    ];
    for (const scenario of scenarios) {
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            const pageErrors = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.route('**/*', route => new URL(route.request().url()).origin === new URL(base).origin ? route.continue() : route.abort());
            await page.addInitScript(({ ip, mode }) => {
                window.RTCPeerConnection = undefined;
                window.webkitRTCPeerConnection = undefined;
                window.fetch = async url => {
                    const host = new URL(String(url)).hostname;
                    let data;
                    if (host === 'myip.ipip.net') data = { ret: 'ok', data: { ip: mode === 'all-sources' ? ip : '8.8.8.8', location: [] } };
                    else if (host === 'myip.cfw3.workers.dev') data = {
                        schemaVersion: 1, role: 'international-first-party',
                        ip: mode === 'original' ? '8.8.8.8' : ip,
                        ...(mode === 'original' ? { originalIpv6: ip } : {})
                    };
                    else if (host === 'api6.ipify.org') data = { ip: mode === 'fallback' ? '2001:4860:4860::8888' : ip };
                    else if (mode === 'fallback') throw new TypeError('Simulated offline provider');
                    else data = { ip: mode === 'original' ? '8.8.8.8' : ip, success: true };
                    return { ok: true, json: async () => data };
                };
            }, scenario);
            await page.goto(`${base}/tools/myip/`, { waitUntil: 'domcontentloaded' });
            for (let run = 0; run < 2; run++) {
                if (run) await page.click('#retry-all');
                await page.waitForFunction(() => document.getElementById('summary-status').textContent !== '检测中');
                if (scenario.mode === 'all-sources') {
                    const accepted = scenario.accepted;
                    const normalized = scenario.ip.includes(':') ? new URL(`http://[${scenario.ip}]/`).hostname.slice(1, -1) : scenario.ip;
                    assert.equal(await page.locator('#domestic-status').textContent(), accepted ? '已获取' : '未获取');
                    assert.equal(await page.locator('#international-status').textContent(), accepted ? '已获取' : '未获取');
                    assert.equal(await page.locator('#domestic-ipv4').textContent(), accepted ? normalized : '未检测到');
                    const familyField = scenario.ip.includes(':') ? '#international-ipv6' : '#international-ipv4';
                    assert.equal(await page.locator(familyField).textContent(), accepted ? normalized : '未检测到');
                    assert.equal(await page.locator('#summary-status').textContent(), accepted ? '同一出口' : '未获取');
                    assert.equal(await page.locator('#summary-main').textContent(), accepted ? '国内外访问使用同一出口' : '暂未获取可用结果');
                    if (!accepted) {
                        assert.equal(await page.locator('#source-ipip-status').textContent(), '已忽略');
                        assert.match(await page.locator('#source-firstparty-detail').textContent(), /非公网 IP/);
                    }
                } else {
                    assert.equal(await page.locator('#domestic-ipv4').textContent(), '8.8.8.8');
                    assert.equal(await page.locator('#international-status').textContent(), '已获取');
                    if (scenario.mode === 'original') {
                        assert.equal(await page.locator('#international-ipv4').textContent(), '8.8.8.8');
                        assert.equal(await page.locator('#international-ipv6').textContent(), '未检测到');
                        assert.equal(await page.locator('#summary-status').textContent(), '同一出口');
                    } else {
                        assert.equal(await page.locator('#international-ipv6').textContent(), '2001:4860:4860::8888');
                        assert.match(await page.locator('#source-firstparty-detail').textContent(), /非公网 IP/);
                        assert.equal(await page.locator('#source-ipify6-status').textContent(), '采用');
                    }
                }
            }
            assert.deepEqual(pageErrors, []);
        } catch (error) {
            failures.push(`${scenario.label}: ${error.message}`);
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'IP location and special-prefix regressions');
    console.log(`IP location and special-prefix regression passed (${browserName}).`);
} finally {
    await browser.close();
}
