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

// Lock known transcription repairs as part of the verified historical baseline.
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
  await page.waitForSelector('#bankList tr.data-row .bank-history-button');

  assert.equal(await page.locator('#yearSelect').inputValue(), String(latestYear), 'latest year should be selected by default');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 100, 'default view should render the full latest-year top 100');
  assert.equal((await page.locator('#workspaceTitle').innerText()).trim(), `${latestYear} 年中国银行业100强 · 100 家`);
  assert.equal((await page.locator('#dataStatus').innerText()).trim(), `最新数据 ${latestYear} 年`);

  if (oldestYear !== latestYear) {
    await page.locator('#yearSelect').selectOption(String(oldestYear));
    await page.waitForFunction(year => document.querySelector('#workspaceTitle')?.textContent.includes(`${year} 年中国银行业100强`), oldestYear);
    assert.equal(await page.locator('#bankList tr.data-row').count(), 100, `${oldestYear} should render 100 banks`);
    const oldestBlock = loadedYears.find(block => Number(block.rankingYear) === oldestYear);
    assert.match(await page.locator('#resultSummary').innerText(), new RegExp(`${oldestBlock.dataYear} 年末`));
  }

  await page.locator('#yearSelect').selectOption('2018');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2018 年中国银行业100强'));
  assert.equal(await page.locator('#bankList tr.data-row').count(), 100, '2018 recovered ranking should render all 100 banks');
  assert.match(await page.locator('#bankList tr.data-row').first().innerText(), /中国工商银行/, '2018 recovered ranking should retain ICBC at the top');

  await page.locator('#bankSearch').fill('中国工商银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'bank search should narrow to ICBC');
  const historyButton = page.locator('#bankList .bank-history-button').first();
  await historyButton.click();
  await page.locator('#historyDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#historyDialogTitle').innerText(), /中国工商银行 · 历年排名/);
  assert.match(await page.locator('#historyDialogBody').innerText(), new RegExp(String(latestYear)));
  await page.locator('#dialogClose').click();
  await page.locator('#historyDialog').waitFor({ state: 'hidden' });
  assert.equal(await historyButton.evaluate(element => element === document.activeElement), true, 'closing history should restore focus');
  await page.locator('#bankSearch').fill('');

  await page.locator('#yearSelect').selectOption('2021');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2021 年中国银行业100强'));
  await page.locator('#bankSearch').fill('华融湘江银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'historical source-name search should resolve the bank entity in 2021');
  let renamedRow = page.locator('#bankList tr.data-row').first();
  assert.match(await renamedRow.innerText(), /华融湘江银行/, '2021 yearly ranking should preserve the name published that year');
  const renamedHistoryButton = renamedRow.locator('.bank-history-button');
  await renamedHistoryButton.click();
  await page.locator('#historyDialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#historyDialogTitle').innerText(), /湖南银行 · 历年排名/, 'history dialog should aggregate the renamed entity under its current canonical name');
  await page.locator('#dialogClose').click();
  await page.locator('#historyDialog').waitFor({ state: 'hidden' });
  await page.locator('#bankSearch').fill('');

  await page.locator('#yearSelect').selectOption('2023');
  await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2023 年中国银行业100强'));
  await page.locator('#bankSearch').fill('华融湘江银行');
  assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'historical-name search should resolve the renamed bank entity');
  assert.match(await page.locator('#bankList tr.data-row').first().innerText(), /湖南银行/, 'post-rename yearly ranking should display the newer published name');
  await page.locator('#bankSearch').fill('');

  if (years.includes(2022)) {
    await page.locator('#yearSelect').selectOption('2022');
    await page.waitForFunction(() => document.querySelector('#workspaceTitle')?.textContent.includes('2022 年中国银行业100强'));
    await page.locator('#bankSearch').fill('苏州银行');
    let row = page.locator('#bankList tr.data-row').first();
    assert.equal((await row.locator('td').nth(3).innerText()).trim(), '331.86', 'corrected Suzhou Bank value should render in the UI');
    await page.locator('#bankSearch').fill('深圳农商银行');
    row = page.locator('#bankList tr.data-row').first();
    assert.equal((await row.locator('td').nth(4).innerText()).trim(), '5,868.54', 'corrected Shenzhen Rural assets should render in the UI');
    await page.locator('#bankSearch').fill('');
  }

  await page.locator('#typeSelect').selectOption('农村商业银行');
  const ruralCount = await page.locator('#bankList tr.data-row').count();
  assert.ok(ruralCount > 0 && ruralCount < 100, 'bank type filter should narrow the ranking');
  await page.locator('#typeSelect').selectOption('');

  const capitalSort = page.locator('#bankTable [data-sort="coreTier1Capital"]');
  await capitalSort.click();
  assert.equal(await capitalSort.locator('xpath=ancestor::th').getAttribute('aria-sort'), 'descending', 'capital sort should default to descending');
  await capitalSort.click();
  assert.equal(await capitalSort.locator('xpath=ancestor::th').getAttribute('aria-sort'), 'ascending', 'capital sort should toggle ascending');

  assert.deepEqual(pageErrors, [], `page errors in ${browserName}: ${pageErrors.map(error => error.message).join(' | ')}`);
  assert.deepEqual(consoleErrors, [], `console errors in ${browserName}: ${consoleErrors.join(' | ')}`);
  console.log(`bank_rank browser smoke OK (${browserName}): ${oldestYear}–${latestYear}`);
} finally {
  await context.close();
  await browser.close();
}
