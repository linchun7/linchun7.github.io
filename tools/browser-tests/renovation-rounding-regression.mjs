import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));
await page.route('**/googletagmanager.com/**', route => route.abort());

// Independent reference: integer-cent cumulative principal targets and direct
// discounted cash flows, rather than the application's rounding or Horner NPV.
function referenceRows(loanCents, term, feeCents) {
    let paidCents = 0;
    return Array.from({ length: term }, (_, index) => {
        const month = index + 1;
        const targetCents = Math.floor((2 * loanCents * month + term) / (2 * term));
        const principalCents = targetCents - paidCents;
        const openingCents = loanCents - paidCents;
        paidCents = targetCents;
        return {
            month,
            payment: (principalCents + feeCents) / 100,
            principal: principalCents / 100,
            serviceFee: feeCents / 100,
            remainingPrincipal: (loanCents - paidCents) / 100,
            totalPaidPrincipal: paidCents / 100,
            annualizedFeeRate: openingCents > 0 ? feeCents * 1200 / openingCents : 0
        };
    });
}

function referenceAPR(cashFlows) {
    const valueAt = rate => cashFlows.reduce((sum, flow, index) => (
        sum + flow / Math.pow(1 + rate, index)
    ), 0);
    if (Math.abs(valueAt(0)) < 1e-10) return 0;
    let low = 0;
    let high = 1;
    while (valueAt(high) > 0) high *= 2;
    for (let index = 0; index < 120; index++) {
        const mid = (low + high) / 2;
        if (valueAt(mid) > 0) low = mid;
        else high = mid;
    }
    return (Math.pow(1 + (low + high) / 2, 12) - 1) * 100;
}

function assertClose(actual, expected, message) {
    const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-8);
    assert.ok(Math.abs(actual - expected) <= tolerance, message + ': ' + actual + ' vs ' + expected);
}

const money = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

// feeCents are explicit decimal half-up expectations, independent of JS
// multiplication and of the implementation under test.
const cases = [
    { name: '2015 at 0.5% rounds half a cent up', amount: '2015', term: 12, rate: '0.5', loanCents: 201500, feeCents: 1008 },
    { name: 'ordinary value below half a cent stays down', amount: '2014.99', term: 12, rate: '0.5', loanCents: 201499, feeCents: 1007 },
    { name: 'rate genuinely just below the half-cent boundary stays down', amount: '2015', term: 12, rate: '0.4999999999999999', loanCents: 201500, feeCents: 1007 },
    { name: 'multiplication cannot erase a half-cent tie', amount: '1.13', term: 12, rate: '50', loanCents: 113, feeCents: 57 },
    { name: 'fractional amount and rate keep decimal half-up', amount: '0.29', term: 12, rate: '150', loanCents: 29, feeCents: 44 },
    { name: 'ordinary twelve-month loan is unchanged', amount: '100000', term: 12, rate: '0.5', loanCents: 10000000, feeCents: 50000 },
    { name: 'existing sub-cent amount normalization is retained', amount: '100000.001', term: 12, rate: '0', loanCents: 10000000, feeCents: 0 },
    { name: 'zero-fee tiny loan conserves principal', amount: '1', term: 60, rate: '0', loanCents: 100, feeCents: 0 },
    { name: 'input and cumulative principal half-cent ties round up', amount: '1.005', term: 2, rate: '0', loanCents: 101, feeCents: 0 },
    { name: 'scientific notation remains accepted', amount: '1e3', term: 12, rate: '1.5e-1', loanCents: 100000, feeCents: 150 }
];

try {
    await page.goto(baseUrl + '/tools/renovation_calculator/', { waitUntil: 'domcontentloaded' });
    const roundingCases = [
        [10.075, 10.08],
        [10.07499999999999, 10.07],
        [10.07500000000001, 10.08],
        [1.005, 1.01],
        [1.00499999999999, 1],
        [-1.005, -1.01],
        [-1.00499999999999, -1],
        [123456.78, 123456.78],
        [0, 0]
    ];
    const rounded = await page.evaluate(values => values.map(value => numberUtils.toFixed2(value)), roundingCases.map(([value]) => value));
    assert.deepEqual(rounded, roundingCases.map(([, expected]) => expected), 'decimal half-up must not use a broad epsilon');

    // Exercise the real export handler while keeping downloads inside this page.
    await page.evaluate(() => {
        const nativeCreate = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { window.__roundingCSVBlob = blob; return nativeCreate(blob); };
        HTMLAnchorElement.prototype.click = () => {};
    });

    for (const item of cases) {
        await page.fill('#loanAmount', item.amount);
        await page.fill('#loanTerm', String(item.term));
        await page.fill('#serviceFee', item.rate);
        await page.click('#calculateBtn');
        await page.waitForSelector('.summary-card');
        const result = await page.evaluate(() => window.lastExportData);
        const expectedRows = referenceRows(item.loanCents, item.term, item.feeCents);
        const expectedTotals = {
            totalPayment: (item.loanCents + item.feeCents * item.term) / 100,
            totalPrincipal: item.loanCents / 100,
            totalServiceFee: item.feeCents * item.term / 100
        };
        assert.equal(result.schedule.length, item.term, item.name);
        assert.deepEqual(result.totals, expectedTotals, item.name + ': exact totals');
        assert.deepEqual(
            result.schedule.map(({ earlyRepaymentAPR, annualizedFeeRate, ...row }) => row),
            expectedRows.map(({ annualizedFeeRate, ...row }) => row),
            item.name + ': every displayed cash-flow amount'
        );
        const expectedAPR = referenceAPR([-item.loanCents / 100, ...expectedRows.map(row => row.payment)]);
        assertClose(result.apr, expectedAPR, item.name + ': IRR follows corrected payments');
        for (let index = 0; index < expectedRows.length; index++) {
            const row = expectedRows[index];
            const earlyCashFlows = [
                -item.loanCents / 100,
                ...expectedRows.slice(0, index).map(previous => previous.payment),
                (Math.round(row.payment * 100) + Math.round(row.remainingPrincipal * 100)) / 100
            ];
            assertClose(result.schedule[index].earlyRepaymentAPR, referenceAPR(earlyCashFlows), item.name + ': early repayment IRR ' + row.month);
            assertClose(result.schedule[index].annualizedFeeRate, row.annualizedFeeRate, item.name + ': annualized fee ' + row.month);
        }
        assert.equal(await page.locator('tbody tr').count(), item.term + 1, item.name);
        const firstCells = await page.locator('tbody tr').first().locator('td').allTextContents();
        assert.equal(firstCells[1], '￥' + money.format(expectedRows[0].payment), item.name + ': rendered payment');
        assert.equal(firstCells[3], '￥' + money.format(expectedRows[0].serviceFee), item.name + ': rendered fee');
        const summaries = await page.locator('.summary-card').allTextContents();
        assert.ok(summaries[2].includes('￥' + money.format(expectedTotals.totalPayment)), item.name + ': rendered total');
        assert.ok(summaries[3].includes('￥' + money.format(expectedTotals.totalServiceFee)), item.name + ': rendered fee total');

        await page.click('.export-btn');
        const csv = await page.evaluate(async () => {
            const blob = window.__roundingCSVBlob;
            const bytes = new Uint8Array(await blob.arrayBuffer());
            return { prefix: Array.from(bytes.slice(0, 3)), text: new TextDecoder().decode(bytes.subarray(3)) };
        });
        assert.deepEqual(csv.prefix, [0xEF, 0xBB, 0xBF], 'CSV retains its UTF-8 BOM');
        const lines = csv.text.replace(/^\uFEFF/, '').trimEnd().split('\n');
        assert.equal(lines.length, item.term + 2, item.name + ': CSV row count');
        expectedRows.forEach((row, index) => {
            const prefix = [row.month, row.payment, row.principal, row.serviceFee, row.remainingPrincipal, row.totalPaidPrincipal]
                .map((value, column) => column === 0 ? String(value) : '"¥' + money.format(value) + '"')
                .join(',') + ',';
            assert.ok(lines[index + 1].startsWith(prefix), item.name + ': CSV money row ' + row.month);
        });
        assert.equal(
            lines.at(-1),
            '总计,"¥' + money.format(expectedTotals.totalPayment) + '","¥' + money.format(expectedTotals.totalPrincipal) + '","¥' + money.format(expectedTotals.totalServiceFee) + '",-,-,-,-',
            item.name + ': CSV totals'
        );
    }

    assert.deepEqual(pageErrors, [], 'no unhandled renovation calculator errors');
    console.log('renovation rounding regression passed (' + browserName + ')');
} finally {
    await context.close();
    await browser.close();
}
