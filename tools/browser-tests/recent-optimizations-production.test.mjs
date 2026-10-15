import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { pageContract, assertResource, ORIGIN } from './recent-optimizations-production.mjs';

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
test('CDN analytics outside the exact application islands do not replace app acceptance', () => {
    assert.deepEqual(pageContract(html.replace('</body>', '<script src="https://analytics.example/cdn.js"></script></body>'), url), pageContract(html, url));
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
