import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const renderStaticScript = fileURLToPath(new URL('../hospital_rank/scripts/render_static.py', import.meta.url));
execFileSync('python3', [renderStaticScript, '--check'], { stdio: 'inherit' });

const rankings = JSON.parse(await readFile(new URL('../hospital_rank/data/rankings.json', import.meta.url), 'utf8'));
assert.equal(rankings.schemaVersion, 1, 'normalized ranking schema should be v1');
assert.equal(rankings.hospitals.length, 128, 'migration should contain 128 hospital entities');
assert.equal(rankings.years.reduce((sum, year) => sum + year.records.length, 0), 1430, 'all 2009–2023 records should be present');
assert.equal(rankings.years.find(year => year.year === 2011)?.records.length, 100, '2011 missing legacy year should be recovered');
const latestYearBlock = [...rankings.years].sort((a, b) => Number(b.year) - Number(a.year))[0];
const latestYear = Number(latestYearBlock.year);
const xijing = rankings.hospitals.find(hospital => /西京医院|第一附属医院/.test(hospital.name) && hospital.aliases.includes('第四军医大学西京医院'));
assert.ok(xijing, 'original 2011 published hospital name should be preserved as an alias');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

const noJsContext = await browser.newContext({ viewport: { width: 1365, height: 900 }, javaScriptEnabled: false });
try {
    const staticPage = await noJsContext.newPage();
    await staticPage.goto(`${baseUrl}/tools/hospital_rank/`, { waitUntil: 'domcontentloaded' });
    const staticRows = staticPage.locator('#hospitalList tr.data-row[data-static-prerendered="true"]');
    assert.equal(await staticRows.count(), latestYearBlock.records.length, 'static HTML should contain the complete latest-year ranking before JavaScript runs');
    assert.match(await staticPage.locator('#workspaceTitle').textContent(), new RegExp(`${latestYear} 年医院榜单`));
    assert.match(await staticPage.locator('#resultSummary').textContent(), new RegExp(`共 ${latestYearBlock.records.length} 家医院`));
    assert.equal(await staticPage.locator('#yearSelect').inputValue(), String(latestYear), 'static HTML should preselect the latest year from rankings.json');
    assert.equal(await staticRows.first().getAttribute('data-year'), String(latestYear), 'static HTML rows should come from the latest year in rankings.json');
    assert.match(await staticPage.locator('noscript').innerText(), /最新年度静态榜单/);
} finally {
    await noJsContext.close();
}

const failureContext = await browser.newContext({ viewport: { width: 1365, height: 900 } });
try {
    const failurePage = await failureContext.newPage();
    await failurePage.route('**/googletagmanager.com/**', route => route.abort());
    await failurePage.route('**/tools/hospital_rank/data/rankings.json', route => route.abort());
    await failurePage.goto(`${baseUrl}/tools/hospital_rank/`, { waitUntil: 'domcontentloaded' });
    await failurePage.waitForFunction(() => document.querySelector('#dataStatus')?.textContent.includes('交互加载失败'));
    const fallbackRows = failurePage.locator('#hospitalList tr.data-row[data-static-prerendered="true"]');
    assert.equal(await fallbackRows.count(), latestYearBlock.records.length, 'failed interactive data load should preserve the static latest-year ranking');
    assert.match(await failurePage.locator('#dataStatus').innerText(), /已显示静态最新榜单/);
    assert.equal(await failurePage.locator('#yearSelect').isDisabled(), true, 'failed interactive data load should disable inactive filters');
    assert.equal(await fallbackRows.first().locator('.hospital-history-button').isDisabled(), true, 'static fallback should not expose a dead history action');
} finally {
    await failureContext.close();
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
    assert.equal((await page.locator('#dataStatus').innerText()).trim(), `最新数据 ${latestYear} 年`, 'latest-data status should stay concise');
    assert.doesNotMatch(await page.locator('#dataStatus').innerText(), /已结构化核验/);

    assert.equal(await page.locator('#yearSelect').inputValue(), String(latestYear), 'latest year should be selected by default');
    let rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), latestYearBlock.records.length, 'default view should render the complete latest-year ranking');
    assert.equal((await page.locator('#workspaceTitle').innerText()).trim(), `${latestYear} 年医院榜单 · 共 ${latestYearBlock.records.length} 家医院`);
    assert.equal(await page.locator('#resultSummary').evaluate(element => getComputedStyle(element).display), 'none', 'duplicate result summary should stay visually hidden');
    assert.equal(await page.locator('#rankingModeNote').evaluate(element => getComputedStyle(element).display), 'none', 'grade methodology must not occupy toolbar height');
    assert.equal((await page.locator('#rankColumnLabel').innerText()).trim(), latestYearBlock.rankingMode === 'grade' ? '等级' : '排名', 'latest-year result label should match its ranking mode');
    assert.equal((await page.locator('#provinceSelect option').first().innerText()).trim(), '省份', 'province filter should use concise placeholder');

    const headingBox = await page.locator('.workspace-heading').boundingBox();
    const filtersBox = await page.locator('.filters').boundingBox();
    assert.ok(headingBox && filtersBox, 'toolbar heading and filters should be measurable');
    const headingCenterY = headingBox.y + headingBox.height / 2;
    const filtersCenterY = filtersBox.y + filtersBox.height / 2;
    assert.ok(Math.abs(headingCenterY - filtersCenterY) <= 2, `toolbar heading should be vertically centered with filters, delta=${Math.abs(headingCenterY - filtersCenterY)}`);

    await page.waitForSelector('#hospitalTable thead button[data-sort="医院名称"] svg.lucide-arrow-up-down');
    const unsortedIconClass = await page.locator('#hospitalTable thead button[data-sort="医院名称"] svg').getAttribute('class');
    assert.match(unsortedIconClass || '', /lucide-arrow-up-down/, 'unsorted header should use the shared iCloud Lucide arrow-up-down icon');

    await page.locator('#yearSelect').selectOption('2023');
    await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2023 年医院榜单'));
    const yearHeaderDisplay = await page.locator('#hospitalTable th').nth(0).evaluate(element => getComputedStyle(element).display);
    assert.equal(yearHeaderDisplay, 'none', 'single-year view should hide the repeated year column');
    const scoreHeaderDisplay = await page.locator('#hospitalTable th').nth(3).evaluate(element => getComputedStyle(element).display);
    assert.equal(scoreHeaderDisplay, 'none', 'score columns should be hidden for grade-only years');

    const gradeToolbarHeight = await page.locator('.workspace-toolbar').evaluate(element => element.getBoundingClientRect().height);
    await page.locator('#yearSelect').selectOption('2022');
    await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2022 年医院榜单'));
    assert.equal((await page.locator('#rankColumnLabel').innerText()).trim(), '排名', 'numeric year should label the result column as 排名');
    assert.equal((await page.locator('#workspaceTitle').innerText()).trim(), '2022 年医院榜单 · 共 100 家医院');
    const numericToolbarHeight = await page.locator('.workspace-toolbar').evaluate(element => element.getBoundingClientRect().height);
    assert.ok(Math.abs(gradeToolbarHeight - numericToolbarHeight) <= 1, 'switching grade/numeric years must not change toolbar height');

    await page.locator('#yearSelect').selectOption('2023');
    await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2023 年医院榜单'));
    rows = page.locator('#hospitalList tr.data-row');
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
    assert.doesNotMatch(historyText, /同等级内/, 'hospital detail should not repeat global grade-ordering methodology');

    await page.locator('#historyDialogClose').click();
    await page.locator('#historyDialog').waitFor({ state: 'hidden' });
    assert.equal(await firstHistoryButton.evaluate(element => element === document.activeElement), true, 'dialog close should restore focus to the hospital trigger');

    const rankSortButton = page.locator('#hospitalTable thead button[data-sort="排名"]');
    await rankSortButton.click();
    await page.waitForSelector('#hospitalTable thead button[data-sort="排名"] svg.lucide-arrow-up');
    assert.equal(await rankSortButton.locator('svg.lucide-arrow-up').count(), 1, 'ascending sort should use iCloud Lucide arrow-up');
    await rankSortButton.click();
    await page.waitForSelector('#hospitalTable thead button[data-sort="排名"] svg.lucide-arrow-down');
    assert.equal(await rankSortButton.locator('svg.lucide-arrow-down').count(), 1, 'descending sort should use iCloud Lucide arrow-down');

    await page.locator('#yearSelect').selectOption('');
    await page.waitForFunction(() => document.querySelectorAll('#hospitalList tr.data-row').length === 100);
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 100, 'all-years mode should be paginated to 100 rows');
    assert.match(await page.locator('#workspaceTitle').innerText(), /历年医院榜单 · 共 1430 条记录 · 128 家医院/);
    assert.equal((await page.locator('#rankColumnLabel').innerText()).trim(), '排名 / 等级', 'mixed all-years view should explicitly cover both ranking systems');
    assert.equal(await page.locator('#pagination').isVisible(), true, 'pagination should appear for all-years mode');
    assert.match(await page.locator('#paginationStatus').innerText(), /第 1 \/ 15 页/);
    assert.equal((await rows.first().locator('td').nth(0).innerText()).trim(), String(latestYear));
    const allYearsHeaderDisplay = await page.locator('#hospitalTable th').nth(0).evaluate(element => getComputedStyle(element).display);
    assert.notEqual(allYearsHeaderDisplay, 'none', 'all-years view should restore the year column');

    await page.locator('#nextPage').click();
    await page.waitForFunction(() => document.querySelector('#paginationStatus')?.textContent.includes('第 2 / 15 页'));
    rows = page.locator('#hospitalList tr.data-row');
    assert.equal(await rows.count(), 100);

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

    await page.locator('#hospitalSearch').fill('');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#yearSelect').selectOption('2023');
    await page.waitForFunction(() => document.querySelector('#hospitalTable')?.classList.contains('grade-mode'));
    const tableOverflow = await page.locator('.table-scroll').evaluate(element => element.scrollWidth - element.clientWidth);
    assert.ok(tableOverflow <= 1, `single-year grade table should fit a 390px viewport, overflow=${tableOverflow}`);
    const cityHeaderBox = await page.locator('#hospitalTable th').nth(7).boundingBox();
    const scrollBox = await page.locator('.table-scroll').boundingBox();
    assert.ok(cityHeaderBox && scrollBox && cityHeaderBox.x + cityHeaderBox.width <= scrollBox.x + scrollBox.width + 1, 'city column should stay visible on narrow phones');
    const firstMobileRow = page.locator('#hospitalList tr.data-row').first();
    assert.match(await firstMobileRow.locator('td').nth(6).innerText(), /市|省|区/);
    assert.match(await firstMobileRow.locator('td').nth(7).innerText(), /市|州|区|县/);

    const bottomNotice = await page.locator('.data-disclaimer').innerText();
    assert.match(bottomNotice, /最近一次可用的数字排名/);
    assert.match(bottomNotice, /不代表官方档内名次/);
    assert.match(bottomNotice, /历史名称/);

    assert.deepEqual(pageErrors.map(error => error.message), [], 'page should not emit runtime errors');
} finally {
    await context.close();
    await browser.close();
}
