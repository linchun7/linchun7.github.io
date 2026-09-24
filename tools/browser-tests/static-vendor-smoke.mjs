import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const vendor = process.env.STATIC_VENDOR;
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
if (!['nzh', 'pangu'].includes(vendor)) throw new Error(`Unsupported static vendor: ${vendor}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function createPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
    return { context, page, pageErrors };
}

async function testNzh() {
    const { context, page, pageErrors } = await createPage();
    await page.goto(`${baseUrl}/tools/rmb_converter/`, { waitUntil: 'domcontentloaded' });
    await page.fill('#inputmoney', '123456.78');
    await page.waitForFunction(() => document.querySelector('#result1')?.textContent?.includes('壹拾贰万'));
    assert.equal(
        (await page.locator('#result1').textContent()).trim(),
        '人民币壹拾贰万叁仟肆佰伍拾陆元柒角捌分'
    );
    assert.equal(pageErrors.length, 0, `RMB converter page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testPangu() {
    const { context, page, pageErrors } = await createPage();
    await page.goto(`${baseUrl}/tools/space/`, { waitUntil: 'domcontentloaded' });
    await page.fill('#info', '中文ABC\n第二行123');
    await page.click('#addBtn');
    assert.equal(await page.inputValue('#info'), '中文 ABC\n第二行 123');
    assert.equal(pageErrors.length, 0, `space tool page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

try {
    if (vendor === 'nzh') await testNzh();
    if (vendor === 'pangu') await testPangu();
    console.log(`static vendor smoke passed (${vendor}, ${browserName})`);
} finally {
    await browser.close();
}
