import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
    makeManifest, pageContract, scopeChanged, mainState, verifyBytes, verifyWithRetry,
    SPACE_FILES, PRODUCTION_SCOPE, PRODUCTION_URL
} from './space-production.mjs';

const sha = 'a'.repeat(40);
const next = 'b'.repeat(40);
const html = '<!DOCTYPE html><html><head><style>body { color: black }</style></head><body><main id="main"><textarea id="info"></textarea><textarea id="result" readonly></textarea></main><script data-cfasync="false">new Worker(\'worker.js?v=fixture\');</script></body></html>';
const files = {
    [SPACE_FILES[0]]: Buffer.from(html),
    [SPACE_FILES[1]]: Buffer.from("importScripts('dist/browser/pangu.min.js', 'format.js?v=fixture');"),
    [SPACE_FILES[2]]: Buffer.from('self.spaceTextWithUrls = text => text;'),
    [SPACE_FILES[3]]: Buffer.from('self.pangu = { spaceText: text => text };')
};
const manifest = () => makeManifest(sha, files);
const noLog = () => {};
function fetchFixture({ change = () => null, calls = [] } = {}) {
    return async (input, options) => {
        const url = new URL(input);
        calls.push({ url: url.href, options });
        const path = url.pathname === '/tools/space/' ? SPACE_FILES[0] : url.pathname.slice(1);
        const override = change(url, options, path);
        if (override instanceof Error) throw override;
        const body = override?.body ?? files[path];
        const response = new Response(body, {
            status: override?.status ?? 200,
            headers: { 'content-type': override?.mime ?? (path === SPACE_FILES[0] ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8') }
        });
        Object.defineProperty(response, 'url', { value: override?.url ?? url.href });
        return response;
    };
}
function clockOptions(extra = {}) {
    let clock = 0;
    return { now: () => clock, sleep: async delay => { clock += delay; }, maxWaitMs: 30, intervalMs: 10, log: noLog, ...extra };
}

test('manifest binds one exact commit and all four real runtime files/URLs', () => {
    const value = manifest();
    assert.equal(value.sha, sha);
    assert.equal(value.resources.length, 3);
    assert.equal(value.page.worker, 'worker.js?v=fixture');
    assert.equal(value.resources.find(row => row.path === SPACE_FILES[2]).url, PRODUCTION_URL + 'format.js?v=fixture');
    assert.equal(value.resources.find(row => row.path === SPACE_FILES[3]).url, PRODUCTION_URL + 'dist/browser/pangu.min.js');
    assert.throws(() => makeManifest('main', files), /exact commit/);
    assert.throws(() => makeManifest(sha, { ...files, [SPACE_FILES[2]]: null }), /missing expected file/);
    assert.throws(() => makeManifest(sha, { ...files, [SPACE_FILES[1]]: Buffer.from("importScripts('https://evil.example/pangu.js', 'format.js');") }));
    assert.throws(() => makeManifest(sha, { ...files, [SPACE_FILES[0]]: Buffer.from(html.replace('worker.js?v=fixture', 'https://evil.example/worker.js')) }), /same-origin/);
});

test('page contract permits only outside CDN additions, never altered/duplicated application islands', () => {
    assert.deepEqual(pageContract(html.replace('</body>', '<script src="/cdn-cgi/analytics.js"></script></body>')), pageContract(html));
    for (const altered of [
        html.replace('color: black', 'color: red'),
        html.replace('id="info"', 'id="wrong"'),
        html.replace('v=fixture', 'v=old'),
        html.replace('</body>', '<main></main></body>'),
        html.replace('</body>', '<script data-cfasync="false">new Worker(\'worker.js\')</script></body>'),
        '<html><title>Just a moment...</title></html>'
    ]) assert.throws(() => assert.deepEqual(pageContract(altered), pageContract(html)));
});

test('production scope includes runtime/checker/workflow only; README and unrelated tools do not match', () => {
    assert.ok(PRODUCTION_SCOPE.includes('.github/workflows/validate-static-tools.yml'));
    assert.ok(!PRODUCTION_SCOPE.includes('tools/space/README.md'));
    assert.ok(!PRODUCTION_SCOPE.some(path => path.includes('renovation')));
    let args;
    assert.equal(scopeChanged(sha, next, value => { args = value; return Buffer.from(''); }), false);
    assert.deepEqual(args, ['diff', '--name-only', sha, next, '--', ...PRODUCTION_SCOPE]);
    assert.equal(scopeChanged(sha, next, () => Buffer.from(SPACE_FILES[2])), true);
    assert.equal(scopeChanged('0'.repeat(40), next, () => { throw Error('should not run'); }), true);
    assert.throws(() => scopeChanged('main', next), /exact commit/);
    assert.throws(() => scopeChanged(sha, next, () => { throw Error('git unavailable'); }), /git unavailable/);
});

test('main supersession requires verified ancestry and changes to the actual four-file chain', () => {
    const calls = [];
    const fakeGit = changed => args => {
        calls.push(args);
        if (args[0] === 'rev-parse') return Buffer.from(next + '\n');
        if (args[0] === 'diff') return Buffer.from(changed);
        return Buffer.from('');
    };
    assert.deepEqual(mainState(sha, fakeGit('')), { sha: next, superseded: false });
    assert.deepEqual(mainState(sha, fakeGit(SPACE_FILES[1])), { sha: next, superseded: true });
    assert.ok(calls.some(args => args.join(' ') === ['merge-base', '--is-ancestor', sha, next].join(' ')));
    assert.deepEqual(calls.find(args => args[0] === 'diff'), ['diff', '--name-only', sha, next, '--', ...SPACE_FILES]);
    assert.throws(() => mainState(sha, args => {
        if (args[0] === 'rev-parse') return Buffer.from(next);
        throw Error('unrelated or unavailable main');
    }), /unrelated/);
});

test('ordinary URL byte acceptance uses the exact worker/import queries without cache bypass', async () => {
    const calls = [];
    await verifyBytes(manifest(), { fetchImpl: fetchFixture({ calls }) });
    assert.equal(calls.length, 4);
    assert.ok(calls.every(({ url, options }) => !new URL(url).searchParams.has('verify') && !options.cache && options.redirect === 'error'));
    assert.ok(calls.some(({ url }) => url.endsWith('/worker.js?v=fixture')));
    assert.ok(calls.some(({ url }) => url.endsWith('/format.js?v=fixture')));
    assert.ok(calls.some(({ url }) => url.endsWith('/pangu.min.js')));
});

test('every mixed or missing resource, challenge, MIME, redirect, invalid UTF-8 and oversized response fails', async () => {
    for (const brokenPath of SPACE_FILES) {
        await assert.rejects(verifyBytes(manifest(), {
            fetchImpl: fetchFixture({ change: (_url, _options, path) => path === brokenPath ? { body: Buffer.from('old cached bytes') } : null })
        }));
    }
    for (const change of [
        () => ({ body: 'challenge', status: 403 }),
        () => ({ body: '<html>challenge</html>', mime: 'text/html' }),
        () => ({ status: 404 }),
        () => ({ url: 'https://evil.example/' }),
        () => ({ body: new Uint8Array([0xff]) }),
        () => ({ body: 'x'.repeat(512001) }),
        () => new Error('transient external failure')
    ]) await assert.rejects(verifyBytes(manifest(), { fetchImpl: fetchFixture({ change }) }));
});

test('a successful diagnostic URL can never rescue stale ordinary cache', async () => {
    let uiCalls = 0;
    let diagnosticMatches = 0;
    const result = verifyWithRetry(manifest(), clockOptions({
        bytes: async (_manifest, options) => {
            if (options.diagnostic) { diagnosticMatches += 1; return; }
            throw Error('canonical worker is stale');
        },
        ui: async () => { uiCalls += 1; }
    }));
    await assert.rejects(result, /SPACE_PRODUCTION_NOT_VERIFIED.*canonical worker is stale/);
    assert.ok(diagnosticMatches > 0);
    assert.equal(uiCalls, 0);
});

test('transient ordinary failures retry, then require real UI and a final current-main proof', async () => {
    let ordinaryCalls = 0;
    let uiCalls = 0;
    let mainProofs = 0;
    const result = await verifyWithRetry(manifest(), clockOptions({
        bytes: async (_manifest, { diagnostic }) => {
            if (!diagnostic && ++ordinaryCalls < 2) throw Error('temporary 503');
        },
        ui: async () => { uiCalls += 1; },
        getMainState: async () => { mainProofs += 1; return { sha: next, superseded: false }; }
    }));
    assert.equal(result.status, 'deployed');
    assert.equal(result.expectedSha, sha);
    assert.equal(uiCalls, 1);
    assert.ok(mainProofs >= 3);
});

test('a passing byte probe without real UI success never proves deployment', async () => {
    await assert.rejects(verifyWithRetry(manifest(), clockOptions({
        bytes: async () => {}, ui: async () => { throw Error('worker failed to load'); }
    })), /worker failed to load/);
});

test('supersession before, during failed bytes, or after passing UI never claims old deployment', async () => {
    for (const phase of ['before', 'failure', 'after']) {
        let proofs = 0;
        let uiCalls = 0;
        const result = await verifyWithRetry(manifest(), clockOptions({
            getMainState: async () => ({ sha: next, superseded: ++proofs >= (phase === 'before' ? 1 : 2) }),
            bytes: async (_manifest, { diagnostic }) => {
                if (phase === 'failure' && !diagnostic) throw Error('new runtime already deployed');
            },
            ui: async () => { uiCalls += 1; }
        }));
        assert.equal(result.status, 'superseded');
        assert.equal(result.acceptance, 'not-claimed');
        assert.equal(result.currentSha, next);
        assert.equal(uiCalls, phase === 'after' ? 1 : 0);
    }
});

test('unavailable main proof retries but cannot become acceptance', async () => {
    let uiCalls = 0;
    await assert.rejects(verifyWithRetry(manifest(), clockOptions({
        getMainState: async () => { throw Error('main read unavailable'); },
        bytes: async () => {}, ui: async () => { uiCalls += 1; }
    })), /main read unavailable/);
    assert.equal(uiCalls, 0);
});

test('request deadlines abort a stalled dependency and bounded retries eventually fail', async () => {
    let clock = 0;
    let aborts = 0;
    await assert.rejects(verifyWithRetry(manifest(), {
        now: () => clock, sleep: async delay => { clock += delay; }, maxWaitMs: 3, intervalMs: 2, requestTimeoutMs: 1,
        bytes: async (_manifest, { signal }) => {
            await new Promise((resolve, reject) => {
                signal.addEventListener('abort', () => { aborts += 1; clock += 1; reject(Error('request timeout')); }, { once: true });
            });
        },
        ui: async () => { throw Error('must not run'); }, log: noLog
    }), /request timeout/);
    assert.ok(aborts >= 2);
});

test('workflow keeps push behind all browser success and preserves scheduled update ownership', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/validate-static-tools.yml', import.meta.url), 'utf8');
    const job = workflow.slice(workflow.indexOf('  production-contract:'));
    assert.match(job, /needs\.browser\.result == 'success'/);
    assert.match(job, /github\.event_name == 'schedule'/);
    assert.match(job, /- update-pinyin-pro/);
    assert.match(job, /- update-static-vendor/);
    assert.match(job, /--scope "\$BEFORE_SHA" "\$EXPECTED_SHA"/);
    assert.match(job, /--expected-sha "\$\(git rev-parse HEAD\)"/);
    assert.match(job, /contents: read/);
    assert.doesNotMatch(job, /pages:|contents: write|secrets\./);
    assert.match(workflow, /space-production\.mjs --fixture/);
});
