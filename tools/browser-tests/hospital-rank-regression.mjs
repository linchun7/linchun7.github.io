import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const type = { chromium, firefox, webkit }[name];
if (!type) throw new Error(`Unsupported browser: ${name}`);
const base = process.env.BASE_URL || 'http://127.0.0.1:4173';
const url = `${base}/tools/hospital_rank/`;
const data = JSON.parse(await readFile(new URL('../hospital_rank/data/rankings.json', import.meta.url), 'utf8'));
const latest = [...data.years].sort((a, b) => b.year - a.year)[0];
const controls = '#yearSelect, #provinceSelect, #citySelect, #hospitalSearch, #hospitalTable thead button[data-sort]';
const browser = await type.launch({ headless: true });
const cases = [
    ['empty-years', d => { d.years = []; }],
    ['empty-registry', d => { d.hospitals = []; }],
    ['fractional-year', d => { d.years[0].year += 0.5; }],
    ['duplicate-year', d => { d.years.push(d.years[0]); }],
    ['schema-type', d => { d.schemaVersion = true; }],
    ['zero-rank', d => { d.years[0].records[0].rank = 0; }],
    ['boolean-rank', d => { d.years[0].records[0].rank = true; }],
    ['negative-score', d => { d.years[0].records[0].overallScore = -1; }],
    ['null-score', d => { d.years[0].records[0].overallScore = null; }],
    ['string-score', d => { d.years[0].records[0].overallScore = '80'; }],
    ['grade-order', d => { d.rankingModes.grade.grades.reverse(); }],
    ['grade-score', d => { d.years.find(b => b.rankingMode === 'grade').records[0].overallScore = 99; }],
    ['unknown-hospital', d => { d.years[0].records[0].hospitalId = 'h_0000000000'; }],
    ['duplicate-record', d => { d.years[0].records[1] = d.years[0].records[0]; }],
    ['invalid-aliases', d => { d.hospitals[0].aliases = '错误类型'; }],
    ['invalid-location', d => { d.hospitals[0].province = null; }],
    ['unknown-source-name', d => { d.years[0].records[0].sourceName = '未登记院名'; }],
];
async function context(options = {}) {
    const ctx = await browser.newContext(options);
    await ctx.route('**/googletagmanager.com/**', route => route.abort());
    await ctx.route('**/google-analytics.com/**', route => route.abort());
    return ctx;
}
async function assertDisabled(page) {
    assert.equal(await page.locator(controls).count(), 12);
    assert.equal(await page.locator(controls).evaluateAll(nodes => nodes.every(node => node.disabled)), true);
}
async function assertFallback(page, label) {
    await page.waitForFunction(() => document.querySelector('#dataStatus').textContent.includes('交互加载失败'));
    assert.equal(await page.locator('[data-static-prerendered="true"]').count(), latest.records.length, label);
    assert.equal(await page.locator('.hospital-history-button').count(), 0, label);
    await assertDisabled(page);
}
try {
    const staticContext = await context({ javaScriptEnabled: false });
    try {
        const page = await staticContext.newPage();
        await page.goto(url);
        await assertDisabled(page);
        assert.equal(await page.locator('#yearSelect').inputValue(), String(latest.year));
    } finally { await staticContext.close(); }

    const ctx = await context({ viewport: { width: 390, height: 844 } });
    try {
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.waitForSelector('.hospital-history-button');
        assert.equal(await page.locator(controls).evaluateAll(nodes => nodes.every(node => !node.disabled)), true);
        for (const [year, columns] of [['2023', 4], ['2022', 7], ['', 8]]) {
            await page.locator('#yearSelect').selectOption(year);
            await page.locator('#hospitalSearch').fill('不存在的医院__回归测试__');
            await page.locator('.empty-message').waitFor({ state: 'visible' });
            assert.equal(await page.locator('.empty-message').evaluate(node => node.colSpan), columns);
            assert.match(await page.locator('.empty-message').innerText(), /没有找到/);
            await page.locator('#hospitalSearch').fill('');
            await page.waitForSelector('.hospital-history-button');
        }
        await page.locator('#hospitalSearch').fill('中山大学附属第二医院');
        const aliasHistoryCount = data.years.flatMap(block => block.records).filter(row => row.hospitalId === 'h_9da51a15c9').length;
        await page.waitForFunction(count => document.querySelectorAll('#hospitalList tr.data-row').length === count, aliasHistoryCount);
        await page.locator('.hospital-history-button').first().click();
        await page.locator('#historyDialog').waitFor({ state: 'visible' });
        assert.match(await page.locator('#historyDialogTitle').innerText(), /孙逸仙纪念医院/);
        assert.match(await page.locator('#historyDialog').innerText(), /2010年/);
        assert.match(await page.locator('#historyDialog').innerText(), /中山大学附属第二医院/);
        await page.keyboard.press('Escape');
        await page.locator('#historyDialog').waitFor({ state: 'hidden' });
        await page.locator('#hospitalSearch').fill('上海市儿童医院');
        const gapHospital = data.hospitals.find(hospital => hospital.name === '上海市儿童医院');
        const gapCount = data.years.flatMap(block => block.records).filter(row => row.hospitalId === gapHospital.id).length;
        await page.waitForFunction(count => document.querySelectorAll('#hospitalList tr.data-row').length === count, gapCount);
        await page.locator('.hospital-history-button').first().click();
        await page.locator('#historyDialog').waitFor({ state: 'visible' });
        assert.match(await page.locator('#historyDialog').innerText(), /较 2013 年，非同比/);
        await page.keyboard.press('Escape');
        await page.locator('#historyDialog').waitFor({ state: 'hidden' });
        await page.locator('#hospitalSearch').fill('');
        await page.locator('#yearSelect').selectOption('2023');
        await page.locator('#provinceSelect').selectOption('广东省');
        await page.locator('#citySelect').selectOption('广州市');
        const ids = new Set(data.hospitals.filter(h => h.city === '广州市' && h.province === '广东省').map(h => h.id));
        const expected = data.years.find(b => b.year === 2023).records.filter(r => ids.has(r.hospitalId)).length;
        await page.waitForFunction(n => document.querySelectorAll('#hospitalList tr.data-row').length === n, expected);
        assert.equal(await page.locator('#hospitalList tr.data-row').count(), expected);
        assert.deepEqual(errors, []);
    } finally { await ctx.close(); }

    for (const [label, mutate] of cases) {
        const ctx = await context();
        try {
            const fixture = structuredClone(data);
            mutate(fixture);
            await ctx.route('**/tools/hospital_rank/data/rankings.json*', route => route.fulfill({ json: fixture }));
            const page = await ctx.newPage();
            await page.goto(url);
            await assertFallback(page, label);
        } finally { await ctx.close(); }
    }
    // HTTP/body failures and errors without any prerendered rows must stay visible.
    for (const mode of ['http-error', 'invalid-json', 'no-static-rows', 'body-timeout']) {
        const ctx = await context();
        try {
            if (mode === 'body-timeout') {
                await ctx.addInitScript(() => {
                    const timeout = window.setTimeout.bind(window);
                    window.setTimeout = (fn, delay, ...args) => timeout(fn, delay === 15000 ? 30 : delay, ...args);
                    window.fetch = (_url, options) => Promise.resolve({ ok: true,
                        json: () => new Promise((_resolve, reject) => options.signal.addEventListener('abort',
                            () => reject(new DOMException('Aborted', 'AbortError')), { once: true })) });
                });
            } else {
                await ctx.route('**/tools/hospital_rank/data/rankings.json*', route => route.fulfill({
                    status: mode === 'http-error' ? 503 : 200, contentType: 'application/json', body: '{'
                }));
            }
            if (mode === 'no-static-rows') {
                await ctx.addInitScript(() => document.addEventListener('DOMContentLoaded',
                    () => document.querySelector('#hospitalList').replaceChildren(), { once: true }));
            }
            const page = await ctx.newPage();
            await page.goto(url);
            if (mode === 'no-static-rows') {
                await page.locator('.error-message').waitFor({ state: 'visible' });
                await assertDisabled(page);
            } else await assertFallback(page, mode);
        } finally { await ctx.close(); }
    }
    // Content must be text, not interpreted as HTML, in rows and history.
    const literalContext = await context();
    try {
        const fixture = structuredClone(data);
        const hospital = fixture.hospitals[0];
        const literal = '<b data-review-probe>测试医院</b>';
        hospital.name = literal;
        for (const block of fixture.years) for (const row of block.records) {
            if (row.hospitalId === hospital.id) row.sourceName = literal;
        }
        await literalContext.route('**/tools/hospital_rank/data/rankings.json*', route => route.fulfill({ json: fixture }));
        const page = await literalContext.newPage();
        await page.goto(url);
        await page.waitForSelector('.hospital-history-button');
        await page.locator('#yearSelect').selectOption('');
        await page.locator('#hospitalSearch').fill('测试医院');
        await page.waitForFunction(text => document.querySelector('.hospital-history-button')?.textContent === text, literal);
        assert.equal(await page.locator('[data-review-probe]').count(), 0);
        await page.locator('.hospital-history-button').first().click();
        assert.match(await page.locator('#historyDialogTitle').innerText(), /<b data-review-probe>/);
        assert.equal(await page.locator('[data-review-probe]').count(), 0);
    } finally { await literalContext.close(); }
    console.log(JSON.stringify({ status: 'ok', browser: name, invalidPayloads: cases.length,
        errorPaths: 4, emptyViews: 3, aliasHistory: true, historyGap: true, literalText: true }));
} finally {
    await browser.close();
}
