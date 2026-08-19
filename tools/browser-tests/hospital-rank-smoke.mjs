import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const rankings = JSON.parse(await readFile(new URL('../hospital_rank/data/rankings.json', import.meta.url), 'utf8'));
assert.equal(rankings.schemaVersion, 1, 'normalized ranking schema should be v1');
assert.equal(rankings.hospitals.length, 128, 'migration should contain 128 hospital entities');
assert.equal(rankings.years.reduce((sum, year) => sum + year.records.length, 0), 1430, 'all 2009–2023 records should be present');
assert.equal(rankings.years.find(year => year.year === 2011)?.records.length, 100, '2011 missing legacy year should be recovered');
const xijing = rankings.hospitals.find(hospital => /西京医院|第一附属医院/.test(hospital.name) && hospital.aliases.includes('第四军医大学西京医院'));
assert.ok(xijing, 'original 2011 published hospital name should be preserved as an alias');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

const noJsContext = await browser.newContext({ viewport: { width: 1365, height: 900 }, javaScriptEnabled: false });
try {
    const staticPage = await noJsContext.newPage();
    await staticPage.goto(`${baseUrl}/tools/hospital_rank/`, { waitUntil: 'domcontentloaded' });
    const staticRows = staticPage.locator('#hospitalList tr.data-row[data-static-prerendered="true"]');
    assert.equal(await staticRows.count(), 100, 'static HTML should contain the complete latest-year ranking before JavaScript runs');
    assert.match(await staticPage.locator('#workspaceTitle').innerText(), /2023 年医院榜单/);
    assert.match(await staticPage.locator('#resultSummary').innerText(), /共 100 家医院/);
    assert.equal(await staticPage.locator('#yearSelect').inputValue(), '2023', 'static HTML should preselect the latest year');
    assert.match(await staticRows.first().locator('.hospital-name').innerText(), /北京协和医院/, 'static HTML order should match the historical-reference sort');
    assert.match(await staticPage.locator('noscript').innerText(), /最新年度静态榜单/);
} finally {
    await noJsContext.close();
}

const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error));
await page.route('**/googletagmanager.com/**', route => route.abort());

try {
    await page.goto(`${baseUrl}/tools/hospital_rank/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#hospitalList tr.data-row');

    assert.equal(await page.locator('script[src*="echarts"]').count(), 0, 'ECharts should stay removed');
    assert.equal(await page.locator('script[src$="data.js"]').count(), 0, 'legacy data.js should stay removed');
    assert.equal(await page.locator('.overview').count(), 0, 'duplicated top ranking explanation should be removed');
    assert.match(await page.locator('#dataStatus').innerText(), /已结构化核验/);

    assert.equal(await page.locator('#yearSelect').inputValue(), '2023', 'latest year should be selected by default');
    let rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 100, 'default view should render only the latest 100 hospitals');
    assert.match(await page.locator('#workspaceTitle').innerText(), /2023 年医院榜单/);
    assert.match(await page.locator('#resultSummary').innerText(), /共 100 家医院/);
    assert.match(await page.locator('#rankingModeNote').innerText(), /最近一次可用数字排名/);
    assert.match(await page.locator('#rankingModeNote').innerText(), /2022 年/);

    const yearHeaderDisplay = await page.locator('#hospitalTable th').nth(0).evaluate(element => getComputedStyle(element).display);
    assert.equal(yearHeaderDisplay, 'none', 'single-year view should hide the repeated year column');
    const scoreHeaderDisplay = await page.locator('#hospitalTable th').nth(3).evaluate(element => getComputedStyle(element).display);
    assert.equal(scoreHeaderDisplay, 'none', 'score columns should be hidden for grade-only years');

    const firstRow = rows.first();
    assert.equal((await firstRow.locator('td').nth(1).innerText()).trim(), 'A++++', '2023 should render official grade values');
    assert.match(await firstRow.locator('td').nth(2).innerText(), /北京协和医院/, 'same-grade display should use the nearest numeric ranking as historical reference');

    await firstRow.evaluate(element => { element.dataset.performanceSentinel = 'preserve-me'; });
    const firstHistoryButton = firstRow.locator('.hospital-history-button');
    await firstHistoryButton.click();
    await page.locator('#historyDialog').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#hospitalList tr.data-row').first().getAttribute('data-performance-sentinel'), 'preserve-me', 'opening history must not rebuild the ranking table');

    const historyText = await page.locator('#historyDialog').innerText();
    assert.match(historyText, /历年排名/);
    assert.match(historyText, /2023年/);
    assert.match(historyText, /2022年/);
    assert.match(historyText, /同等级内的先后顺序使用最近一次可用数字排名/);

    await page.locator('#historyDialogClose').click();
    await page.locator('#historyDialog').waitFor({ state: 'hidden' });
    assert.equal(await firstHistoryButton.evaluate(element => element === document.activeElement), true, 'dialog close should restore focus to the hospital trigger');

    await page.locator('#yearSelect').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('#hospitalList tr.data-row').length === 100);
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 100, 'all-years mode should be paginated to 100 rows');
    assert.match(await page.locator('#resultSummary').innerText(), /1430 条历年记录/);
    assert.equal(await page.locator('#pagination').isVisible(), true, 'pagination should appear for all-years mode');
    assert.match(await page.locator('#paginationStatus').innerText(), /第 1 \/ 15 页/);
    assert.equal((await rows.first().locator('td').nth(0).innerText()).trim(), '2023');
    const allYearsHeaderDisplay = await page.locator('#hospitalTable th').nth(0).evaluate(element => getComputedStyle(element).display);
    assert.notEqual(allYearsHeaderDisplay, 'none', 'all-years view should restore the year column');

    await page.locator('#nextPage').click();
    await page.waitForFunction(() => document.querySelector('#paginationStatus')?.textContent.includes('第 2 / 15 页'));
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 100);
    assert.equal((await rows.first().locator('td').nth(0).innerText()).trim(), '2022', 'second all-years page should continue with the previous year');

    await page.locator('#yearSelect').selectOption('2011');
    await page.locator('#hospitalSearch').fill('天津市眼科医院');
    await page.waitForTimeout(220);
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 1, 'source-only 2011 hospital should be searchable');
    assert.equal((await rows.first().locator('td').nth(1).innerText()).trim(), '98');
    assert.match(await rows.first().innerText(), /天津市眼科医院/);

    await page.locator('#yearSelect').selectOption('');
    await page.locator('#hospitalSearch').fill('第四军医大学西京医院');
    await page.waitForTimeout(220);
    rows = page.locator('#hospitalList tr.data-row');
    assert.ok(await rows.count() > 1, 'confirmed historical name should resolve to the same hospital history');
    await rows.first().locator('.hospital-history-button').click();
    await page.locator('#historyDialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#historyDialog').innerText(), /历史名称\/别名/);
    assert.match(await page.locator('#historyDialog').innerText(), /第四军医大学西京医院/);
    await page.locator('#historyDialogClose').click();

    await page.locator('#hospitalSearch').fill('复旦大学附属儿科医院');
    await page.locator('#yearSelect').selectOption('2014');
    await page.waitForTimeout(220);
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 1, 'known 2014 source anomaly hospital should be searchable');
    await rows.first().locator('.hospital-history-button').click();
    await page.locator('#historyDialog').waitFor({ state: 'visible' });
    const anomalyText = await page.locator('#historyDialog').innerText();
    assert.match(anomalyText, /来源数据备注/);
    assert.match(anomalyText, /14\.799/);
    assert.match(anomalyText, /保留来源展示值/);
    await page.locator('#historyDialogClose').click();

    const bottomNotice = await page.locator('.data-disclaimer').innerText();
    assert.match(bottomNotice, /最近一次可用的数字排名/);
    assert.match(bottomNotice, /不代表官方档内名次/);
    assert.match(bottomNotice, /历史名称/);

    assert.deepEqual(pageErrors.map(error => error.message), [], 'page should not emit runtime errors');
} finally {
    await context.close();
    await browser.close();
}
