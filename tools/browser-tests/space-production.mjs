import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PRODUCTION_URL = 'https://www.linchun.com.cn/tools/space/';
export const SPACE_FILES = [
    'tools/space/index.html', 'tools/space/worker.js',
    'tools/space/format.js', 'tools/space/dist/browser/pangu.min.js'
];
export const PRODUCTION_SCOPE = [
    ...SPACE_FILES, '.github/workflows/validate-static-tools.yml',
    'tools/browser-tests/space-production.mjs', 'tools/browser-tests/space-production.test.mjs',
    'tools/browser-tests/package.json'
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const exactSha = value => assert.match(value, /^[a-f0-9]{40}$/, 'an exact commit SHA is required');
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const git = args => execFileSync('git', args, { timeout: 20000, maxBuffer: 2_000_000 });

export function pageContract(html) {
    const one = (pattern, label) => {
        const matches = [...html.matchAll(pattern)];
        assert.equal(matches.length, 1, 'missing or duplicated space ' + label);
        return matches[0][0];
    };
    // Compare our exact application islands, not CDN-added analytics outside them.
    // No whitespace normalization or arbitrary script/DOM stripping is allowed.
    const main = one(/<main\b[^>]*>[\s\S]*?<\/main\s*>/gi, 'main');
    const style = one(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, 'style');
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
        .filter(match => /\bdata-cfasync="false"/.test(match[1]) && !/\bsrc=/.test(match[1]));
    assert.equal(scripts.length, 1, 'missing or duplicated space application script');
    const workers = [...scripts[0][2].matchAll(/new Worker\('([^']+)'\)/g)];
    assert.equal(workers.length, 1, 'missing or duplicated space worker reference');
    return { main: sha256(main), style: sha256(style), application: sha256(scripts[0][0]), worker: workers[0][1] };
}

export function makeManifest(sha, files) {
    exactSha(sha);
    for (const path of SPACE_FILES) assert.ok(files[path]?.length, 'missing expected file: ' + path);
    const html = utf8(files[SPACE_FILES[0]]);
    const page = pageContract(html);
    const base = new URL(PRODUCTION_URL);
    const workerUrl = new URL(page.worker, base);
    assert.equal(workerUrl.origin, base.origin, 'worker must remain same-origin');
    assert.equal(workerUrl.pathname, '/tools/space/worker.js');
    const worker = utf8(files[SPACE_FILES[1]]);
    const imports = [...worker.matchAll(/\bimportScripts\(([^)]*)\)/g)];
    assert.equal(imports.length, 1, 'exactly one worker importScripts call is required');
    const argumentsText = imports[0][1];
    assert.match(argumentsText, /^'[^']+'(?:,\s*'[^']+')*$/, 'literal worker dependencies are required');
    const dependencies = [...argumentsText.matchAll(/'([^']+)'/g)].map(match => new URL(match[1], workerUrl));
    assert.equal(dependencies.length, 2, 'the two actual space dependencies are required');
    const expectedPaths = ['/tools/space/dist/browser/pangu.min.js', '/tools/space/format.js'];
    assert.deepEqual(dependencies.map(url => url.pathname).sort(), [...expectedPaths].sort());
    for (const url of dependencies) assert.equal(url.origin, base.origin, 'dependency must remain same-origin');
    const resources = [workerUrl, ...dependencies].map(url => {
        const path = url.pathname.slice(1);
        return { path, url: url.href, hash: sha256(files[path]) };
    });
    return { sha, page, indexHash: sha256(files[SPACE_FILES[0]]), resources };
}

export function loadManifest(sha, runGit = git) {
    exactSha(sha);
    return makeManifest(sha, Object.fromEntries(SPACE_FILES.map(path => [path, runGit(['show', sha + ':' + path])])));
}

export function scopeChanged(base, head, runGit = git) {
    exactSha(head);
    if (base === '0'.repeat(40)) return true;
    exactSha(base);
    return runGit(['diff', '--name-only', base, head, '--', ...PRODUCTION_SCOPE]).toString().trim() !== '';
}

export function mainState(expected, runGit = git) {
    exactSha(expected);
    runGit(['fetch', 'origin', 'main']);
    const current = runGit(['rev-parse', 'origin/main']).toString().trim();
    exactSha(current);
    if (current === expected) return { sha: current, superseded: false };
    // An unrelated/rewritten main is not proof of a legitimate successor.
    runGit(['merge-base', '--is-ancestor', expected, current]);
    const changed = runGit(['diff', '--name-only', expected, current, '--', ...SPACE_FILES]).toString().trim();
    return { sha: current, superseded: changed !== '' };
}

function resourceUrl(url, diagnostic, sha, attempt) {
    const value = new URL(url);
    if (diagnostic) value.searchParams.set('verify', sha + '-' + attempt);
    return value;
}

async function fetchBytes(url, { fetchImpl, signal, html = false, diagnostic = false }) {
    const response = await fetchImpl(url, {
        signal, redirect: 'error',
        ...(diagnostic ? { cache: 'no-store', headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } } : {})
    });
    assert.ok(response.ok, 'HTTP_' + response.status + ':' + url.pathname);
    if (response.url) assert.equal(response.url, url.href, 'unexpected production URL or redirect');
    const mime = response.headers.get('content-type') || '';
    assert.match(mime, html ? /^text\/html\b/i : /^(?:text|application)\/(?:javascript|x-javascript|ecmascript)\b/i, 'unexpected MIME: ' + url.pathname);
    const reader = response.body?.getReader();
    assert.ok(reader, 'missing response body');
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            assert.ok(size <= 512_000, 'response exceeds space verification limit');
            chunks.push(Buffer.from(value));
        }
    } finally { await reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
}

export async function verifyBytes(manifest, {
    fetchImpl = globalThis.fetch, signal, diagnostic = false, attempt = 1, baseUrl = PRODUCTION_URL
} = {}) {
    const base = new URL(baseUrl);
    const projectUrl = url => {
        const original = new URL(url);
        return new URL(original.pathname + original.search, base.origin);
    };
    const indexUrl = new URL(baseUrl);
    const html = await fetchBytes(resourceUrl(indexUrl, diagnostic, manifest.sha, attempt), { fetchImpl, signal, html: true, diagnostic });
    assert.deepEqual(pageContract(utf8(html)), manifest.page, 'production page application differs from the expected commit');
    await Promise.all(manifest.resources.map(async resource => {
        const url = resourceUrl(projectUrl(resource.url), diagnostic, manifest.sha, attempt);
        const bytes = await fetchBytes(url, { fetchImpl, signal, diagnostic });
        assert.equal(sha256(bytes), resource.hash, 'production bytes differ: ' + resource.path);
    }));
}

export async function verifyUi(manifest, { baseUrl = PRODUCTION_URL, timeoutMs = 25000 } = {}) {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true, timeout: Math.min(timeoutMs, 10000) });
    const deadline = setTimeout(() => { void browser.close().catch(() => {}); }, timeoutMs);
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(Math.min(timeoutMs, 7000));
    const errors = [];
    const observed = new Map();
    const responses = [];
    const expected = new Map(manifest.resources.map(resource => {
        const url = new URL(resource.url);
        return [new URL(url.pathname + url.search, new URL(baseUrl).origin).href, resource];
    }));
    context.on('response', response => {
        const resource = expected.get(response.url());
        if (!resource) return;
        responses.push((async () => {
            assert.ok(response.ok(), 'browser dependency HTTP failure: ' + resource.path);
            assert.match(response.headers()['content-type'] || '', /^(?:text|application)\/(?:javascript|x-javascript|ecmascript)\b/i);
            assert.equal(sha256(await response.body()), resource.hash, 'browser loaded unexpected bytes: ' + resource.path);
            observed.set(response.url(), true);
        })());
        // The assertion is awaited below; prevent an early unhandled rejection.
        responses.at(-1).catch(() => {});
    });
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/googletagmanager.com/**', route => route.abort());
    try {
        const navigation = await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(timeoutMs, 12000) });
        assert.ok(navigation?.ok(), 'production navigation failed');
        assert.equal(page.url(), baseUrl, 'unexpected page redirect');
        assert.deepEqual(pageContract(await navigation.text()), manifest.page, 'browser page differs from expected application');
        assert.equal(await page.locator('#result').getAttribute('readonly'), '');
        const cases = [
            ['中文ABC', '中文 ABC'],
            ['中文:ABC 王·小明', '中文: ABC 王・小明'],
            ['访问https://example.com/中文ABC，后文DEF', '访问 https://example.com/中文ABC，后文 DEF'],
            ['中文ABC', '中文 ABC']
        ];
        for (const [input, result] of cases) {
            await page.fill('#info', input);
            await page.click('#addBtn');
            await page.waitForFunction(() => document.getElementById('alertText').textContent === '已处理');
            assert.equal(await page.inputValue('#info'), input, 'source changed');
            assert.equal(await page.inputValue('#result'), result, 'unexpected real worker formatting');
        }
        await page.click('#clearBtn');
        assert.equal(await page.inputValue('#info'), '');
        assert.equal(await page.inputValue('#result'), '');
        await Promise.all(responses);
        for (const url of expected.keys()) assert.ok(observed.get(url), 'real browser did not load dependency: ' + url);
        assert.deepEqual(errors, [], 'production page errors');
    } finally {
        clearTimeout(deadline);
        await browser.close();
    }
}

export async function verifyWithRetry(manifest, {
    getMainState = async () => ({ sha: manifest.sha, superseded: false }),
    bytes = verifyBytes, ui = verifyUi, fetchImpl = globalThis.fetch, baseUrl = PRODUCTION_URL,
    maxWaitMs = 300000, intervalMs = 10000, requestTimeoutMs = 12000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, log = console.log
} = {}) {
    const started = now();
    let attempts = 0;
    let lastReason = 'not-started';
    const superseded = async () => {
        const state = await getMainState();
        exactSha(state.sha);
        return state.superseded ? { status: 'superseded', expectedSha: manifest.sha, currentSha: state.sha, attempts, acceptance: 'not-claimed' } : null;
    };
    while (now() - started < maxWaitMs) {
        attempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, maxWaitMs - (now() - started)));
        try {
            const stale = await superseded();
            if (stale) return stale;
            // Only ordinary application URLs prove acceptance. Diagnostic URLs
            // are queried after a failure and can never turn that failure green.
            await bytes(manifest, { fetchImpl, signal: controller.signal, baseUrl, attempt: attempts });
            clearTimeout(timer);
            const remaining = maxWaitMs - (now() - started);
            assert.ok(remaining > 0, 'verification deadline');
            await ui(manifest, { baseUrl, timeoutMs: Math.min(25000, remaining) });
            const advanced = await superseded();
            if (advanced) return advanced;
            return { status: 'deployed', expectedSha: manifest.sha, attempts, index: 'exact main/style/application contract', resources: manifest.resources.map(({ path, hash }) => ({ path, hash })) };
        } catch (error) {
            lastReason = String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 220);
            log('Space production attempt ' + attempts + ': ' + lastReason);
        } finally { clearTimeout(timer); controller.abort(); }
        try {
            const advanced = await superseded();
            if (advanced) return advanced;
        } catch (error) {
            lastReason = 'main proof unavailable: ' + String(error?.message || error).slice(0, 180);
        }
        // Bounded diagnostics help identify CDN lag without proving deployment.
        const diagnostic = new AbortController();
        const diagnosticTimer = setTimeout(() => diagnostic.abort(), Math.min(requestTimeoutMs, Math.max(1, maxWaitMs - (now() - started))));
        try {
            await bytes(manifest, { fetchImpl, signal: diagnostic.signal, baseUrl, diagnostic: true, attempt: attempts });
            log('Diagnostic bytes match; ordinary URL/UI acceptance is still required.');
        } catch { /* The ordinary acceptance failure remains authoritative. */ }
        finally { clearTimeout(diagnosticTimer); diagnostic.abort(); }
        const remaining = maxWaitMs - (now() - started);
        if (remaining <= 0) break;
        await sleep(Math.min(intervalMs, remaining));
    }
    const advanced = await superseded();
    if (advanced) return advanced;
    throw new Error('SPACE_PRODUCTION_NOT_VERIFIED expected=' + manifest.sha + ' attempts=' + attempts + ' reason=' + lastReason);
}

async function main() {
    if (process.argv[2] === '--scope') {
        const changed = scopeChanged(process.argv[3], process.argv[4]);
        assert.ok(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required');
        await appendFile(process.env.GITHUB_OUTPUT, 'run_space=' + changed + '\n');
        return;
    }
    const fixture = process.argv[2] === '--fixture';
    const sha = fixture ? git(['rev-parse', 'HEAD']).toString().trim() : process.argv[3];
    if (!fixture) assert.equal(process.argv[2], '--expected-sha');
    const manifest = loadManifest(sha);
    const result = await verifyWithRetry(manifest, fixture ? {
        baseUrl: 'http://127.0.0.1:4173/tools/space/', maxWaitMs: 60000
    } : { getMainState: async () => mainState(sha) });
    console.log(JSON.stringify({ ...result, fixtureOnly: fixture }));
    if (process.env.GITHUB_STEP_SUMMARY && !fixture) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, [
            '## Space production contract', '',
            '- Status: ' + result.status + (result.status === 'superseded' ? ' (no deployment acceptance claimed; successor run owns verification)' : ''),
            '- Expected commit: ' + sha,
            '- Expected index.html SHA-256: ' + manifest.indexHash,
            ...(result.currentSha ? ['- Successor commit: ' + result.currentSha] : []),
            ...manifest.resources.map(row => '- ' + row.path + ': ' + row.hash),
            '- Ordinary page → worker → Pangu/format URLs and exact application islands are required.',
            ''
        ].join('\n'));
    }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
