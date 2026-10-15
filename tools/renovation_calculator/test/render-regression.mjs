import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Fixed pre-cache shipped UI, read from the existing full-history Actions checkout.
// Keep the numerical core and browser startup identical in both real pages.
const BASELINE_SHA = '0101f1db88602380c45290449bb4743a35db8333';
const baselineSource = execFileSync('git', [
    'show', BASELINE_SHA + ':tools/renovation_calculator/script.js'
], { encoding: 'utf8' });
// Test the actual shipped UI, never a synthesized or test-only fast path.
const candidateSource = readFileSync(new URL('../script.js', import.meta.url), 'utf8');

function summary(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const midpoint = sorted.length / 2;
    return {
        medianMs: (sorted[midpoint - 1] + sorted[midpoint]) / 2,
        minMs: sorted[0], maxMs: sorted.at(-1),
        samplesMs: values
    };
}

export async function runRenderRegression({ browser, browserName, baseUrl }) {
    const contexts = [];
    const errors = [];
    async function open(source, label) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        contexts.push(context);
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(label + ': ' + error.message));
        await page.route('**/googletagmanager.com/**', route => route.abort());
        await page.route('**/tools/renovation_calculator/script.js?*', route => route.fulfill({
            status: 200, contentType: 'application/javascript; charset=utf-8', body: source
        }));
        await page.addInitScript(() => {
            const NativeNumberFormat = Intl.NumberFormat;
            window.__moneyFormatterConstructions = 0;
            window.__nativeMoneyNumberFormat = NativeNumberFormat;
            window.__countedMoneyNumberFormat = new Proxy(NativeNumberFormat, {
                construct(target, args, newTarget) {
                    window.__moneyFormatterConstructions += 1;
                    return Reflect.construct(target, args, newTarget);
                }
            });
            Intl.NumberFormat = window.__countedMoneyNumberFormat;
            const nativeCreate = URL.createObjectURL.bind(URL);
            URL.createObjectURL = blob => {
                window.__renderCSVBlob = blob;
                return nativeCreate(blob);
            };
            HTMLAnchorElement.prototype.click = function () {
                window.__renderCSVFilename = this.download;
            };
        });
        await page.goto(baseUrl + '/tools/renovation_calculator/', { waitUntil: 'domcontentloaded' });
        return page;
    }

    try {
        const before = await open(baselineSource, 'baseline');
        const after = await open(candidateSource, 'candidate');
        assert.equal(await before.evaluate(() => window.__moneyFormatterConstructions), 0);
        assert.equal(await after.evaluate(() => window.__moneyFormatterConstructions), 1);
        const timings = [];
        for (const term of [12, 60, 600]) {
            const exact = [];
            for (const [index, page] of [before, after].entries()) {
                await page.fill('#loanAmount', '100000.01');
                await page.fill('#loanTerm', String(term));
                await page.fill('#serviceFee', '0.25');
                const initialCount = await page.evaluate(() => window.__moneyFormatterConstructions);
                await page.click('#calculateBtn');
                await page.waitForSelector('.summary-card');
                const actual = await page.evaluate(async () => {
                    const result = window.lastExportData;
                    const rendered = document.getElementById('result').innerHTML;
                    const renderCount = window.__moneyFormatterConstructions;
                    document.querySelector('.export-btn').click();
                    const bytes = Array.from(new Uint8Array(await window.__renderCSVBlob.arrayBuffer()));
                    return {
                        result, rendered, bytes, renderCount,
                        csvCount: window.__moneyFormatterConstructions,
                        rows: document.querySelectorAll('tbody tr').length,
                        filename: window.__renderCSVFilename
                    };
                });
                assert.equal(actual.rows, term + 1);
                assert.equal(actual.filename, '装修贷款还款明细表.csv');
                assert.deepEqual(actual.bytes.slice(0, 3), [0xEF, 0xBB, 0xBF], 'UTF-8 BOM');
                const lines = new TextDecoder().decode(new Uint8Array(actual.bytes).subarray(3)).trimEnd().split('\n');
                assert.equal(lines.length, term + 2, 'every CSV row and totals are present');
                const expectedRenderCount = index === 0 ? 5 * term + 6 : 0;
                const expectedCSVCount = index === 0 ? 5 * term + 3 : 0;
                assert.equal(actual.renderCount - initialCount, expectedRenderCount);
                assert.equal(actual.csvCount - actual.renderCount, expectedCSVCount);
                if (index === 1) assert.equal(actual.csvCount, 1, 'one formatter for all calculations and exports');
                exact.push(actual);
            }
            assert.deepEqual(exact[1].result, exact[0].result, 'every numeric field unchanged at ' + term + ' months');
            assert.equal(exact[1].rendered, exact[0].rendered, 'complete rendered HTML unchanged at ' + term + ' months');
            assert.deepEqual(exact[1].bytes, exact[0].bytes, 'complete CSV bytes unchanged at ' + term + ' months');

            async function sample(page, operation, repetitions) {
                return page.evaluate(({ operation, repetitions }) => {
                    const { schedule, totals, apr } = window.lastExportData;
                    const resultElement = document.getElementById('result');
                    const started = performance.now();
                    for (let index = 0; index < repetitions; index++) {
                        if (operation === 'render') {
                            resultElement.innerHTML = renderTable(schedule, totals, apr);
                            // Include actual DOM insertion and synchronous style/layout.
                            void resultElement.offsetHeight;
                        } else {
                            exportToCSV(schedule, totals);
                        }
                    }
                    return (performance.now() - started) / repetitions;
                }, { operation, repetitions });
            }

            // Constructor counting and timing are separate: do not charge the
            // repeated baseline for the instrumentation proxy during measurement.
            for (const page of [before, after]) {
                await page.evaluate(() => { Intl.NumberFormat = window.__nativeMoneyNumberFormat; });
            }
            const repetitions = term === 600 ? 1 : 3;
            const metrics = {};
            for (const operation of ['render', 'csv']) {
                for (let warmup = 0; warmup < 3; warmup++) {
                    await sample(before, operation, repetitions);
                    await sample(after, operation, repetitions);
                }
                const baseline = [], cached = [];
                for (let round = 0; round < 12; round++) {
                    const order = round % 2 === 0
                        ? [[before, baseline], [after, cached]]
                        : [[after, cached], [before, baseline]];
                    for (const [page, values] of order) values.push(await sample(page, operation, repetitions));
                }
                metrics[operation] = { baseline: summary(baseline), cached: summary(cached) };
            }
            for (const page of [before, after]) {
                await page.evaluate(() => { Intl.NumberFormat = window.__countedMoneyNumberFormat; });
            }
            assert.equal(await after.evaluate(() => window.__moneyFormatterConstructions), 1);
            timings.push({ term, repetitionsPerSample: repetitions, metrics });
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({
            check: 'renovation-render-csv-formatting', baseline: BASELINE_SHA,
            browser: browserName, stage: 'shipped singleton UI against fixed pre-cache UI',
            pairedRounds: 12, warmupRounds: 3,
            exactOutputCases: [12, 60, 600], candidateFormatterConstructions: 1,
            timings,
            interpretation: 'Same browser, real pages, alternating order, identical precomputed schedules. Render includes shipped renderTable, DOM insertion and forced layout; CSV uses the complete shipped export handler. Solvers and constructor-counting proxy are outside timing. Medians, full samples and min/max report runner variation; no flaky timing threshold.'
        }, null, 2));
    } finally {
        for (const context of contexts) await context.close();
    }
}
