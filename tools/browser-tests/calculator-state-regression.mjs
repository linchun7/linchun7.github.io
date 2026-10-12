import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, 'Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
let passed = 0;

// Each check owns a new page and reports independently, so one red regression
// cannot hide the other calculators or the CSV boundary.
async function check(name, tool, run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route('**/googletagmanager.com/**', route => route.abort());
    try {
        await page.goto(baseUrl + '/tools/' + tool + '/', { waitUntil: 'domcontentloaded' });
        await run(page);
        assert.deepEqual(pageErrors, [], name + ': no uncaught errors');
        passed++;
        console.log('PASS ' + name);
    } catch (error) {
        failures.push({ name, message: error.message });
        console.error('FAIL ' + name + ': ' + error.stack);
    } finally {
        await context.close();
    }
}

async function establishRenovation(page) {
    await page.fill('#loanAmount', '100000');
    await page.fill('#loanTerm', '12');
    await page.fill('#serviceFee', '0.5');
    await page.click('#calculateBtn');
    assert.equal(await page.locator('.export-btn').count(), 1);
    assert.equal(await page.evaluate(() => window.lastExportData.totals.totalPrincipal), 100000);
}

async function assertRenovationInvalidated(page) {
    assert.equal(await page.locator('.export-btn, .export-link').count(), 0, 'old export controls must disappear');
    assert.equal(await page.evaluate(() => window.lastExportData == null), true, 'old export payload must be cleared');
    assert.match(await page.locator('#result').textContent(), /重新计算/);
}

const financialCases = [
    { tab: 1, fields: { principal1: '1000', days1: '360', interest1: '50' },
      selects: { rateType1: '360' },
      changes: [['principal1', '2000'], ['days1', '180'], ['interest1', '25'], ['rateType1', '365', 'select']] },
    { tab: 2, fields: { principal2: '1000', days2: '360', annualRate2: '5' },
      selects: { rateType2: '360' },
      changes: [['principal2', '2000'], ['days2', '180'], ['annualRate2', '10'], ['rateType2', '365', 'select']] },
    { tab: 3, fields: { startDate: '2026-01-01', endDate: '2027-01-01', startNetValue: '1', endNetValue: '1.1' },
      selects: { rateType3: '365' },
      changes: [['startDate', '2026-02-01'], ['endDate', '2027-02-01'], ['startNetValue', '2'], ['endNetValue', '1.2'], ['rateType3', '360', 'select']] },
    { tab: 4, fields: { principal3: '1000', depositPeriod: '2', annualRate3: '5' },
      selects: { compoundingFrequency: 'annually', rateType4: '360' },
      changes: [['principal3', '2000'], ['depositPeriod', '3'], ['annualRate3', '10'], ['compoundingFrequency', 'monthly', 'select'], ['rateType4', '365', 'select']] }
];

try {
    for (const item of financialCases) {
        for (const [id, value, kind] of item.changes) {
            await check('financial invalidates changed ' + id, 'financial_calculator', async page => {
                await page.click('#tab' + item.tab);
                for (const [field, initial] of Object.entries(item.fields)) await page.fill('#' + field, initial);
                for (const [field, initial] of Object.entries(item.selects)) await page.selectOption('#' + field, initial);
                await page.click('#calculate' + item.tab);
                assert.equal(await page.locator('#result' + item.tab).evaluate(el => el.classList.contains('result-success')), true);
                if (item.tab === 4) assert.equal(await page.locator('#result4-table tbody tr').count(), 2);
                if (kind === 'select') await page.selectOption('#' + id, value);
                else await page.fill('#' + id, value);
                assert.equal((await page.locator('#result' + item.tab).textContent()).trim(), '', 'old summary must not survive the edit');
                if (item.tab === 4) assert.equal(await page.locator('#result4-table').evaluate(el => el.childElementCount), 0);
                await page.click('#calculate' + item.tab);
                assert.equal(await page.locator('#result' + item.tab).evaluate(el => el.classList.contains('result-success')), true, 'calculation recovers after editing');
                if (id === 'compoundingFrequency') assert.match(await page.locator('#result4').textContent(), /1,008\.35/);
            });
        }
    }

    await check('financial editing one panel preserves another panel result', 'financial_calculator', async page => {
        await page.fill('#principal1', '1000');
        await page.fill('#days1', '360');
        await page.fill('#interest1', '50');
        await page.selectOption('#rateType1', '360');
        await page.click('#calculate1');
        const original = await page.locator('#result1').textContent();
        await page.click('#tab2');
        await page.fill('#principal2', '2000');
        assert.equal(await page.locator('#result1').textContent(), original);
    });

    for (const [id, value] of [['loanAmount', '200000'], ['loanTerm', '60'], ['serviceFee', '0.18']]) {
        await check('renovation manual ' + id + ' invalidates export', 'renovation_calculator', async page => {
            await establishRenovation(page);
            await page.fill('#' + id, value);
            await assertRenovationInvalidated(page);
            await page.click('#calculateBtn');
            assert.equal(await page.locator('.export-btn').count(), 1);
            const principal = id === 'loanAmount' ? 200000 : 100000;
            assert.equal(await page.evaluate(() => window.lastExportData.totals.totalPrincipal), principal);
        });
    }

    for (const selector of ['.quick-amount[data-value="50000"]', '.quick-term[data-value="60"]', '.quick-fee[data-value="0.18"]']) {
        await check('renovation quick selection invalidates export ' + selector, 'renovation_calculator', async page => {
            await establishRenovation(page);
            await page.click(selector);
            await assertRenovationInvalidated(page);
            await page.click('#calculateBtn');
            assert.equal(await page.locator('.export-btn').count(), 1);
        });
    }

    await check('renovation failed calculation clears export payload and recovers', 'renovation_calculator', async page => {
        await establishRenovation(page);
        // Also cover a programmatic update with no input event: the calculation
        // entry point itself must discard its previous successful payload.
        await page.evaluate(() => { document.getElementById('loanTerm').value = '0'; });
        await page.click('#calculateBtn');
        assert.equal(await page.evaluate(() => window.lastExportData == null), true);
        assert.equal(await page.locator('.export-btn, .export-link').count(), 0);
        assert.match(await page.locator('#loanTermError').textContent(), /1-600/);
        await page.fill('#loanTerm', '12');
        await page.click('#calculateBtn');
        assert.equal(await page.locator('.export-btn').count(), 1);
        assert.equal(await page.evaluate(() => window.lastExportData.schedule.length), 12);
    });

    await check('renovation fee on zero opening principal is unavailable in table and CSV', 'renovation_calculator', async page => {
        await page.fill('#loanAmount', '0.01');
        await page.fill('#loanTerm', '2');
        await page.fill('#serviceFee', '100');
        await page.click('#calculateBtn');
        const row = await page.evaluate(() => window.lastExportData.schedule[1]);
        assert.equal(row.serviceFee, 0.01);
        assert.equal(row.principal, 0);
        assert.equal(row.remainingPrincipal, 0);
        assert.equal(row.annualizedFeeRate, null, 'a fee divided by zero must not become zero percent');
        assert.equal((await page.locator('tbody tr').nth(1).locator('td').nth(6).textContent()).trim(), '—');

        await page.evaluate(() => {
            const nativeCreate = URL.createObjectURL.bind(URL);
            URL.createObjectURL = blob => { window.__feeBoundaryCSV = blob; return nativeCreate(blob); };
            HTMLAnchorElement.prototype.click = () => {};
        });
        await page.click('.export-btn');
        const csv = await page.evaluate(async () => window.__feeBoundaryCSV.text());
        const secondRow = csv.replace(/^\uFEFF/, '').trimEnd().split('\n')[2];
        assert.match(secondRow, /^2,"¥0\.01","¥0\.00","¥0\.01","¥0\.00","¥0\.01","—",/);
        assert.doesNotMatch(csv, /NaN|Infinity|null|—%/);

        await page.fill('#serviceFee', '0');
        await page.click('#calculateBtn');
        assert.equal(await page.evaluate(() => window.lastExportData.schedule[1].annualizedFeeRate), 0);
        assert.equal((await page.locator('tbody tr').nth(1).locator('td').nth(6).textContent()).trim(), '0.00%');
    });

    console.log(JSON.stringify({ browser: browserName, passed, failed: failures.length, failures }, null, 2));
    assert.deepEqual(failures, [], 'calculator stale-result and zero-principal regressions');
} finally {
    await browser.close();
}
