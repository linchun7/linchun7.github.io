import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../space/format.js', import.meta.url), 'utf8');
// Only our own URL guard is evaluated here. Third-party Pangu is exercised
// exclusively by the real UI/worker tests in Chromium, Firefox and WebKit.
function guard() {
    const scope = {};
    vm.runInNewContext(source, scope, { timeout: 1000 });
    return scope.spaceTextWithUrls;
}

test('delegates all ordinary text to the supplied upstream formatter exactly once', () => {
    const input = '中文:ABC 王·小明';
    const calls = [];
    const result = guard()(input, text => { calls.push(text); return 'UPSTREAM RESULT'; });
    assert.deepEqual(calls, [input]);
    assert.equal(result, 'UPSTREAM RESULT');
    assert.doesNotMatch(source, /hanAsciiBoundary|fenceLine|spaceBoundaries|spaceOutsideInlineCode/);
});

test('protects URL bytes, avoids user marker collisions and rejects lost/duplicated markers', () => {
    const format = guard();
    const input = 'PANGUURLTOKEN0X0END PANGUURLTOKEN1X0END HTTPS://example.com/Ａ中文ABC <https://[::1]/中[文]{尾}>';
    assert.equal(format(input, text => text), input);
    assert.throws(() => format(input, () => 'lost markers'), /URL 保护校验失败/);
    assert.throws(() => format('https://example.com/中文ABC', text => text + text), /URL 保护校验失败/);
    assert.throws(() => format('https://example.com/甲ABC https://example.org/乙DEF', text => text.split(' ').reverse().join(' ')), /URL 保护校验失败/);
    assert.throws(() => format('中文ABC', () => null), /返回异常/);
    assert.throws(() => format('中文ABC', null), /组件加载失败/);
});

test('UI worker uses the official spaceText API with bounded, cancellable work', async () => {
    const worker = await readFile(new URL('../space/worker.js', import.meta.url), 'utf8');
    const html = await readFile(new URL('../space/index.html', import.meta.url), 'utf8');
    assert.match(worker, /importScripts\('dist\/browser\/pangu\.min\.js', 'format\.js\?/);
    assert.match(worker, /self\.pangu\.spaceText\.bind\(self\.pangu\)/);
    assert.doesNotMatch(worker, /spacingText|pangu\.spacing\b/);
    assert.match(html, /new Worker\('worker\.js\?/);
    assert.match(html, /worker\?\.terminate\(\)/);
    assert.match(html, /id !== revision/);
    assert.match(html, /}, 4000\)/);
    assert.match(html, /textarea\.value\.length > 200000/);
    assert.match(html, /<textarea id="result"[^>]*readonly/);
    assert.doesNotMatch(html, /spaceTextPreservingContent|spacing\.js|只补充|仅补齐/);
});

test('automatic upgrade candidates use the full actual UI contract without script injection', async () => {
    const smoke = await readFile(new URL('./static-vendor-smoke.mjs', import.meta.url), 'utf8');
    const workflow = await readFile(new URL('../../.github/workflows/validate-static-tools.yml', import.meta.url), 'utf8');
    assert.match(smoke, /await testSpaceContract\(browser, baseUrl\)/);
    assert.match(smoke, /await testSpaceFailures\(browser, baseUrl\)/);
    assert.doesNotMatch(smoke, /addScriptTag|window\.pangu\.spacing/);
    assert.match(workflow, /PLAYWRIGHT_BROWSER="\$browser" node tools\/browser-tests\/static-vendor-smoke\.mjs/);
    assert.match(workflow, /if \[\[ "\$changed_files" != "\$TARGET" \]\]/);
    assert.match(workflow, /if \[\[ "\$\(git rev-parse origin\/main\)" != "\$BASE_SHA" \]\]/);
});
