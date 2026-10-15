import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { pageContract, assertResource, isAnalyticsUrl, assertRequestsComplete, assertScheduleParity, ORIGIN } from './recent-optimizations-production.mjs';

const url = ORIGIN + '/tools/example/';
const html = '<!doctype html><html lang="zh-CN"><head><style>body{color:black}</style><link rel="stylesheet" href="style.css?v=1"></head><body><main><h1>Tool</h1></main><dialog id="historyDialog">History</dialog><script data-cfasync="false" src="app.js?v=1"></script><script data-cfasync="false">window.app=1;</script></body></html>';
test('acceptance preserves exact application bytes and declared asset URLs', () => {
    const original = pageContract(html, url);
    for (const [before, after] of [
        ['Tool', ' Tool'], ['History', 'History2'], ['body{color:black}', 'body{color:blue}'],
        ['style.css?v=1', 'style.css?v=2'], ['app.js?v=1', 'app.js?v=2'],
        ['window.app=1', 'window.app=2'], ['lang="zh-CN"', 'lang="en"']
    ]) assert.notDeepEqual(pageContract(html.replace(before, after), url), original);
});
test('unknown added scripts cannot replace exact declared-script acceptance', () => {
    assert.notDeepEqual(pageContract(html.replace('</body>', '<script src="https://analytics.example/cdn.js"></script></body>'), url), pageContract(html, url));
    for (const broken of ['<html><body>Cloudflare challenge</body></html>', html.replace('</body>', '<main>duplicate</main></body>')]) {
        assert.throws(() => pageContract(broken, url), /missing or duplicated application/);
    }
});
test('resource verification rejects even one changed byte', () => {
    const bytes = Buffer.from('shipped script\n');
    const resource = { path: 'tools/example/app.js', hash: createHash('sha256').update(bytes).digest('hex') };
    assert.doesNotThrow(() => assertResource(bytes, resource));
    assert.throws(() => assertResource(Buffer.from('shipped script \n'), resource), /production bytes differ/);
});

test('analytics isolation matches exact Google domains and their real www hosts', () => {
    for (const host of ['googletagmanager.com', 'www.googletagmanager.com', 'google-analytics.com', 'www.google-analytics.com', 'static.cloudflareinsights.com']) {
        assert.equal(isAnalyticsUrl('https://' + host + '/gtag/js?id=fixture'), true);
    }
    for (const host of ['www.linchun.com.cn', 'notgoogletagmanager.com', 'googletagmanager.com.example.org']) {
        assert.equal(isAnalyticsUrl('https://' + host + '/app.js'), false);
    }
});
test('an earlier successful resource cannot hide a later failed or header-pending request', () => {
    const css = ORIGIN + '/tools/example/style.css?v=1';
    const verified = new Set([css]);
    assert.doesNotThrow(() => assertRequestsComplete([{ url: css, status: 'verified' }], new Set([css]), verified));
    for (const status of ['failed', 'pending']) {
        assert.throws(() => assertRequestsComplete([
            { url: css, status: 'verified' }, { url: css, status }
        ], new Set([css]), verified), /each requested application resource/);
    }
    assert.throws(() => assertRequestsComplete([], new Set([css]), new Set()), /this context did not verify/);
});

test('only the exact evidenced Rocket Loader node and its matching nonce type may be decoded', () => {
    const nonce = 'ecea507af4b9fbe72be97350';
    const original = html.replace('data-cfasync="false" src="app.js?v=1"', 'src="app.js?v=1"');
    const loader = '<script src="/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js" data-cf-settings="' + nonce + '-|49" defer></script>';
    const transformed = original.replace('src="app.js?v=1">', 'src="app.js?v=1" type="' + nonce + '-text/javascript">').replace('</body>', loader + '</body>');
    assert.deepEqual(pageContract(transformed, url), pageContract(original, url));
    for (const changed of [
        transformed.replace('7d0fa10a', 'different'),
        transformed.replace('data-cf-settings="' + nonce, 'data-cf-settings="' + 'a'.repeat(24)),
        transformed.replace('app.js?v=1', 'app.js?v=2'),
        transformed.replace('window.app=1', 'window.app=2'),
        transformed.replace('src="app.js?v=1"', 'integrity="forged" src="app.js?v=1"')
    ]) assert.notDeepEqual(pageContract(changed, url), pageContract(original, url));
    assert.throws(() => pageContract(transformed.replace('</body>', loader + '</body>'), url), /duplicated observed/);
});
test('cross-engine APR ulps never permit a monetary or displayed-percentage change', () => {
    const expected = { apr: 4.235408700938681, totals: { totalPrincipal: 100 }, schedule: [{ month: 1, principal: 100, earlyRepaymentAPR: 4.235408700938681 }] };
    const actual = structuredClone(expected);
    actual.apr = 4.235408700938703;
    actual.schedule[0].earlyRepaymentAPR = actual.apr;
    assert.ok(assertScheduleParity(actual, expected) < 3e-14);
    const money = structuredClone(actual); money.schedule[0].principal += 0.01;
    assert.throws(() => assertScheduleParity(money, expected), /monetary/);
    const badRate = structuredClone(actual); badRate.apr += 0.001;
    assert.throws(() => assertScheduleParity(badRate, expected), /precision boundary/);
});

test('only the exact evidenced Cloudflare analytics tag is outside the application contract', () => {
    const beacon = "<script type=\"module\" src=\"https://static.cloudflareinsights.com/beacon.min.js/v4bc70e2c01a94c73b74392e4234840661791215815920\" integrity=\"sha512-L0ha0OXavK/8okipN9F8BtP84dg9DUhPERbBXzwI6dgTA55d2+yweo3pn5CSFYs45/r8md2+xvUPtTdvTNRfjA==\" data-cf-beacon='{\"version\":\"2024.11.0\",\"token\":\"a57726bb7d694048b17e1f50ea2e7346\",\"r\":1,\"spa\":2}' crossorigin=\"anonymous\"></script>";
    assert.deepEqual(pageContract(html.replace('</body>', beacon + '</body>'), url), pageContract(html, url));
    for (const changed of [beacon.replace('sha512-L0ha', 'sha512-X0ha'), beacon.replace('crossorigin="anonymous"', 'crossorigin="use-credentials"'), beacon.replace('static.cloudflareinsights.com', 'unexpected.example')]) {
        assert.notDeepEqual(pageContract(html.replace('</body>', changed + '</body>'), url), pageContract(html, url));
    }
    assert.throws(() => pageContract(html.replace('</body>', beacon + beacon + '</body>'), url), /duplicated evidenced/);
});
