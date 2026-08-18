import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function createPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    return { context, page, pageErrors };
}

async function testRmbConverter() {
    const { context, page, pageErrors } = await createPage();
    await page.goto(`${baseUrl}/tools/rmb_converter/`, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('script[src="dist/nzh.min.js"]').count(), 1, 'RMB converter should use local Nzh');
    await page.fill('#inputmoney', '123456.78');
    await page.waitForFunction(() => document.querySelector('#result1')?.textContent?.includes('壹拾贰万'));
    assert.equal(
        (await page.locator('#result1').textContent()).trim(),
        '人民币壹拾贰万叁仟肆佰伍拾陆元柒角捌分'
    );

    await page.fill('#inputmoney', '.5');
    await page.waitForFunction(() => document.querySelector('#result1')?.textContent === '人民币伍角');
    assert.equal(await page.locator('#result1').textContent(), '人民币伍角');
    assert.equal(pageErrors.length, 0, `RMB converter page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testSpaceTool() {
    const { context, page, pageErrors } = await createPage();
    await page.goto(`${baseUrl}/tools/space/`, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('script[src="dist/browser/pangu.min.js"]').count(), 1, 'space tool should use local Pangu');
    await page.fill('#info', '中文ABC\n第二行123');
    await page.click('#addBtn');
    assert.equal(await page.inputValue('#info'), '中文 ABC\n第二行 123');
    assert.match(await page.locator('#alertText').textContent(), /已处理/);
    assert.equal(pageErrors.length, 0, `space tool page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testRenovationCalculator() {
    const { context, page, pageErrors } = await createPage();
    await page.goto(`${baseUrl}/tools/renovation_calculator/`, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('#loanTerm').getAttribute('max'), '600');
    await page.click('.quick-amount[data-value="100000"]');
    await page.click('.quick-term[data-value="60"]');
    await page.click('.quick-fee[data-value="0.18"]');
    assert.equal(await page.inputValue('#loanAmount'), '100000');
    assert.equal(await page.inputValue('#loanTerm'), '60');
    assert.equal(await page.inputValue('#serviceFee'), '0.18');

    await page.click('#calculateBtn');
    await page.waitForSelector('.summary-card');
    const resultText = await page.locator('#result').textContent();
    assert.match(resultText, /实际年化利率/);
    assert.match(resultText, /总手续费/);
    assert.equal(await page.locator('tbody tr').count(), 61, '60 instalments plus total row expected');
    assert.equal(pageErrors.length, 0, `renovation calculator page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

try {
    await testRmbConverter();
    await testSpaceTool();
    await testRenovationCalculator();
    console.log(`utility tools smoke passed (${browserName})`);
} finally {
    await browser.close();
}
