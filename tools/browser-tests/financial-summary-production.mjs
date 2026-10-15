import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { pageContract, assertResource, assertRequestsComplete, isAnalyticsUrl, ORIGIN } from './recent-optimizations-production.mjs';

export const FINANCIAL_SHA = 'fce99178515dcc08a8d35efcbda31aaaf1b4d44d';
const PAGE = ORIGIN + '/tools/financial_calculator/';
const SUITE = 'tools/browser-tests/financial-copy-summary-regression.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { timeout: 30000, maxBuffer: 4_000_000 });
const expectedBytes = path => git(['show', FINANCIAL_SHA + ':' + path]);

export async function withDeadline(promise, milliseconds, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' deadline')), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
// Drain the complete, dynamically growing body-verification queue. Headers or
// an earlier successful request must never mask a later pending/failed request.
export async function drainVerification(tasks, requests, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let consumed = 0;
    do {
        while (consumed < tasks.length) {
            const batch = tasks.slice(consumed);
            consumed += batch.length;
            await withDeadline(Promise.all(batch), Math.max(1, deadline - Date.now()), 'financial response verification');
        }
        if (![...requests.values()].some(record => record.status === 'pending')) break;
        assert.ok(Date.now() < deadline, 'financial application request remained pending');
        await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
}
function mime(value, kind) {
    assert.match(value || '', kind === 'html' ? /^text\/html\b/i : kind === 'css'
        ? /^text\/css\b/i : /^(text|application)\/(javascript|x-javascript|ecmascript)\b/i);
}
function makeManifest() {
    const path = 'tools/financial_calculator/index.html';
    const html = expectedBytes(path).toString('utf8');
    const manifest = new Map([[PAGE, { path, kind: 'html', contract: pageContract(html, PAGE) }]]);
    for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
        const url = new URL(match[1] || match[2], PAGE);
        if (url.origin !== ORIGIN) continue;
        const resourcePath = url.pathname.slice(1);
        manifest.set(url.href, { path: resourcePath, kind: match[1] ? 'js' : 'css', hash: hash(expectedBytes(resourcePath)) });
    }
    assert.equal(manifest.size, 4, 'expected document, application JS, application CSS and Bootstrap CSS');
    return manifest;
}
function proveSnapshot(manifest) {
    git(['fetch', '--no-tags', 'origin', 'main']);
    const main = git(['rev-parse', 'origin/main']).toString().trim();
    git(['merge-base', '--is-ancestor', FINANCIAL_SHA, main]);
    const paths = [...manifest.values()].map(resource => resource.path).concat(SUITE);
    assert.equal(git(['diff', '--name-only', FINANCIAL_SHA, main, '--', ...paths]).toString().trim(), '',
        'financial production identity or reused suite changed on main');
    assert.equal(git(['diff', '--name-only', FINANCIAL_SHA, 'HEAD', '--', ...paths]).toString().trim(), '',
        'acceptance branch must preserve financial application and the original suite');
    return main;
}
function verifyBody(bytes, resource, url) {
    assert.ok(bytes.length <= 2_000_000, 'oversized financial production response');
    if (resource.kind === 'html') assert.deepEqual(pageContract(bytes.toString('utf8'), url), resource.contract,
        'financial application HTML/script declarations differ from fixed merge');
    else assertResource(bytes, resource);
}

export async function main() {
    const browserName = process.env.PLAYWRIGHT_BROWSER;
    const type = { chromium, firefox, webkit }[browserName];
    assert.ok(type, 'explicit supported browser required');
    assert.equal(process.env.BASE_URL, ORIGIN, 'only ordinary production origin allowed');
    const manifest = makeManifest();
    const required = new Set(manifest.keys());
    const startMain = proveSnapshot(manifest);
    for (const [url, resource] of manifest) {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200, 'ordinary production preflight HTTP');
        assert.equal(response.url, url);
        mime(response.headers.get('content-type'), resource.kind);
        const bytes = Buffer.from(await response.arrayBuffer());
        verifyBody(bytes, resource, url);
        console.log(JSON.stringify({ suite: 'financial-production-preflight', expectedSha: FINANCIAL_SHA,
            url, httpStatus: response.status, bytes: bytes.length, sha256: hash(bytes), status: 'passed' }));
    }
    const contexts = [];
    const failures = [];
    let launchCount = 0;
    const launch = type.launch;
    // The author suite is imported byte-for-byte. It launches the same Playwright
    // BrowserType singleton; hook its one actual browser, then all fresh contexts,
    // including the final Chromium native clipboard context. No suite cases or
    // production implementations are copied or replaced.
    type.launch = async function (...args) {
        launchCount++;
        assert.equal(launchCount, 1, 'exactly one real browser launch expected');
        const browser = await launch.apply(type, args);
        const newContext = browser.newContext.bind(browser);
        const closeBrowser = browser.close.bind(browser);
        browser.newContext = async options => {
            const context = await newContext(options);
            const index = contexts.length + 1;
            const tasks = [];
            const requests = new Map();
            const verified = new Set();
            const responses = [];
            const errors = [];
            const state = { context, index, closed: false, audited: false, requests, verified, responses };
            contexts.push(state);
            const close = context.close.bind(context);
            const drain = () => drainVerification(tasks, requests);
            context.close = async (...closeArgs) => {
                if (state.closed) return;
                try {
                    await drain();
                    assertRequestsComplete([...requests.values()], required, verified);
                    assert.deepEqual(errors, [], 'uncaught financial production page errors');
                    state.audited = true;
                    console.log(JSON.stringify({ suite: 'financial-production-context', browser: browserName, index,
                        nativeResponseBodies: true, resources: responses, status: 'passed' }));
                } catch (error) {
                    failures.push({ context: index, message: error.message.split('\n')[0] });
                    throw error;
                } finally {
                    state.closed = true;
                    await close(...closeArgs);
                }
            };
            await context.route(url => isAnalyticsUrl(url.href), route => route.abort());
            context.on('request', request => {
                if (manifest.has(request.url())) requests.set(request, { url: request.url(), status: 'pending' });
                else if (new URL(request.url()).origin === ORIGIN &&
                    ['document', 'script', 'stylesheet'].includes(request.resourceType()) &&
                    request.url() !== ORIGIN + '/cdn-cgi/scripts/7d0fa10a/cloudflare-static/rocket-loader.min.js') {
                    errors.push('unexpected same-origin application resource: ' + request.url());
                }
            });
            context.on('requestfailed', request => {
                const record = requests.get(request);
                if (record) { record.status = 'failed'; record.reason = request.failure()?.errorText || 'request failed'; }
            });
            context.on('response', response => {
                const resource = manifest.get(response.url());
                if (!resource) return;
                const task = (async () => {
                    const record = requests.get(response.request());
                    assert.ok(record, 'response without recorded application request');
                    assert.equal(response.status(), 200, 'financial browser response HTTP');
                    assert.equal(response.request().redirectedFrom(), null, 'financial resource redirect rejected');
                    mime(response.headers()['content-type'], resource.kind);
                    const bytes = await withDeadline(response.body(), 15000, 'financial browser body ' + resource.path);
                    verifyBody(bytes, resource, response.url());
                    assert.equal(record.status, 'pending', 'failed request cannot become verified');
                    record.status = 'verified';
                    verified.add(response.url());
                    responses.push({ url: response.url(), httpStatus: response.status(), bytes: bytes.length, sha256: hash(bytes) });
                })().catch(error => {
                    const record = requests.get(response.request());
                    if (record) { record.status = 'failed'; record.reason = error.message.split('\n')[0]; }
                    errors.push(resource.path + ': ' + error.message.split('\n')[0]);
                });
                tasks.push(task);
            });
            context.on('page', page => {
                page.on('pageerror', error => errors.push(error.message));
                const goto = page.goto.bind(page);
                page.goto = async (url, options) => {
                    assert.equal(url, PAGE, 'the reused suite must visit the ordinary financial page URL');
                    await drain();
                    const response = await goto(url, { ...options, waitUntil: 'load' });
                    assert.equal(response.status(), 200);
                    assert.equal(page.url(), PAGE);
                    await drain();
                    assertRequestsComplete([...requests.values()], required, verified);
                    // Settle native autofocus without altering app state. A hard
                    // deadline prevents hidden-frame stalls from becoming passes.
                    await withDeadline(page.evaluate(() => new Promise(resolve =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve)))), 5000, 'financial layout settle');
                    return response;
                };
            });
            return context;
        };
        browser.close = async (...args) => {
            try {
                for (const state of contexts) if (!state.closed) await state.context.close();
            } finally { await closeBrowser(...args); }
        };
        return browser;
    };
    try {
        await import('./financial-copy-summary-regression.mjs');
    } finally {
        type.launch = launch;
    }
    assert.equal(launchCount, 1, 'the unchanged suite must launch the instrumented browser');
    assert.deepEqual(failures, [], 'per-context network verification failures');
    assert.equal(contexts.length, browserName === 'chromium' ? 77 : 76, 'all 76 author checks plus Chromium native clipboard must run');
    for (const state of contexts) {
        assert.ok(state.closed && state.audited, 'every author-suite context must be fully verified and closed');
        assertRequestsComplete([...state.requests.values()], required, state.verified);
    }
    const endMain = proveSnapshot(manifest);
    const report = { suite: 'financial-summary-production', browser: browserName, expectedSha: FINANCIAL_SHA,
        startMain, endMain, fixtureOnly: false, unmodifiedAuthorSuite: SUITE, authorChecks: 76,
        verifiedContexts: contexts.length, requiredResourcesPerContext: manifest.size,
        applicationResponseMode: 'native browser response observation; analytics domains aborted',
        clipboard: browserName === 'chromium' ? '76 modeled API cases plus real headless browser API round trip' : '76 modeled API cases; native clipboard permission path unproven',
        limits: 'Synthetic financial inputs only. No user data or external financial requests. Headless CI clipboard is not the user OS clipboard. No application response replacement or cache-bypass URLs.',
        status: 'passed' };
    console.log(JSON.stringify(report));
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        'Financial summary production acceptance\n\n' + JSON.stringify(report, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
