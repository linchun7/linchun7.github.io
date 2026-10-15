import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { checkCardInputRecovery } from './card-input-recovery.mjs';
import { checkRmbInputLifecycle } from './rmb-input-lifecycle.mjs';
import { CORPUS } from '../translation_benchmark/scripts/corpus.mjs';

export const EXPECTED_SHA = '03ffbc3edf24c97e2d2ec7253d1503d97e0c6372';
export const ORIGIN = 'https://www.linchun.com.cn';
const languages = ['en', 'ja', 'ko', 'fr', 'de', 'es'];
const pages = [
    'tools/hospital_rank/index.html', 'tools/card_number/index.html',
    'tools/card_number_new/index.html', 'tools/renovation_calculator/index.html',
    'tools/rmb_converter/index.html',
    ...languages.map(language => 'tools/translation_benchmark/' + language + '.html')
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = args => execFileSync('git', args, { timeout: 30000, maxBuffer: 4_000_000 });
const expectedBytes = path => git(['show', EXPECTED_SHA + ':' + path]);
const pageUrl = path => ORIGIN + '/' + path.replace(/index\.html$/, '');
const one = (html, pattern, label) => {
    const matches = [...html.matchAll(pattern)];
    assert.equal(matches.length, 1, 'missing or duplicated application ' + label);
    return matches[0][0];
};

// Exact application bytes only. No whitespace normalization, arbitrary script
// stripping, cache-bypass URLs, alternative hosts, or replacement app responses.
export function pageContract(html, url) {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
    // Raw production evidence in run 38679092957 binds this one observed CDN
    // loader and its matching 24-hex type nonce. No other attributes, scripts,
    // paths, source bytes or ordering are normalized.
    const loaderPattern = /^ src="\/cdn-cgi\/scripts\/7d0fa10a\/cloudflare-static\/rocket-loader\.min\.js" data-cf-settings="([a-f0-9]{24})-\|49" defer$/;
    const loaders = scripts.filter(match => loaderPattern.test(match[1]));
    assert.ok(loaders.length <= 1, 'duplicated observed Cloudflare loader');
    const nonce = loaders.length ? loaderPattern.exec(loaders[0][1])[1] : null;
    // Browser-only Cloudflare Web Analytics node was captured verbatim in run
    // 38679541328. Match the complete tag, including URL, SRI, beacon attributes
    // and empty body; never ignore an arbitrary cross-origin script.
    const beacons = scripts.filter(match => hash(match[0]) === 'e10b4c517370bb73f72eeb202c228dd3ec8bc9f86306d832a6485e48b2f24d71');
    assert.ok(beacons.length <= 1, 'duplicated evidenced Cloudflare analytics node');
    if (loaders.length) assert.equal(loaders[0][2], '', 'Cloudflare loader must not contain inline code');
    const appScripts = scripts.filter(match => match !== loaders[0] && match !== beacons[0]).map(match => {
        if (!nonce) return match[0];
        const marker = ' type="' + nonce + '-text/javascript"';
        if (!match[1].includes(marker)) return match[0];
        assert.ok(!/\bdata-cfasync="false"/.test(match[1]), 'opt-out application script must not be rewritten');
        return match[0].replace(marker, '');
    });
    const stylesheets = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)].map(match => match[0]);
    const dialogs = [...html.matchAll(/<dialog\b[\s\S]*?<\/dialog\s*>/gi)].map(match => match[0]);
    const styles = [...html.matchAll(/<style\b[\s\S]*?<\/style\s*>/gi)].map(match => match[0]);
    return {
        root: hash(one(html, /<html\b[^>]*>/gi, 'root')),
        main: hash(one(html, /<main\b[\s\S]*?<\/main\s*>/gi, 'main')),
        dialogs: dialogs.map(hash), styles: styles.map(hash),
        stylesheets: stylesheets.map(hash), appScripts: appScripts.map(hash)
    };
}
export function assertResource(bytes, resource) {
    assert.equal(hash(bytes), resource.hash, 'production bytes differ: ' + resource.path);
}
export function isAnalyticsUrl(value) {
    const hostname = new URL(value).hostname;
    return ['googletagmanager.com', 'google-analytics.com', 'static.cloudflareinsights.com'].some(domain =>
        hostname === domain || hostname.endsWith('.' + domain));
}
export function assertRequestsComplete(records, required, verified) {
    assert.deepEqual(records.filter(record => record.status !== 'verified'), [], 'each requested application resource must finish verification');
    assert.deepEqual([...required].filter(url => !verified.has(url)), [], 'this context did not verify every required static application resource');
}
export function assertScheduleParity(actual, expected) {
    const withoutRates = result => ({
        ...result, apr: undefined,
        schedule: result.schedule.map(row => ({ ...row, earlyRepaymentAPR: undefined }))
    });
    assert.deepEqual(withoutRates(actual), withoutRates(expected), 'every monetary, period and non-APR field must match exactly');
    let maximumRateDifference = 0;
    const rate = (value, reference, label) => {
        assert.ok(Number.isFinite(value) && Number.isFinite(reference), label + ' must be finite');
        const difference = Math.abs(value - reference);
        maximumRateDifference = Math.max(maximumRateDifference, difference);
        // annualizeMonthlyIRR is (Math.pow(1 + monthlyRate, 12) - 1) * 100.
        // Bound engine ulps at the pre-subtraction scale, including that factor
        // of 100; scaling by the small final APR alone understates cancellation.
        const tolerance = 64 * Number.EPSILON * Math.max(100, Math.abs(value), Math.abs(reference));
        assert.ok(difference <= tolerance, label + ' exceeds the cross-engine annualization precision boundary: ' + JSON.stringify({ value, reference, difference, tolerance }));
        assert.equal(value.toFixed(2), reference.toFixed(2), label + ' must retain the exact displayed percentage');
    };
    rate(actual.apr, expected.apr, 'full APR');
    actual.schedule.forEach((row, index) => rate(row.earlyRepaymentAPR, expected.schedule[index].earlyRepaymentAPR, 'early APR ' + row.month));
    return maximumRateDifference;
}
function makeManifest() {
    const manifest = new Map();
    const filePaths = new Set(pages);
    const addResource = (url, kind) => {
        const parsed = new URL(url);
        assert.equal(parsed.origin, ORIGIN);
        const path = parsed.pathname.slice(1);
        filePaths.add(path);
        manifest.set(url, { path, kind, hash: hash(expectedBytes(path)) });
    };
    for (const path of pages) {
        const url = pageUrl(path);
        const html = expectedBytes(path).toString('utf8');
        manifest.set(url, { path, kind: 'html', contract: pageContract(html, url), required: [] });
        for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>|<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/gi)) {
            const value = match[1] || match[2];
            const resource = new URL(value, url);
            if (resource.origin === ORIGIN) {
                addResource(resource.href, match[1] ? 'js' : 'css');
                manifest.get(url).required.push(resource.href);
            }
        }
        if (path.includes('/hospital_rank/')) {
            const version = /data-rankings-version="([^"]+)"/.exec(html)?.[1];
            assert.ok(version, 'hospital data version must be declared');
            addResource(new URL('data/rankings.json?v=' + encodeURIComponent(version), url).href, 'json');
        }
        if (path.includes('/card_number_new/')) {
            const app = expectedBytes('tools/card_number_new/app.js').toString('utf8');
            const version = /const ASSET_VERSION = '([^']+)'/.exec(app)?.[1];
            assert.ok(version, 'card worker version must be declared');
            addResource(new URL('worker.js?v=' + version, url).href, 'js');
            const worker = expectedBytes('tools/card_number_new/worker.js').toString('utf8');
            const dependency = /importScripts\('([^']+)'\)/.exec(worker)?.[1];
            assert.ok(dependency, 'card worker dependency must be declared');
            addResource(new URL(dependency, url).href, 'js');
        }
    }
    return { manifest, filePaths: [...filePaths] };
}
function proveSnapshot(filePaths) {
    git(['fetch', '--no-tags', 'origin', 'main']);
    const main = git(['rev-parse', 'origin/main']).toString().trim();
    assert.match(main, /^[a-f0-9]{40}$/);
    git(['merge-base', '--is-ancestor', EXPECTED_SHA, main]);
    assert.equal(git(['diff', '--name-only', EXPECTED_SHA, main, '--', ...filePaths]).toString().trim(), '',
        'production snapshot superseded: relevant main files changed; no acceptance is claimed');
    assert.equal(git(['diff', '--name-only', EXPECTED_SHA, 'HEAD', '--', ...filePaths]).toString().trim(), '',
        'acceptance branch must not change production files');
    return main;
}
async function withDeadline(promise, milliseconds, label) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(label + ' deadline')), milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}
function validateMime(mime, resource) {
    const pattern = {
        html: /^text\/html\b/i, css: /^text\/css\b/i, json: /^(application|text)\/json\b/i,
        js: /^(text|application)\/(javascript|x-javascript|ecmascript)\b/i
    }[resource.kind];
    assert.match(mime || '', pattern, 'unexpected production MIME: ' + resource.path);
}
function scriptInventory(html) {
    return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map(match => ({
        attributes: match[1], src: /\bsrc="([^"]+)"/.exec(match[1])?.[1] || null,
        bodyBytes: Buffer.byteLength(match[2]), bodyHash: hash(match[2]),
        bodyPreview: match[2].length <= 2500 ? match[2] : undefined
    }));
}
async function preflight(manifest) {
    const failures = [];
    for (const [url, resource] of manifest) {
      try {
        const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000) });
        assert.ok(response.ok, 'ordinary URL HTTP ' + response.status + ': ' + url);
        assert.equal(response.url, url);
        validateMime(response.headers.get('content-type'), resource);
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.ok(bytes.length <= 2_000_000, 'oversized production response');
        if (resource.kind === 'html') {
            const actualHtml = bytes.toString('utf8');
            try { assert.deepEqual(pageContract(actualHtml, url), resource.contract, 'production page differs: ' + resource.path); }
            catch (error) {
                console.log(JSON.stringify({ suite: 'production-page-diagnostic', url,
                    expectedScripts: scriptInventory(expectedBytes(resource.path).toString('utf8')),
                    actualScripts: scriptInventory(actualHtml), status: 'mismatch' }));
                throw error;
            }
        } else assertResource(bytes, resource);
        console.log(JSON.stringify({ suite: 'production-resource-preflight', expectedSha: EXPECTED_SHA, url, kind: resource.kind, bytes: bytes.length, sha256: hash(bytes), status: 'passed' }));
      } catch (error) {
        const message = String(error.message);
        failures.push({ url, message });
        console.error(JSON.stringify({ suite: 'production-resource-preflight', url, status: 'failed', message }));
      }
    }
    return failures;
}

export async function main() {
    const browserName = process.env.PLAYWRIGHT_BROWSER;
    const type = { chromium, firefox, webkit }[browserName];
    assert.ok(type, 'explicit supported browser is required');
    assert.equal(process.env.BASE_URL, ORIGIN, 'only the ordinary production origin is allowed');
    const { manifest, filePaths } = makeManifest();
    const startMain = proveSnapshot(filePaths);
    const preflightFailures = await preflight(manifest);
    const browser = await type.launch({ headless: true });
    const contexts = [];
    const networkTasks = [];
    const networkFailures = [];
    const pageErrors = [];
    const observed = new Set();
    const diagnosed = new Set();
    let checks = 0;
    const verifiedBrowser = {
        async newContext(options = {}) {
            const context = await browser.newContext(options);
            const ownNetworkTasks = [];
            const requests = new Map();
            const required = new Set();
            const verified = new Set();
            let closeChecksDone = false;
            const close = context.close.bind(context);
            const drain = async () => {
                const deadline = Date.now() + 15000;
                while ([...requests.values()].some(record => record.status === 'pending') && Date.now() < deadline) {
                    await new Promise(resolve => setTimeout(resolve, 25));
                }
                await Promise.all(ownNetworkTasks);
            };
            context.close = async () => {
                if (!closeChecksDone) {
                    await drain();
                    try { assertRequestsComplete([...requests.values()], required, verified); }
                    catch (error) { networkFailures.push(error.message.split('\n')[0]); }
                    closeChecksDone = true;
                }
                await close();
            };
            contexts.push(context);
            await context.route(url => isAnalyticsUrl(url.href), route => route.abort());
            context.on('request', request => {
                const resource = manifest.get(request.url());
                if (!resource) return;
                requests.set(request, { url: request.url(), status: 'pending' });
                if (resource.kind === 'html') {
                    required.add(request.url());
                    for (const url of resource.required) {
                        if (options.javaScriptEnabled === false && manifest.get(url).kind === 'js') continue;
                        required.add(url);
                    }
                }
            });
            context.on('requestfailed', request => {
                const record = requests.get(request);
                if (record) {
                    record.status = 'failed';
                    record.reason = request.failure()?.errorText || 'request failed';
                }
            });
            context.on('page', page => {
                page.setDefaultTimeout(20000);
                // The reused localhost suites navigate repeatedly in one page.
                // Production bodies must finish verification before navigating
                // away; load plus two frames also settles native autofocus.
                for (const method of ['goto', 'reload', 'goBack', 'goForward']) {
                    const navigate = page[method].bind(page);
                    page[method] = async (...args) => {
                        await drain();
                        const options = { ...(method === 'goto' ? args[1] : args[0]), waitUntil: 'load' };
                        const response = method === 'goto' ? await navigate(args[0], options) : await navigate(options);
                        await drain();
                        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                        return response;
                    };
                }
                page.on('pageerror', error => pageErrors.push(error.message));
            });
            context.on('response', response => {
                const resource = manifest.get(response.url());
                if (!resource) return;
                const task = (async () => {
                    assert.ok(response.ok(), 'browser HTTP failure: ' + resource.path);
                    assert.equal(response.request().redirectedFrom(), null, 'application redirect is not accepted');
                    validateMime(response.headers()['content-type'], resource);
                    const bytes = await withDeadline(response.body(), 15000, 'browser response body ' + resource.path);
                    if (resource.kind === 'html') {
                        try { assert.deepEqual(pageContract(bytes.toString('utf8'), response.url()), resource.contract, 'browser page differs: ' + resource.path); }
                        catch (error) {
                            if (!diagnosed.has(response.url())) {
                                diagnosed.add(response.url());
                                console.log(JSON.stringify({ suite: 'production-browser-page-diagnostic',
                                    browser: browserName, url: response.url(),
                                    expectedScripts: scriptInventory(expectedBytes(resource.path).toString('utf8')),
                                    actualScripts: scriptInventory(bytes.toString('utf8')), status: 'mismatch' }));
                            }
                            throw error;
                        }
                    } else assertResource(bytes, resource);
                    observed.add(response.url());
                    verified.add(response.url());
                    const record = requests.get(response.request());
                    assert.ok(record, 'response must correspond to a recorded application request');
                    assert.notEqual(record.status, 'failed', record.reason || 'application request failed');
                    record.status = 'verified';
                })().catch(error => {
                    const record = requests.get(response.request());
                    if (record) { record.status = 'failed'; record.reason = error.message.split('\n')[0]; }
                    networkFailures.push(resource.path + ': ' + error.message.split('\n')[0]);
                });
                networkTasks.push(task);
                ownNetworkTasks.push(task);
            });
            return context;
        }
    };
    async function check(label, tool, run, options) {
        const context = await verifiedBrowser.newContext(options);
        const page = await context.newPage();
        try {
            const url = ORIGIN + '/tools/' + tool + '/';
            const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            assert.equal(navigation.status(), 200);
            assert.equal(page.url(), url);
            await run(page);
            checks += 1;
            console.log(JSON.stringify({ suite: 'production-interaction', browser: browserName, label, status: 'passed' }));
        } finally {
            await Promise.all(networkTasks);
            await context.close();
        }
    }
    try {
        // Reuse the existing detailed input/undo/copy/download regression without
        // replacing application JS, workers, documents, CSS or data responses.
        await checkCardInputRecovery(verifiedBrowser, ORIGIN, browserName);
        await checkRmbInputLifecycle(check, browserName);
        const core = createRequire(import.meta.url)('../renovation_calculator/core.js');
        for (const vector of [
            { loanAmount: 2015, loanTerm: 12, serviceFeeRate: 0.5 },
            { loanAmount: 0.01, loanTerm: 600, serviceFeeRate: 0 },
            { loanAmount: 100000.01, loanTerm: 600, serviceFeeRate: 0.25 }
        ]) {
            await check('renovation exact schedule, real download, invalidation and recovery ' + vector.loanTerm + '/' + vector.loanAmount, 'renovation_calculator', async page => {
                await page.fill('#loanAmount', String(vector.loanAmount));
                await page.fill('#loanTerm', String(vector.loanTerm));
                await page.fill('#serviceFee', String(vector.serviceFeeRate));
                await page.click('#calculateBtn');
                await page.waitForSelector('.summary-card');
                const expected = core.generateSchedule(vector);
                const maximumRateDifference = assertScheduleParity(await page.evaluate(() => window.lastExportData), expected);
                console.log(JSON.stringify({ suite: 'production-renovation-numerical-evidence', browser: browserName,
                    vector, maximumRateDifference, monetaryFields: 'exact', displayedRates: 'exact 2 decimals' }));
                assert.equal(await page.locator('tbody tr').count(), vector.loanTerm + 1);
                const downloadPromise = page.waitForEvent('download');
                await page.click('.export-btn');
                const download = await downloadPromise;
                assert.equal(download.suggestedFilename(), '装修贷款还款明细表.csv');
                const stream = await download.createReadStream();
                assert.ok(stream, 'actual browser download must expose CSV bytes');
                const chunks = [];
                for await (const chunk of stream) chunks.push(chunk);
                const bytes = Buffer.concat(chunks);
                assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
                const lines = bytes.subarray(3).toString('utf8').trimEnd().split('\n');
                assert.equal(lines.length, vector.loanTerm + 2);
                assert.ok(lines.at(-1).startsWith('总计,'));
                await page.fill('#loanTerm', '601');
                assert.equal(await page.evaluate(() => window.lastExportData), null);
                assert.equal(await page.locator('.export-btn').count(), 0);
                await page.click('#calculateBtn');
                assert.match(await page.locator('#loanTermError').textContent(), /1-600/);
                await page.fill('#loanTerm', '12');
                await page.click('#calculateBtn');
                await page.waitForSelector('.summary-card');
            });
        }
        const rankings = JSON.parse(await readFile(new URL('../hospital_rank/data/rankings.json', import.meta.url), 'utf8'));
        const histories = new Map();
        for (const block of rankings.years) for (const row of block.records) {
            const years = histories.get(row.hospitalId) || [];
            years.push(block.year); histories.set(row.hospitalId, years);
        }
        const hospital = rankings.hospitals.find(item => histories.get(item.id)?.length === 1);
        assert.ok(hospital);
        await check('hospital trusted inside/backdrop/close/reopen/Escape with trigger focus', 'hospital_rank', async page => {
            await page.waitForFunction(() => !document.getElementById('yearSelect').disabled);
            await page.selectOption('#yearSelect', String(histories.get(hospital.id)[0]));
            await page.fill('#hospitalSearch', hospital.name);
            await page.waitForFunction(id => {
                const buttons = [...document.querySelectorAll('.hospital-history-button')];
                return buttons.length === 1 && buttons[0].dataset.hospitalId === id;
            }, hospital.id);
            const trigger = page.locator('.hospital-history-button');
            const open = async () => {
                await trigger.focus(); await page.keyboard.press('Enter');
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
            };
            await open();
            await page.locator('#historyDialogTitle').click();
            assert.equal(await page.locator('#historyDialog').evaluate(dialog => dialog.open), true);
            const point = await page.locator('#historyDialog').evaluate(dialog => {
                const rect = dialog.getBoundingClientRect();
                if (rect.top <= 8) throw new Error('no real backdrop exposed');
                return { x: rect.left + rect.width / 2, y: rect.top / 2 };
            });
            await page.mouse.click(point.x, point.y);
            await page.locator('#historyDialog').waitFor({ state: 'hidden' });
            assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
            await open();
            await page.click('#historyDialogClose');
            await page.locator('#historyDialog').waitFor({ state: 'hidden' });
            await open();
            await page.keyboard.press('Escape');
            await page.locator('#historyDialog').waitFor({ state: 'hidden' });
            assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
        }, { viewport: { width: 390, height: 844 }, hasTouch: true });
        for (const language of languages) for (const javaScriptEnabled of [true, false]) {
            const context = await verifiedBrowser.newContext({ javaScriptEnabled, viewport: { width: 390, height: 844 } });
            const page = await context.newPage();
            try {
                const url = ORIGIN + '/tools/translation_benchmark/' + language + '.html';
                await page.goto(url, { waitUntil: 'load', timeout: 30000 });
                assert.equal(page.url(), url);
                async function corpus() {
                    assert.deepEqual(await page.locator('.sample-text').allTextContents(), CORPUS[language].flatMap(([, samples]) => samples));
                    assert.equal(await page.locator('.category-section').count(), 16);
                    assert.equal(await page.locator('.sample-item').count(), 48);
                    assert.equal(await page.locator('html').getAttribute('lang'), language);
                    assert.equal(await page.locator('.test-nav a[aria-current="page"]').getAttribute('href'), language + '.html');
                    await page.locator('.sample-text').first().waitFor({ state: 'visible' });
                    assert.equal(await page.locator('.sample-text').first().isVisible(), true);
                }
                await corpus();
                await page.reload({ waitUntil: 'load' }); await corpus();
                const next = languages[(languages.indexOf(language) + 1) % languages.length];
                await page.locator('.test-nav a[href="' + next + '.html"]').click();
                await page.waitForURL('**/' + next + '.html');
                await page.goBack({ waitUntil: 'load' }); await corpus();
                checks += 1;
                console.log(JSON.stringify({ suite: 'production-translation', browser: browserName, language, javaScriptEnabled, status: 'passed' }));
            } finally {
                await Promise.all(networkTasks);
                await context.close();
            }
        }
        await Promise.all(networkTasks);
        assert.deepEqual(preflightFailures, [], 'ordinary production preflight mismatches remain acceptance failures');
        assert.deepEqual(networkFailures, [], 'all observed browser application responses must match fixed main bytes');
        assert.deepEqual(pageErrors, [], 'production page errors');
        for (const url of manifest.keys()) assert.ok(observed.has(url), 'browser never loaded required ordinary production resource: ' + url);
        const endMain = proveSnapshot(filePaths);
        const report = {
            suite: 'recent-optimizations-production', expectedSha: EXPECTED_SHA,
            startMain, endMain, browser: browserName, fixtureOnly: false,
            resources: manifest.size, observedResources: observed.size, additionalChecks: checks,
            reusedCardInputChecks: 33, status: 'passed',
            limits: 'Synthetic text only. Clipboard writes and composition events in reused cases are modeled. Native editing/undo, production app responses and CSV downloads are real. This does not prove OS IME, OS clipboard, all hardware or arbitrary inputs.'
        };
        console.log(JSON.stringify(report));
        if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, 'Recent optimization production acceptance\n\n' + JSON.stringify(report, null, 2) + '\n');
    } finally {
        await Promise.all(networkTasks);
        for (const context of contexts) await context.close().catch(() => {});
        await browser.close();
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => { console.error(error); process.exitCode = 1; });
}
