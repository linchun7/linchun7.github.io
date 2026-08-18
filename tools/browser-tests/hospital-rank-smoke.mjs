import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1365, height: 900 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error));
await page.route('**/googletagmanager.com/**', route => route.abort());

try {
    await page.goto(`${baseUrl}/tools/hospital_rank/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#hospitalList tr.data-row');

    assert.equal(await page.locator('script[src*="echarts"]').count(), 0, 'ECharts should be removed');
    await page.locator('#yearSelect').selectOption('2023');
    await page.waitForFunction(() => document.querySelectorAll('#hospitalList tr.data-row').length === 100);

    const firstRow = page.locator('#hospitalList tr.data-row').first();
    const firstRank = (await firstRow.locator('td').nth(1).innerText()).trim();
    const firstHospital = (await firstRow.locator('td').nth(2).innerText()).trim();
    assert.equal(firstRank, 'A++++', '2023 should render official grade values');
    assert.match(firstHospital, /北京协和医院/, 'same-grade display order should use nearest prior numeric rank');

    const notice = await page.locator('.overview-note').innerText();
    assert.match(notice, /同等级官方不分先后/);
    assert.match(notice, /最近一次数字排名辅助排序/);

    await page.locator('#hospitalList .hospital-history-button').first().click();
    await page.waitForSelector('#hospitalList tr.rank-history-row');
    const historyText = await page.locator('#hospitalList tr.rank-history-row').innerText();
    assert.match(historyText, /2023年/);
    assert.match(historyText, /2022年/);
    assert.match(historyText, /改为等级制/);

    await page.locator('#yearSelect').selectOption('');
    await page.locator('#hospitalSearch').fill('华西医院');
    await page.waitForTimeout(280);
    const searchRows = page.locator('#hospitalList tr.data-row');
    assert.ok(await searchRows.count() > 1, 'search should return hospital history across years');
    assert.match(await searchRows.first().innerText(), /华西医院/);

    await page.locator('#hospitalSearch').fill('');
    await page.waitForTimeout(280);
    await page.locator('button[data-sort="排名"]').click();
    const topRows = page.locator('#hospitalList tr.data-row');
    assert.equal((await topRows.nth(0).locator('td').nth(0).innerText()).trim(), '2023');
    assert.equal((await topRows.nth(0).locator('td').nth(1).innerText()).trim(), 'A++++');

    assert.deepEqual(pageErrors.map(error => error.message), [], 'page should not emit runtime errors');
} finally {
    await context.close();
    await browser.close();
}
