import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const validateScript = fileURLToPath(new URL('../bank_rank/scripts/validate_data.py', import.meta.url));
const futureYearScript = fileURLToPath(new URL('../bank_rank/scripts/test_future_year.py', import.meta.url));
const renderStaticScript = fileURLToPath(new URL('../bank_rank/scripts/render_static.py', import.meta.url));
execFileSync('python3', [validateScript], { stdio: 'inherit' });
execFileSync('python3', [futureYearScript], { stdio: 'inherit' });
execFileSync('python3', [renderStaticScript, '--check'], { stdio: 'inherit' });

const manifest = JSON.parse(await readFile(new URL('../bank_rank/data/rankings.json', import.meta.url), 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'bank ranking schema should remain v1');
assert.ok(Array.isArray(manifest.years), 'bank ranking manifest should expose verified years');

const loadedYears = await Promise.all(manifest.years.map(async block => ({
  ...block,
  records: JSON.parse(await readFile(new URL(`../bank_rank/data/${block.recordsFile}`, import.meta.url), 'utf8'))
})));
for (const block of loadedYears) {
  assert.equal(block.records.length, 100, `${block.rankingYear} should contain exactly 100 banks`);
}
const years = loadedYears.map(block => Number(block.rankingYear));
assert.deepEqual(years, [...years].sort((a, b) => a - b), 'ranking years should remain sorted ascending');
for (let year = 2016; year <= 2025; year += 1) {
  assert.ok(years.includes(year), `verified historical baseline must retain ${year}`);
}
assert.ok(loadedYears.reduce((sum, block) => sum + block.records.length, 0) >= 1000, 'verified 2016–2025 baseline should retain at least 1000 records');
const latestYear = Math.max(...years);
const oldestYear = Math.min(...years);
const latestBlock = loadedYears.find(block => Number(block.rankingYear) === latestYear);

// Lock known source/transcription repairs and re-audit corrections.
const records2016 = JSON.parse(await readFile(new URL('../bank_rank/data/years/2016.json', import.meta.url), 'utf8'));
const tianjinRural2016 = records2016.find(record => record.sourceName === '天津农村商业银行');
assert.equal(tianjinRural2016?.netProfit, 26.35, '2016 Tianjin Rural Commercial Bank net profit must match its 2015 annual report');
const audit = JSON.parse(await readFile(new URL('../bank_rank/data/audit.json', import.meta.url), 'utf8'));
const tianjinAudit = audit.normalizations.find(item => item.rankingYear === 2016 && item.entity === '天津农村商业银行' && item.field === 'netProfit');
assert.equal(tianjinAudit?.evidenceUrl, 'https://www.trcbank.com.cn/ImgFiles/tzzgx/201604/2016042918291766558.pdf', '2016 Tianjin Rural correction must retain the official annual-report evidence URL');
assert.match(tianjinAudit?.evidenceLocation || '', /会计数据和业务数据摘要/, '2016 Tianjin Rural correction must retain an evidence location inside the annual report');

const records2021 = JSON.parse(await readFile(new URL('../bank_rank/data/years/2021.json', import.meta.url), 'utf8'));
const ccb2021 = records2021.find(record => record.sourceName === '中国建设银行');
const mengshang2021 = records2021.find(record => record.sourceName === '蒙商银行');
assert.equal(ccb2021?.assets, 281322.54, '2021 CCB assets must match the 2020 official financial highlights');
assert.equal(mengshang2021?.netProfit, -34.94, '2021 Mengshang Bank net profit must retain the verified loss sign');

const records2022 = JSON.parse(await readFile(new URL('../bank_rank/data/years/2022.json', import.meta.url), 'utf8'));
const suzhou2022 = records2022.find(record => record.sourceName === '苏州银行');
const shenzhenRural2022 = records2022.find(record => record.sourceName === '深圳农商银行');
assert.equal(suzhou2022?.coreTier1Capital, 331.86, '2022 Suzhou Bank core Tier 1 capital must keep the corrected decimal');
assert.equal(shenzhenRural2022?.assets, 5868.54, '2022 Shenzhen Rural Commercial Bank assets must keep the corrected decimal');

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', error => pageErrors.push(error));
page.on('console', message => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});
await page.route('**/googletagmanager.com/**', route => route.abort());

try {
  await page.goto(`${baseUrl}/tools/bank_rank/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#bankList tr.data-row .bank-history-button:not(:disabled)');

  assert.equal(await page.locator('#yearSelect').inputValue(), String(latestYear), 'latest year should be selected by default');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 100, 'default view should render the full latest-year top 100');
  assert.equal((await page.locator('.brand-copy strong').innerText()).trim(), '中国银行业100强榜单');
  assert.equal(await page.locator('#brandSubtitle').count(), 0, 'old capital-ranking/year-range brand subtitle should stay removed');
  assert.equal((await page.locator('#workspaceTitle').innerText()).trim(), `${latestYear} 年中国银行业100强榜单`);
  assert.equal((await page.locator('#resultSummary').innerText()).trim(), `100 家银行 · 榜单基于 ${latestBlock.dataYear} 年末财务数据`);
  assert.equal((await page.locator('#dataStatus').innerText()).trim(), `最新榜单 ${latestYear} 年`);

  assert.equal(await page.locator('.scope-note').count(), 0, 'yellow data-range/year-note UI should stay removed');
  assert.equal(await page.locator('#officialSource').count(), 0, 'per-year association source link should stay removed from the page');
  assert.equal(await page.locator('.data-disclaimer').count(), 1, 'method/disclaimer should be a second footer row like iCloud');
  const sourceSummary = (await page.locator('.workspace-footer .source-summary').innerText()).trim();
  assert.match(sourceSummary, /数据来源：中国银行业协会/);
  assert.match(sourceSummary, /排名口径：核心一级资本净额/);
  assert.match(sourceSummary, /单位：亿元/);
  const disclaimer = (await page.locator('.data-disclaimer').innerText()).trim();
  assert.match(disclaimer, /榜单年份为发布标称年度，财务数据对应上一年末/);
  assert.match(disclaimer, /2023 年起纳入外资法人银行/);
  assert.match(disclaimer, /合并或新设合并/);
  assert.equal((await page.locator('body').innerText()).match(/数据来源：中国银行业协会/g)?.length, 1, 'data source should appear once below the table');
  assert.equal((await page.locator('.page-footer').innerText()).trim(), '© 2026 林春写字的地方');

  assert.match(await page.locator('link[rel="stylesheet"]').getAttribute('href'), /^style\.css\?v=[0-9a-f]{8}$/i, 'stylesheet should use a content version');
  assert.match(await page.locator('script[src^="script.js"]').getAttribute('src'), /^script\.js\?v=[0-9a-f]{8}$/i, 'script should use a content version');

  const hydratedFirstRow = page.locator('#bankList tr.data-row').first();
  assert.equal(await hydratedFirstRow.locator('td').nth(0).locator('.rank-value').count(), 1, 'hydrated ranking cells should retain the static rank-value structure');
  assert.equal(await hydratedFirstRow.locator('td').nth(1).locator('.bank-history-button .history-affordance').count(), 1, 'hydrated bank cells should retain the static history affordance structure');
  assert.equal(await hydratedFirstRow.locator('td').nth(2).locator('.type-badge').count(), 1, 'hydrated type cells should retain the static type-badge structure');
  assert.equal(await page.locator('#bankTable .sort-indicator').count(), 0, 'text glyph sort indicators should stay removed');
  assert.equal(await page.locator('#bankTable thead [data-sort-icon]').count(), 6, 'all sortable headers should use iCloud-style SVG sort icons');
  assert.equal(await page.locator('#bankTable [data-sort="rank"] .lucide-arrow-up').count(), 1, 'default rank sort should show the iCloud-style arrow-up icon');
  assert.equal(await page.locator('#bankTable [data-sort="name"] .lucide-arrow-up-down').count(), 1, 'inactive headers should show the iCloud-style arrow-up-down icon');
  assert.equal(await page.locator('#bankTable th').nth(0).locator('button').evaluate(element => getComputedStyle(element).justifyContent), 'center', 'rank header should align with centered rank cells');
  assert.equal(await page.locator('#bankTable th').nth(2).locator('button').evaluate(element => getComputedStyle(element).justifyContent), 'flex-start', 'bank-type header should align with left-aligned type cells');

  if (oldestYear !== latestYear) {
    await page.locator('#yearSelect').selectOption(String(oldestYear));
    await page.waitForFunction(year => document.querySelector('#workspaceTitle')?.textContent.includes(`${year} 年中国银行业100强榜单`), oldestYear);
    assert.equal(await page.locator('#bankList tr.data-row').count(), 100, `${oldestYear} should render 100 banks`);
    const oldestBlock = loadedYears.find(block => Number(block.rankingYear) === oldestYear);
    assert.match(await page.locator('#resultSummary').innerText(), new RegExp(`100 家银行 · 榜单基于 ${oldestBlock.dataYear} 年末财务数据`));
    await page.locator('#bankSearch').fill('天津农村商业银行');
    const tianjinRow = page.locator('#bankList tr.data-row').first();
    assert.equal((await tianjinRow.locator('td').nth(5).innerText()).trim(), '26.35', '2016 Tianjin Rural verified net profit should render in the UI');
    await page.locator('#bankSearch').fill('');
  }

  await page.locator('#yearSelect').selectOption('2018');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2018 年中国银行业100强榜单'));
  assert.equal(await page.locator('#bankList tr.data-row').count(), 100, '2018 recovered ranking should render all 100 banks');
  assert.match(await page.locator('#bankList tr.data-row').first().innerText(), /中国工商银行/, '2018 recovered ranking should retain ICBC at the top');

  await page.locator('#bankSearch').fill('中国工商银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'bank search should narrow to ICBC');
  const historyButton = page.locator('#bankList .bank-history-button').first();
  await historyButton.click();
  await page.locator('#historyDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#historyDialogTitle').innerText(), /中国工商银行 · 历年排名/);
  assert.equal((await page.locator('#historyDialogMeta').innerText()).trim(), `大型商业银行 · 上榜记录：${oldestYear}–${latestYear}`);
  assert.match(await page.locator('#historyDialogBody').innerText(), new RegExp(String(latestYear)));
  await page.locator('#dialogClose').click();
  await page.locator('#historyDialog').waitFor({ state: 'hidden' });
  assert.equal(await historyButton.evaluate(element => element === document.activeElement), true, 'closing history should restore focus');
  await page.locator('#bankSearch').fill('');

  await page.locator('#yearSelect').selectOption('2021');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2021 年中国银行业100强榜单'));
  await page.locator('#bankSearch').fill('中国建设银行');
  let row = page.locator('#bankList tr.data-row').first();
  assert.equal((await row.locator('td').nth(4).innerText()).trim(), '281,322.54', 'reverified CCB assets should render in the UI');
  await page.locator('#bankSearch').fill('蒙商银行');
  row = page.locator('#bankList tr.data-row').first();
  assert.equal((await row.locator('td').nth(5).innerText()).trim(), '-34.94', 'verified Mengshang Bank loss should render with the negative sign');
  await page.locator('#bankSearch').fill('华融湘江银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'historical source-name search should resolve the bank entity in 2021');
  const renamedRow = page.locator('#bankList tr.data-row').first();
  assert.match(await renamedRow.innerText(), /华融湘江银行/, '2021 yearly ranking should preserve the name published that year');
  const renamedHistoryButton = renamedRow.locator('.bank-history-button');
  await renamedHistoryButton.click();
  await page.locator('#historyDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#historyDialogTitle').innerText(), /湖南银行 · 历年排名/, 'history dialog should aggregate the renamed entity under its current canonical name');
  assert.match(await page.locator('#historyDialogMeta').innerText(), /上榜记录：/);
  assert.doesNotMatch(await page.locator('#historyDialogMeta').innerText(), /当前数据覆盖/);
  await page.locator('#dialogClose').click();
  await page.locator('#historyDialog').waitFor({ state: 'hidden' });
  await page.locator('#bankSearch').fill('');

  await page.locator('#yearSelect').selectOption('2023');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2023 年中国银行业100强榜单'));
  await page.locator('#bankSearch').fill('华融湘江银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'historical-name search should resolve the renamed bank entity');
  assert.match(await page.locator('#bankList tr.data-row').first().innerText(), /湖南银行/, 'post-rename yearly ranking should display the newer published name');
  await page.locator('#bankSearch').fill('');

  await page.locator('#yearSelect').selectOption('2022');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2022 年中国银行业100强榜单'));
  await page.locator('#bankSearch').fill('苏州银行');
  row = page.locator('#bankList tr.data-row').first();
  assert.equal((await row.locator('td').nth(3).innerText()).trim(), '331.86', 'corrected Suzhou Bank value should render in the UI');
  await page.locator('#bankSearch').fill('深圳农商银行');
  row = page.locator('#bankList tr.data-row').first();
  assert.equal((await row.locator('td').nth(4).innerText()).trim(), '5,868.54', '2022 Shenzhen Rural assets should render in the UI');
  await page.locator('#bankSearch').fill('');

  await page.locator('#typeSelect').selectOption('农村商业银行');
  const ruralCount = await page.locator('#bankList tr.data-row').count();
  assert.ok(ruralCount > 0 && ruralCount < 100, 'bank type filter should narrow the ranking');
  assert.match(await page.locator('#resultSummary').innerText(), /类型：农村商业银行/);
  await page.locator('#typeSelect').selectOption('');

  const capitalSort = page.locator('#bankTable [data-sort="coreTier1Capital"]');
  await capitalSort.click();
  assert.equal(await capitalSort.locator('xpath=ancestor::th').getAttribute('aria-sort'), 'descending', 'capital sort should default to descending');
  assert.equal(await capitalSort.locator('.lucide-arrow-down').count(), 1, 'descending sort should use the iCloud-style arrow-down icon');
  await capitalSort.click();
  assert.equal(await capitalSort.locator('xpath=ancestor::th').getAttribute('aria-sort'), 'ascending', 'capital sort should toggle ascending');
  assert.equal(await capitalSort.locator('.lucide-arrow-up').count(), 1, 'ascending sort should use the iCloud-style arrow-up icon');

  // Mobile layout follows the shared tools pattern: controls stack, the page itself stays within the viewport,
  // only the data table receives horizontal scrolling, and focusable form controls stay at 16px to avoid iOS zoom.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#yearSelect').selectOption(String(latestYear));
  await page.locator('#bankSearch').fill('');
  await page.locator('#typeSelect').selectOption('');
  const mobileLayout = await page.evaluate(() => {
    const yearBox = document.querySelector('.year-field').getBoundingClientRect();
    const typeBox = document.querySelector('.type-field').getBoundingClientRect();
    const searchBox = document.querySelector('.search-field').getBoundingClientRect();
    const tableScroll = document.querySelector('.table-scroll');
    const tableBox = tableScroll.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      yearTop: yearBox.top,
      typeTop: typeBox.top,
      searchTop: searchBox.top,
      tableClientWidth: tableScroll.clientWidth,
      tableScrollWidth: tableScroll.scrollWidth,
      tableLeft: tableBox.left,
      tableRight: tableBox.right,
      yearFontSize: parseFloat(getComputedStyle(document.querySelector('#yearSelect')).fontSize),
      typeFontSize: parseFloat(getComputedStyle(document.querySelector('#typeSelect')).fontSize),
      searchFontSize: parseFloat(getComputedStyle(document.querySelector('#bankSearch')).fontSize)
    };
  });
  assert.ok(mobileLayout.documentWidth <= mobileLayout.viewportWidth + 1, `mobile page should not overflow horizontally: ${JSON.stringify(mobileLayout)}`);
  assert.ok(mobileLayout.typeTop > mobileLayout.yearTop && mobileLayout.searchTop > mobileLayout.typeTop, 'mobile filters should stack vertically');
  assert.ok(mobileLayout.tableScrollWidth > mobileLayout.tableClientWidth, 'wide bank table should scroll inside its own container on mobile');
  assert.ok(mobileLayout.tableLeft >= -1 && mobileLayout.tableRight <= mobileLayout.viewportWidth + 1, 'table scroll container should stay inside the mobile viewport');
  assert.ok(mobileLayout.yearFontSize >= 16 && mobileLayout.typeFontSize >= 16 && mobileLayout.searchFontSize >= 16, `mobile form controls should stay at 16px or larger: ${JSON.stringify(mobileLayout)}`);

  // Dynamic data failure must preserve an already fully styled static top-20 fallback.
  // The history chevron and sort icons must be present before hydration so refresh does not flash a different layout.
  const fallbackPage = await context.newPage();
  await fallbackPage.route('**/tools/bank_rank/data/rankings.json', route => route.abort());
  await fallbackPage.goto(`${baseUrl}/tools/bank_rank/`, { waitUntil: 'domcontentloaded' });
  await fallbackPage.waitForFunction(() => document.querySelector('#dataStatus')?.textContent.includes('数据加载失败'));
  assert.equal(await fallbackPage.locator('#bankList tr.data-row[data-static-prerendered="true"]').count(), 20, 'failed dynamic load should preserve all 20 static preview rows');
  const fallbackFirstRow = fallbackPage.locator('#bankList tr.data-row').first();
  assert.match(await fallbackFirstRow.innerText(), /中国工商银行/, 'static fallback should preserve the latest-year first bank');
  assert.equal(await fallbackFirstRow.locator('.bank-history-button').isDisabled(), true, 'static history affordance should remain non-interactive without dynamic data');
  assert.equal(await fallbackFirstRow.locator('.history-affordance').isVisible(), true, 'static history chevron should remain visible before hydration');
  assert.equal(await fallbackPage.locator('#bankTable [data-sort-icon]').count(), 6, 'static table headers should already contain the final SVG sort icons');
  assert.match(await fallbackPage.locator('#resultSummary').innerText(), /20 家静态预览 · 动态数据加载失败/);
  assert.equal(await fallbackPage.locator('#yearSelect').isDisabled(), true, 'failed dynamic load should disable year switching');
  assert.equal(await fallbackPage.locator('#typeSelect').isDisabled(), true, 'failed dynamic load should disable type filtering');
  assert.equal(await fallbackPage.locator('#bankSearch').isDisabled(), true, 'failed dynamic load should disable search');
  await fallbackPage.close();

  assert.deepEqual(pageErrors, [], `page errors in ${browserName}: ${pageErrors.map(error => error.message).join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `console errors in ${browserName}: ${consoleErrors.join(' | ')}`);
  console.log(`bank_rank browser smoke OK (${browserName}): ${oldestYear}–${latestYear}`);
} finally {
  await context.close();
  await browser.close();
}
