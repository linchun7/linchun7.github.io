import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

// Executed by renovation-rounding-regression.mjs in the existing GitHub Actions
// three-browser matrix. The checkout already has fetch-depth: 0.
// The fixed pre-extraction commit is an oracle, not a second shipped implementation.
const BASELINE_SHA = '657959ff0865ff609cedf729c97aa04129d8265f';
const core = createRequire(import.meta.url)('../core.js');
const baselineSource = execFileSync('git', [
    'show', BASELINE_SHA + ':tools/renovation_calculator/script.js'
], { encoding: 'utf8' });
const context = vm.createContext({
    // Baseline only: suppress registering its UI callback. The extracted core
    // is required above in Node without document, window, Blob, or any DOM shim.
    document: { addEventListener() {} }
});
new vm.Script(baselineSource + '\n;globalThis.baseline = { roundMoney, npv, IRR, annualizeMonthlyIRR, generateSchedule };')
    .runInContext(context);
const baseline = context.baseline;
const candidateContext = vm.createContext({});
new vm.Script(readFileSync(new URL('../core.js', import.meta.url), 'utf8')).runInContext(candidateContext);
const candidate = candidateContext.RenovationCore;

// Startup is synchronous, core comes before UI, and neither is Rocket Loader delayed.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script>/gi)]
    .map(([, attrs]) => ({ attrs, src: /\bsrc="([^"]+)"/.exec(attrs)?.[1] }))
    .filter(item => /^(core|script)\.js\?/.test(item.src || ''));
assert.deepEqual(scripts.map(item => item.src.split('?')[0]), ['core.js', 'script.js']);
for (const { attrs } of scripts) {
    assert.match(attrs, /\bdata-cfasync="false"[\s\S]*\bsrc=/);
    assert.doesNotMatch(attrs, /\b(async|defer)\b|\btype="module"/);
}
assert.ok(Object.isFrozen(core));
const uiSource = readFileSync(new URL('../script.js', import.meta.url), 'utf8');
for (const name of ['decimalFraction', 'roundMoney', 'npv', 'IRR', 'annualizeMonthlyIRR', 'generateSchedule']) {
    assert.ok(!uiSource.includes('function ' + name + '('), name + ': no duplicate UI implementation');
}
assert.match(uiSource, /const \{ roundMoney, npv, IRR, annualizeMonthlyIRR, generateSchedule \} = RenovationCore;/);

// Exact midpoint expectations are independent constants, including the adjacent
// representable values. Do not replace this contract with epsilon rounding.
for (const [left, right, divisor, expected] of [
    [10.075, 1, 1, 10.08],
    [10.07499999999999, 1, 1, 10.07],
    [10.07500000000001, 1, 1, 10.08],
    [1.005, 1, 1, 1.01],
    [-1.005, 1, 1, -1.01],
    [2015, 0.5, 100, 10.08],
    [2015, 0.4999999999999999, 100, 10.07],
    [1.13, 50, 100, 0.57],
    [0.29, 150, 100, 0.44],
    [1e3, 1.5e-1, 100, 1.5],
    [0, 1, 1, 0]
]) {
    assert.equal(core.roundMoney(left, right, divisor), expected);
    assert.equal(core.roundMoney(left, right, divisor), baseline.roundMoney(left, right, divisor));
}
for (const flows of [[], [0, 0], [NaN, 1], [-100, 0]]) {
    assert.ok(Number.isNaN(core.IRR(flows)));
    assert.ok(Number.isNaN(baseline.IRR(flows)));
}
for (const rate of [NaN, Infinity, -1, -2]) {
    assert.ok(Number.isNaN(core.annualizeMonthlyIRR(rate)));
}
assert.equal(core.IRR([-100, 100]), 0);
assert.equal(core.annualizeMonthlyIRR(0), 0);

const vectors = [
    { loanAmount: 2015, loanTerm: 12, serviceFeeRate: 0.5 },
    { loanAmount: 1.13, loanTerm: 12, serviceFeeRate: 50 },
    { loanAmount: 0.29, loanTerm: 12, serviceFeeRate: 150 },
    { loanAmount: core.roundMoney(1.005), loanTerm: 2, serviceFeeRate: 0 },
    { loanAmount: core.roundMoney(100000.001), loanTerm: 12, serviceFeeRate: 0 },
    { loanAmount: 1000, loanTerm: 600, serviceFeeRate: 0.15 },
    { loanAmount: 0.01, loanTerm: 600, serviceFeeRate: 0 },
    { loanAmount: 0.01, loanTerm: 600, serviceFeeRate: 50 },
    { loanAmount: 10000000.01, loanTerm: 600, serviceFeeRate: 0.3 },
    { loanAmount: 100000, loanTerm: 1, serviceFeeRate: 0.15 }
];
const SEED = 0x20261015;
let seed = SEED;
const random = max => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
};
const terms = [1, 2, 7, 12, 36, 60, 96, 360, 600];
const rates = [0, 0.0001, 0.01, 0.15, 0.3, 0.5, 50, 150];
for (let index = 0; index < 48; index++) {
    vectors.push({
        loanAmount: (1 + random(10000000)) / 100,
        loanTerm: terms[index % terms.length],
        serviceFeeRate: rates[index % rates.length]
    });
}

function directAPR(flows) {
    const directNPV = rate => flows.reduce((sum, value, index) => sum + value / Math.pow(1 + rate, index), 0);
    if (Math.abs(directNPV(0)) < 1e-10) return 0;
    let low = 0, high = 1;
    while (directNPV(high) > 0) high *= 2;
    for (let index = 0; index < 120; index++) {
        const middle = (low + high) / 2;
        if (directNPV(middle) > 0) low = middle;
        else high = middle;
    }
    return (Math.pow(1 + (low + high) / 2, 12) - 1) * 100;
}
function close(actual, expected, label) {
    assert.ok(Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-8),
        label + ': ' + actual + ' vs ' + expected);
}
const cents = value => Math.round(value * 100);
for (const [index, vector] of vectors.entries()) {
    const input = Object.freeze({ ...vector });
    const actual = core.generateSchedule(input);
    const expected = structuredClone(baseline.generateSchedule(input));
    assert.deepEqual(actual, expected, 'exact baseline parity, vector ' + index);
    assert.deepEqual(input, vector, 'input remains unchanged');
    assert.equal(actual.schedule.length, input.loanTerm);
    const loanCents = cents(input.loanAmount);
    let previousPaid = 0, paymentCents = 0, feeCents = 0;
    for (const row of actual.schedule) {
        // Independently calculated cumulative integer-cent target.
        const targetCents = Math.floor((2 * loanCents * row.month + input.loanTerm) / (2 * input.loanTerm));
        assert.equal(cents(row.principal), targetCents - previousPaid);
        assert.equal(cents(row.totalPaidPrincipal), targetCents);
        assert.equal(cents(row.remainingPrincipal) + targetCents, loanCents);
        assert.equal(cents(row.payment), cents(row.principal) + cents(row.serviceFee));
        assert.ok(row.principal >= 0 && row.remainingPrincipal >= 0);
        assert.ok(Number.isFinite(row.earlyRepaymentAPR));
        previousPaid = targetCents;
        paymentCents += cents(row.payment);
        feeCents += cents(row.serviceFee);
    }
    assert.equal(previousPaid, loanCents);
    assert.equal(actual.schedule.at(-1).remainingPrincipal, 0);
    assert.equal(actual.schedule.at(-1).earlyRepaymentAPR, actual.apr);
    assert.equal(cents(actual.totals.totalPrincipal), loanCents);
    assert.equal(cents(actual.totals.totalPayment), paymentCents);
    assert.equal(cents(actual.totals.totalServiceFee), feeCents);
    assert.equal(paymentCents, loanCents + feeCents);
    if (input.serviceFeeRate === 0) {
        assert.equal(actual.apr, 0);
        assert.ok(actual.schedule.every(row => row.earlyRepaymentAPR === 0));
    }
    // Direct discounting uses a separate NPV expression and search bounds.
    // Probe beginning/middle/end settlements for every input, including 600 months.
    close(actual.apr, directAPR([-input.loanAmount, ...actual.schedule.map(row => row.payment)]), 'full APR');
    for (const rowIndex of new Set([0, Math.floor((input.loanTerm - 1) / 2), input.loanTerm - 1])) {
        const row = actual.schedule[rowIndex];
        const earlyFlows = [-input.loanAmount, ...actual.schedule.slice(0, rowIndex).map(item => item.payment),
            (cents(row.payment) + cents(row.remainingPrincipal)) / 100];
        close(row.earlyRepaymentAPR, directAPR(earlyFlows), 'early APR at ' + row.month);
    }
}

// Paired same-input compute-only diagnostic; deliberately no speed threshold.
// The work and output timing remain synchronous and the solver is unchanged.
const timings = [];
function duration(fn, input) {
    const started = performance.now();
    const result = fn(input);
    const elapsed = performance.now() - started;
    assert.equal(result.schedule.length, input.loanTerm);
    return elapsed;
}
for (const term of [12, 60, 360, 600]) {
    const input = Object.freeze({ loanAmount: 100000, loanTerm: term, serviceFeeRate: 0.25 });
    baseline.generateSchedule(input);
    candidate.generateSchedule(input);
    const before = [], after = [];
    for (let iteration = 0; iteration < 7; iteration++) {
        // Alternate order to reduce systematic warmup/order bias.
        if (iteration % 2 === 0) {
            before.push(duration(baseline.generateSchedule, input));
            after.push(duration(candidate.generateSchedule, input));
        } else {
            after.push(duration(candidate.generateSchedule, input));
            before.push(duration(baseline.generateSchedule, input));
        }
    }
    const summary = values => {
        const sorted = [...values].sort((a, b) => a - b);
        return { medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1), samplesMs: values };
    };
    timings.push({ term, baseline: summary(before), extractedCore: summary(after) });
}
console.log(JSON.stringify({
    check: 'renovation-pure-core', baseline: BASELINE_SHA, seed: SEED,
    browserJob: process.env.PLAYWRIGHT_BROWSER || 'unspecified',
    node: process.version, parityVectors: vectors.length, timings,
    interpretation: 'Diagnostic only. Both solvers run in isolated VM contexts; runner noise and browser DOM/CSV work are outside this compute-only comparison. No speed threshold or speedup claim.'
}, null, 2));
