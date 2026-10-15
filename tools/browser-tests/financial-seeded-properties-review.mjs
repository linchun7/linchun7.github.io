// PROPOSED TEST TEXT ONLY. Never executed locally during this review.
// Intended repository path: tools/browser-tests/financial-seeded-properties-review.mjs
import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const SEED = 0x1846cafe;
let state = SEED;
function randomInt(limit) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
}
const abs = n => n < 0n ? -n : n;
function gcd(a, b) { a = abs(a); b = abs(b); while (b) [a, b] = [b, a % b]; return a; }
function rational(n, d = 1n) {
    assert.notEqual(d, 0n);
    if (d < 0n) { n = -n; d = -d; }
    const g = gcd(n, d);
    return [n / g, d / g];
}
function decimal(text) {
    const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
    assert.ok(m, text);
    const n = BigInt(m[2] + (m[3] || '')) * (m[1] === '-' ? -1n : 1n);
    const scale = (m[3] || '').length - Number(m[4] || 0);
    return scale >= 0 ? rational(n, 10n ** BigInt(scale)) : rational(n * 10n ** BigInt(-scale));
}
const integer = n => rational(BigInt(n));
const add = ([a, b], [c, d]) => rational(a * d + c * b, b * d);
const sub = ([a, b], [c, d]) => rational(a * d - c * b, b * d);
const mul = ([a, b], [c, d]) => rational(a * c, b * d);
const div = ([a, b], [c, d]) => rational(a * d, b * c);
const power = ([a, b], n) => rational(a ** BigInt(n), b ** BigInt(n));
const ONE = integer(1);
const HUNDRED = integer(100);

// Exact decimal input serialization, without binary floating arithmetic.
function inputText([n, d]) {
    let scale = 0;
    let factor = 1n;
    while (factor % d !== 0n && scale < 1000) { factor *= 10n; scale++; }
    assert.equal(factor % d, 0n, 'input must have a terminating decimal expansion');
    const digits = (abs(n) * (factor / d)).toString().padStart(scale + 1, '0');
    return (n < 0n ? '-' : '') + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits);
}
function roundedText([n, d]) {
    const scaled = abs(n) * 100n;
    const cents = scaled / d + (scaled % d * 2n >= d ? 1n : 0n);
    const digits = cents.toString().padStart(3, '0');
    return (n < 0n && cents ? '-' : '') + `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
// Exclude both exact half-cent ties and a generous nearby interval. The main
// suite does not decide an unspecified half-up-versus-binary-tie contract.
function safelyAwayFromMidpoint([n, d]) {
    const remainder = abs(n) * 100n % d;
    return abs(2n * remainder - d) * 1000000n > d;
}
const vectors = [];
const relations = [];
let skipped = 0;
const skippedCases = [];
function addVector(name, tab, fields, selects, expected, options = {}) {
    if (!options.diagnostic && !expected.every(safelyAwayFromMidpoint)) { skipped++; skippedCases.push({ name, reason: 'rounding-midpoint' }); return null; }
    const index = vectors.length;
    vectors.push({ name, tab, fields, selects, expected: expected.map(roundedText), ...options });
    return index;
}
function simpleInterest(p, apr, days, basis) {
    return div(mul(mul(p, apr), integer(days)), integer(100 * basis));
}

// 48 deterministic groups: simple forward/inverse/scaling, compound base/scaling,
// CAGR base/scaling. Expected values use integer rational arithmetic only.
for (let i = 0; i < 48; i++) {
    const basis = i % 2 ? 365 : 360;
    const principal = integer((1 + randomInt(200)) * 100);
    const days = 1 + randomInt(365);
    const signed = (i % 3 ? 1 : -1) * (1 + randomInt(80));
    // The annual basis cancels exactly, allowing exact inverse input rather
    // than feeding a rounded screen result back into the inverse calculator.
    const apr = rational(BigInt(basis * signed), 10000n);
    const earnings = simpleInterest(principal, apr, days, basis);
    const baseFields = { principal2: inputText(principal), annualRate2: inputText(apr), days2: String(days) };
    const forward = addVector(`simple-forward-${i}`, 2, baseFields, { rateType2: String(basis) }, [earnings]);
    addVector(`simple-inverse-${i}`, 1, { principal1: inputText(principal), interest1: inputText(earnings), days1: String(days) }, { rateType1: String(basis) },
        [div(mul(earnings, integer(basis * 100)), mul(principal, integer(days)))]);
    const scaled = addVector(`simple-scale-7-${i}`, 2, { ...baseFields, principal2: inputText(mul(principal, integer(7))) }, { rateType2: String(basis) }, [mul(earnings, integer(7))]);
    if (forward !== null && scaled !== null) relations.push({ kind: 'scale', a: forward, b: scaled, factor: 7 });

    const cp = rational(BigInt(10000 + randomInt(1000000)), 100n);
    const periods = i % 8 === 0 ? 1 : 2 + randomInt(23);
    const ca = i % 12 === 0 ? integer(0) : rational(BigInt(randomInt(4001) - 2000), 100n);
    const divisor = [1, 2, 4, 12][i % 4];
    const frequency = ['annually', 'semi-annually', 'quarterly', 'monthly'][i % 4];
    const balance = mul(cp, power(add(ONE, div(ca, integer(100 * divisor))), periods));
    const gain = sub(balance, cp);
    const compound = addVector(`compound-${i}`, 4, { principal3: inputText(cp), annualRate3: inputText(ca), depositPeriod: String(periods) }, { compoundingFrequency: frequency, rateType4: '360' }, [balance, gain], { rows: periods });
    const compoundScaled = addVector(`compound-scale-3-${i}`, 4, { principal3: inputText(mul(cp, integer(3))), annualRate3: inputText(ca), depositPeriod: String(periods) }, { compoundingFrequency: frequency, rateType4: '365' }, [mul(balance, integer(3)), mul(gain, integer(3))], { rows: periods });
    if (compound !== null && compoundScaled !== null) relations.push({ kind: 'scale', a: compound, b: compoundScaled, factor: 3 });

    // Durations are exact UTC calendar differences: 365, 180 and 90 days.
    // Their annualization powers 1, 2, 4 produce an independent rational CAGR.
    const cg = [
        { end: '2027-01-01', days: 365, basis: 365, exponent: 1 },
        { end: '2026-06-30', days: 180, basis: 360, exponent: 2 },
        { end: '2026-04-01', days: 90, basis: 360, exponent: 4 }
    ][i % 3];
    const start = rational(BigInt(500 + randomInt(1500)), 1000n);
    const end = mul(start, add(ONE, rational(BigInt(randomInt(401) - 200), 1000n)));
    const cagr = mul(sub(power(div(end, start), cg.exponent), ONE), HUNDRED);
    const common = { startDate: '2026-01-01', endDate: cg.end };
    const cagrBase = addVector(`cagr-${i}`, 3, { ...common, startNetValue: inputText(start), endNetValue: inputText(end) }, { rateType3: String(cg.basis) }, [cagr], { days: cg.days });
    const cagrScaled = addVector(`cagr-scale-7-${i}`, 3, { ...common, startNetValue: inputText(mul(start, integer(7))), endNetValue: inputText(mul(end, integer(7))) }, { rateType3: String(cg.basis) }, [cagr], { days: cg.days });
    if (cagrBase !== null && cagrScaled !== null) relations.push({ kind: 'equal', a: cagrBase, b: cagrScaled });
}
const mainCount = vectors.length;
assert.equal(mainCount + skipped, 48 * 7, 'every generated case is accounted for');
const familyCounts = Object.fromEntries(['simple-forward-', 'simple-inverse-', 'simple-scale-7-', 'compound-', 'compound-scale-3-', 'cagr-', 'cagr-scale-7-'].map(prefix => [prefix, vectors.filter(item => item.name.startsWith(prefix) && (prefix !== 'compound-' || !item.name.startsWith('compound-scale-')) && (prefix !== 'cagr-' || !item.name.startsWith('cagr-scale-'))).length]));
for (const [family, count] of Object.entries(familyCounts)) assert.ok(count > 0, `missing family: ${family}`);
assert.ok(mainCount >= 100, `seed ${SEED}: only ${mainCount} non-midpoint cases`);

// Explicit boundary contract: zero rate is legal, zero periods is not.
addVector('compound-zero-period-rejected', 4, { principal3: '1000', annualRate3: '0', depositPeriod: '0' }, { compoundingFrequency: 'annually' }, [], { expectError: true });
addVector('compound-one-period-zero-rate', 4, { principal3: '1000', annualRate3: '0', depositPeriod: '1' }, { compoundingFrequency: 'annually' }, [integer(1000), integer(0)], { rows: 1 });
addVector('compound-many-periods-zero-rate', 4, { principal3: '1000', annualRate3: '0', depositPeriod: '24' }, { compoundingFrequency: 'annually' }, [integer(1000), integer(0)], { rows: 24 });
const blockingCount = vectors.length;

// Six decimal-rounding candidate probes. These are diagnostics, not an assertion
// that the product has agreed to decimal half-up at an exact midpoint.
for (const [p, apr, n] of [['1.13', '50', 1], ['0.29', '150', 1], ['2015', '0.5', 1], ['1000', '5', 2], ['1000', '-50', 3], ['100000', '0', 12]]) {
    const principal = decimal(p);
    const balance = mul(principal, power(add(ONE, div(decimal(apr), HUNDRED)), n));
    addVector(`rounding-diagnostic-${p}-${apr}-${n}`, 4, { principal3: p, annualRate3: apr, depositPeriod: String(n) }, { compoundingFrequency: 'annually' }, [balance, sub(balance, principal)], { diagnostic: 'rounding-contract' });
}
addVector('extreme-simple-product', 2, { principal2: '1e308', annualRate2: '200', days2: '1' }, { rateType2: '360' }, [div(decimal('1e308'), integer(180))], { diagnostic: 'finite-extreme', relativeTolerance: 1e-11 });
addVector('extreme-simple-quotient', 1, { principal1: '0.1', interest1: '1e308', days1: '1000000' }, { rateType1: '360' }, [decimal('3.6e307')], { diagnostic: 'finite-extreme', relativeTolerance: 1e-11 });
const weeklyP = decimal('1e-304');
const weeklyGain = mul(weeklyP, div(mul(decimal('1e308'), integer(7)), integer(36500)));
addVector('extreme-weekly-rate', 4, { principal3: '1e-304', annualRate3: '1e308', depositPeriod: '1' }, { compoundingFrequency: 'weekly', rateType4: '365' }, [add(weeklyP, weeklyGain), weeklyGain], { diagnostic: 'finite-extreme' });

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, `Unsupported browser: ${browserName}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.route('**/googletagmanager.com/**', route => route.abort());
try {
    await page.goto(`${base}/tools/financial_calculator/`, { waitUntil: 'domcontentloaded' });
    // One browser page and one evaluate call for the entire bounded batch.
    // Real DOM button listeners are exercised; no private functions are called.
    const actual = await page.evaluate(cases => cases.map(item => {
        document.getElementById(`tab${item.tab}`).click();
        for (const [id, value] of Object.entries({ ...item.fields, ...item.selects })) {
            const element = document.getElementById(id);
            element.value = value;
            element.dispatchEvent(new Event('change', { bubbles: true }));
        }
        document.getElementById(`calculate${item.tab}`).click();
        const result = document.getElementById(`result${item.tab}`);
        return { text: result.textContent, error: result.classList.contains('result-error'),
            rows: document.querySelectorAll('#result4-table tbody tr').length };
    }), vectors);

    function values(item, result) {
        const pattern = item.tab === 1 ? /^单利年化收益率：(.+)%$/
            : item.tab === 2 ? /^利息收益：(.+) 元$/
            : item.tab === 3 ? /^净值年化收益率：(.+)%（持有 (\d+) 天）$/
            : /^本息总计：(.+) 元；利息总计：(.+) 元$/;
        const match = pattern.exec(result.text);
        assert.ok(match, result.text);
        if (item.days !== undefined) assert.equal(Number(match[2]), item.days);
        return match.slice(1, item.tab === 4 ? 3 : 2).map(value => value.replaceAll(',', '').replace(/^-0\.00$/, '0.00'));
    }
    const failures = [];
    const diagnostics = [];
    const parsed = [];
    for (let i = 0; i < vectors.length; i++) {
        const item = vectors[i];
        const result = actual[i];
        try {
            assert.equal(result.error, Boolean(item.expectError), result.text);
            if (!item.expectError) {
                parsed[i] = values(item, result);
                if (item.relativeTolerance) {
                    parsed[i].forEach((value, column) => {
                        const observed = Number(value), expected = Number(item.expected[column]);
                        assert.ok(Number.isFinite(observed) && Number.isFinite(expected));
                        assert.ok(Math.abs(observed - expected) <= Math.abs(expected) * item.relativeTolerance);
                    });
                } else assert.deepEqual(parsed[i], item.expected);
            }
            if (item.rows !== undefined) assert.equal(result.rows, item.rows);
            if (item.diagnostic) diagnostics.push({ seed: SEED, name: item.name, category: item.diagnostic, status: 'matched-reference', fields: item.fields, selects: item.selects, actual: result.text });
        } catch (error) {
            const entry = { seed: SEED, browser: browserName, name: item.name, fields: item.fields, selects: item.selects, expected: item.expected, actual: result, message: error.message };
            if (item.diagnostic) diagnostics.push({ ...entry, category: item.diagnostic, status: result.error ? 'rejected-finite-input' : 'reference-difference' });
            else failures.push(entry);
        }
    }
    for (const relation of relations) {
        if (!parsed[relation.a] || !parsed[relation.b]) continue;
        try {
            if (relation.kind === 'equal') assert.deepEqual(parsed[relation.a], parsed[relation.b]);
            else parsed[relation.a].forEach((value, i) => {
                // Allow only the independently rounded half-cent error on each side.
                const discrepancy = Math.abs(Number(parsed[relation.b][i]) - relation.factor * Number(value));
                assert.ok(discrepancy <= (relation.factor + 1) * 0.005 + 1e-8, String(discrepancy));
            });
        } catch (error) {
            failures.push({ seed: SEED, relation, inputs: [vectors[relation.a], vectors[relation.b]], actual: [actual[relation.a], actual[relation.b]], message: error.message });
        }
    }
    console.log(JSON.stringify({ seed: SEED, browser: browserName, mainCases: mainCount, boundaryCases: blockingCount - mainCount,
        metamorphicRelations: relations.length, midpointCasesSkipped: skipped, skippedCases, familyCounts, diagnostics }, null, 2));
    assert.deepEqual(pageErrors, [], 'uncaught page errors');
    assert.deepEqual(failures, [], `seed=${SEED}; bounded independent rational differential/property batch`);
} finally {
    await context.close();
    await browser.close();
}
