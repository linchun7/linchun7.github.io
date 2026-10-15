import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// This bounded diagnostic runs once, in the Chromium Actions job only.
// Existing oracle, input, financial zero-value and renovation tests remain the
// correctness suites. Timings and heap deltas below are observations, not SLAs.
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await chromium.launch({ headless: true });
const diagnostics = { environment: 'GitHub Actions Chromium', browser: browser.version() };

function expectedAt(patternLength, index) {
    const body = '6222' + String(index).padStart(patternLength - 5, '0');
    for (let check = 0; check < 10; check++) {
        const candidate = body + check;
        let sum = 0;
        for (let position = candidate.length - 1; position >= 0; position--) {
            let value = Number(candidate[position]);
            if ((candidate.length - 1 - position) % 2) {
                value *= 2;
                if (value > 9) value -= 9;
            }
            sum += value;
        }
        if (sum % 10 === 0) return candidate;
    }
    throw new Error('check digit must exist');
}

async function newPage() {
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.route('**/googletagmanager.com/**', route => route.abort());
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    return { context, page, errors };
}

try {
    // Measure the real synchronous input handler plus its text rendering. The
    // legacy page is capped, but it still occupies the main thread while running.
    const legacy = await newPage();
    try {
        await legacy.page.goto(baseUrl + '/tools/card_number/', { waitUntil: 'domcontentloaded' });
        diagnostics.legacy = [];
        for (const length of [16, 100]) {
            const rule = '6222' + '*'.repeat(length - 4);
            const observed = await legacy.page.evaluate(rule => {
                const input = document.getElementById('inputField');
                input.value = rule;
                const started = performance.now();
                input.dispatchEvent(new InputEvent('input', { bubbles: true }));
                const elapsedMs = performance.now() - started;
                return {
                    elapsedMs, count: results.length,
                    first: results[0], last: results.at(-1),
                    counter: document.getElementById('count').textContent,
                    renderedLength: document.getElementById('result').textContent.length
                };
            }, rule);
            assert.equal(observed.count, 50000);
            assert.equal(observed.first.replace(/\s/g, ''), expectedAt(length, 0));
            assert.equal(observed.last.replace(/\s/g, ''), expectedAt(length, 49999));
            assert.match(observed.counter, /前 50000 条/);
            diagnostics.legacy.push({ patternLength: length, ...observed });
        }
        assert.deepEqual(legacy.errors, []);
    } finally {
        await legacy.context.close();
    }

    // Observe the shipped main-thread retained results, after the real Worker
    // finishes and terminates. CDP usedSize is main V8 isolate heap, not RSS,
    // total browser memory, Worker peak memory, Safari or a mobile-device claim.
    const retained = await newPage();
    try {
        await retained.page.goto(baseUrl + '/tools/card_number_new/', { waitUntil: 'domcontentloaded' });
        const session = await retained.context.newCDPSession(retained.page);
        await session.send('HeapProfiler.collectGarbage');
        const before = await session.send('Runtime.getHeapUsage');
        const length = 100;
        await retained.page.fill('#inputField', '6222' + '*'.repeat(length - 4));
        const started = Date.now();
        await retained.page.click('#calcBtn');
        await retained.page.waitForFunction(() =>
            document.getElementById('stopBtn').hidden &&
            document.getElementById('status-bar').textContent.includes('仅生成前'),
            null, { timeout: 120000 });
        const observed = await retained.page.evaluate(() => ({
            count: results.length,
            expectedCount,
            downloadMode,
            workerTerminated: worker === null,
            lengths: [results[0].length, results.at(-1).length],
            samples: [0, 199, 200, 999999].map(index => ({ index, value: results[index] })),
            strictlyOrdered: results.every((value, index) => index === 0 || results[index - 1] < value),
            pages: document.getElementById('totalPages').textContent,
            visibleRows: document.querySelectorAll('.result-row').length
        }));
        const generationAndRenderMs = Date.now() - started;
        assert.equal(observed.count, 1000000);
        assert.equal(observed.expectedCount, (10n ** 95n).toString());
        assert.equal(observed.downloadMode, 'retained');
        assert.equal(observed.workerTerminated, true);
        assert.deepEqual(observed.lengths, [100, 100]);
        assert.equal(observed.strictlyOrdered, true);
        assert.equal(observed.pages, '5,000');
        assert.equal(observed.visibleRows, 200);
        for (const sample of observed.samples) assert.equal(sample.value, expectedAt(length, sample.index));
        await session.send('HeapProfiler.collectGarbage');
        const after = await session.send('Runtime.getHeapUsage');
        diagnostics.retained = {
            ...observed, generationAndRenderMs, mainIsolateHeapBefore: before,
            mainIsolateHeapAfter: after, mainIsolateUsedHeapDelta: after.usedSize - before.usedSize,
            minimumDigitPayloadBytesIfOneBytePerDigit: 100000000,
            interpretation: 'Bounded runner observation only. No OOM, cross-device memory guarantee, sub-1MB design or 10x speedup claim.'
        };
        assert.deepEqual(retained.errors, []);
    } finally {
        await retained.context.close();
    }

    // Deterministic lifecycle test: cancellation must terminate the instance,
    // preserve the partial sample and ignore late messages from that instance.
    const cancelled = await newPage();
    try {
        await cancelled.page.addInitScript(() => {
            window.auditWorkers = [];
            window.Worker = class {
                constructor() { this.terminateCount = 0; window.auditWorkers.push(this); }
                terminate() { this.terminateCount++; }
                postMessage() {
                    queueMicrotask(() => {
                        this.onmessage({ data: { type: 'meta', expectedCount: '10' } });
                        this.onmessage({ data: { type: 'chunk', data: ['79927398713'], count: 1 } });
                    });
                }
            };
        });
        await cancelled.page.goto(baseUrl + '/tools/card_number_new/', { waitUntil: 'domcontentloaded' });
        await cancelled.page.fill('#inputField', '7992739871*');
        await cancelled.page.click('#calcBtn');
        await cancelled.page.waitForFunction(() => document.getElementById('resultCount').textContent === '1');
        await cancelled.page.click('#stopBtn');
        assert.deepEqual(await cancelled.page.evaluate(() => ({
            calls: auditWorkers[0].terminateCount, stopped: worker === null,
            mode: downloadMode, count: results.length
        })), { calls: 1, stopped: true, mode: 'partial', count: 1 });
        await cancelled.page.evaluate(() => {
            auditWorkers[0].onmessage({ data: { type: 'chunk', data: ['99999999999'], count: 2 } });
            auditWorkers[0].onmessage({ data: { type: 'done', count: 2, truncated: false } });
        });
        assert.equal(await cancelled.page.locator('#resultCount').textContent(), '1');
        assert.match(await cancelled.page.locator('#status-bar').textContent(), /已停止/);
        const downloadPromise = cancelled.page.waitForEvent('download');
        await cancelled.page.click('#downloadBtn');
        const download = await downloadPromise;
        assert.match(download.suggestedFilename(), /1条_部分结果\.csv$/);
        const stream = await download.createReadStream();
        let csv = '';
        for await (const chunk of stream) csv += chunk.toString('utf8');
        assert.match(csv, /银行卡号,特征标签/);
        assert.match(csv, /7992 7398 713/);
        assert.doesNotMatch(csv, /9999 9999 999/);
        assert.deepEqual(cancelled.errors, []);
        diagnostics.cancellation = 'terminate once; stale chunk/done ignored; partial CSV preserved';
    } finally {
        await cancelled.context.close();
    }

    console.log(JSON.stringify({ check: 'math-card-report-verification', ...diagnostics }, null, 2));
} finally {
    await browser.close();
}
