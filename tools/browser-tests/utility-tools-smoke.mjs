import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function createPage(contextOptions = {}) {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());
    await page.route('**/cdn.jsdelivr.net/**', (route) => route.abort());
    return { context, page, pageErrors };
}

async function assertMobileFormFonts(page, selector, message) {
    const sizes = await page.locator(selector).evaluateAll((elements) => (
        elements.map((element) => parseFloat(getComputedStyle(element).fontSize))
    ));
    assert.ok(sizes.length > 0 && sizes.every((size) => size >= 16), `${message}: ${sizes.join(', ')}`);
}

async function testRmbConverter() {
    const { context, page, pageErrors } = await createPage({ viewport: { width: 390, height: 844 } });
    await page.addInitScript(() => {
        const nativeVisualViewport = window.visualViewport;
        if (!nativeVisualViewport) return;

        let offsetTop = 0;
        const testVisualViewport = new EventTarget();
        Object.defineProperty(testVisualViewport, 'offsetTop', { get: () => offsetTop });
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: testVisualViewport
        });
        Object.defineProperty(window, '__setTestVisualViewportOffset', {
            configurable: true,
            value: (nextOffset) => {
                offsetTop = nextOffset;
                testVisualViewport.dispatchEvent(new Event('scroll'));
            }
        });
    });
    await page.goto(`${baseUrl}/tools/rmb_converter/`, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('script[src="dist/nzh.min.js"]').count(), 1, 'RMB converter should use local Nzh');
    assert.equal(await page.locator('#inputmoney').getAttribute('autofocus'), null, 'mobile page should not force-open the keyboard');
    assert.equal(await page.evaluate(() => typeof window.__setTestVisualViewportOffset), 'function', 'visual viewport test shim should be installed');
    await assertMobileFormFonts(page, '#inputmoney', 'RMB mobile input should stay at least 16px to avoid iOS focus zoom');

    const initialResultBox = await page.locator('.result-card').boundingBox();
    const initialToolBox = await page.locator('.tool-card').boundingBox();
    assert.ok(initialResultBox && initialToolBox && initialResultBox.y < initialToolBox.y, 'result card should be above the input card from initial render');
    assert.equal(await page.locator('.result-card').evaluate((el) => getComputedStyle(el).position), 'sticky');
    assert.equal(await page.locator('#result1').evaluate((el) => getComputedStyle(el).overflowY), 'auto');

    await page.fill('#inputmoney', '123456.78');
    await page.waitForFunction(() => document.querySelector('#result1')?.textContent?.includes('壹拾贰万'));
    assert.equal(
        (await page.locator('#result1').textContent()).trim(),
        '人民币壹拾贰万叁仟肆佰伍拾陆元柒角捌分'
    );

    const focusedResultBox = await page.locator('.result-card').boundingBox();
    const focusedToolBox = await page.locator('.tool-card').boundingBox();
    assert.ok(focusedResultBox && focusedToolBox && focusedResultBox.y < focusedToolBox.y, 'focused input must not reorder the stable result/input layout');

    // 缩短视口后再叠加 visualViewport.offsetTop，模拟手机软键盘触发的真实可视区平移。
    await page.setViewportSize({ width: 390, height: 480 });
    await page.locator('#inputmoney').scrollIntoViewIfNeeded();
    const keyboardResultBox = await page.locator('.result-card').boundingBox();
    assert.ok(
        keyboardResultBox && keyboardResultBox.y >= 0 && keyboardResultBox.y + keyboardResultBox.height <= 480,
        'result card should remain fully visible in a keyboard-reduced viewport'
    );

    await page.locator('#inputmoney').focus();
    await page.evaluate(() => window.__setTestVisualViewportOffset(84));
    await page.waitForFunction(() => (
        getComputedStyle(document.documentElement).getPropertyValue('--mobile-viewport-top').trim() === '84px'
    ));
    const offsetStickyTop = parseFloat(await page.locator('.result-card').evaluate((el) => getComputedStyle(el).top));
    assert.ok(offsetStickyTop >= 100, 'sticky top should include the 84px visual viewport offset plus mobile top spacing');
    const copyButtonBox = await page.locator('#copyBtn').boundingBox();
    assert.ok(
        copyButtonBox && copyButtonBox.y >= 84 && copyButtonBox.y + copyButtonBox.height <= 480,
        'copy button must remain fully visible when the mobile visual viewport is shifted by the keyboard'
    );

    await page.fill('#inputmoney', '.5');
    await page.waitForFunction(() => document.querySelector('#result1')?.textContent === '人民币伍角');
    assert.equal(await page.locator('#result1').textContent(), '人民币伍角');

    await page.evaluate(() => document.activeElement?.blur());
    await page.waitForFunction(() => (
        getComputedStyle(document.documentElement).getPropertyValue('--mobile-viewport-top').trim() === '0px'
    ));
    const blurredResultBox = await page.locator('.result-card').boundingBox();
    const blurredToolBox = await page.locator('.tool-card').boundingBox();
    assert.ok(blurredResultBox && blurredToolBox && blurredResultBox.y < blurredToolBox.y, 'blur must keep result above input without a layout jump');
    assert.equal(await page.locator('body').evaluate((el) => el.classList.contains('rmb-input-active')), false, 'focus-based layout state should be removed');

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
    const { context, page, pageErrors } = await createPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/tools/renovation_calculator/`, { waitUntil: 'domcontentloaded' });

    assert.equal(await page.locator('#loanTerm').getAttribute('max'), '600');
    await assertMobileFormFonts(page, 'input', 'renovation calculator mobile inputs should stay at least 16px to avoid iOS focus zoom');
    await page.click('.quick-amount[data-value="100000"]');
    await page.click('.quick-term[data-value="60"]');
    await page.click('.quick-fee[data-value="0.18"]');
    assert.equal(await page.inputValue('#loanAmount'), '100000');
    assert.equal(await page.inputValue('#loanTerm'), '60');
    assert.equal(await page.inputValue('#serviceFee'), '0.18');

    await page.click('#calculateBtn');
    await page.waitForSelector('.summary-card');
    assert.match(await page.locator('.summary-card').first().textContent(), /4\.19%/);
    assert.match(await page.locator('tbody tr').first().locator('td').last().textContent(), /2\.18%/);
    assert.equal(await page.locator('tbody tr').count(), 61, '60 instalments plus total row expected');
    assert.match(await page.locator('tbody tr').last().textContent(), /100,000\.00/, 'rounded principal schedule must still repay the exact original principal');

    await page.fill('#loanTerm', '12');
    await page.fill('#serviceFee', '0.5');
    await page.click('#calculateBtn');
    await page.waitForFunction(() => document.querySelector('.summary-card')?.textContent?.includes('11.46%'));
    assert.match(await page.locator('.summary-card').first().textContent(), /11\.46%/);

    await page.fill('#serviceFee', '0');
    await page.click('#calculateBtn');
    await page.waitForFunction(() => document.querySelector('.summary-card')?.textContent?.includes('0.00%'));
    assert.match(await page.locator('.summary-card').first().textContent(), /0\.00%/);

    await page.fill('#loanAmount', '1');
    await page.fill('#loanTerm', '60');
    await page.fill('#serviceFee', '0');
    await page.click('#calculateBtn');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 61);
    const principalCells = await page.locator('tbody tr:not(:last-child) td:nth-child(3)').allTextContents();
    assert.equal(principalCells.some(text => text.includes('-')), false, 'principal instalments must never become negative after cent rounding');
    assert.match(await page.locator('tbody tr').last().textContent(), /￥1\.00/, 'rounded principal instalments must sum back to the original loan amount');

    await page.fill('#loanAmount', '100000.001');
    await page.fill('#loanTerm', '12');
    await page.fill('#serviceFee', '0');
    await page.click('#calculateBtn');
    await page.waitForFunction(() => document.querySelector('.summary-card')?.textContent?.includes('0.00%'));
    assert.match(await page.locator('.summary-card').first().textContent(), /0\.00%/);
    assert.match(await page.locator('tbody tr').last().textContent(), /100,000\.00/);

    // 最大支持期限也必须在浏览器中完整完成，覆盖 IRR 最重的正常输入路径。
    await page.fill('#loanAmount', '100000');
    await page.fill('#loanTerm', '600');
    await page.fill('#serviceFee', '0.18');
    await page.click('#calculateBtn');
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 601);
    assert.equal(await page.locator('tbody tr').count(), 601, '600 instalments plus total row expected');
    assert.match(await page.locator('.summary-card').first().textContent(), /实际年化利率/);

    assert.equal(pageErrors.length, 0, `renovation calculator page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

async function testFinancialCalculatorAlgorithms() {
    const { context, page, pageErrors } = await createPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${baseUrl}/tools/financial_calculator/`, { waitUntil: 'domcontentloaded' });

    await assertMobileFormFonts(page, '.form-control', 'financial calculator mobile inputs/selects should stay at least 16px to avoid iOS focus zoom');
    await page.fill('#principal1', '10000');
    await page.fill('#days1', '30');
    await page.fill('#interest1', '100');
    await page.selectOption('#rateType1', '365');
    await page.click('#calculate1');
    assert.match(await page.locator('#result1').textContent(), /单利年化收益率：12\.17%/);

    await page.click('#tab3');
    await page.fill('#startDate', '2026-01-01');
    await page.fill('#endDate', '2026-06-30');
    await page.fill('#startNetValue', '1');
    await page.fill('#endNetValue', '1.1');
    await page.selectOption('#rateType3', '365');
    await page.click('#calculate3');
    assert.match(await page.locator('#result3').textContent(), /CAGR.*21\.32%/);

    await page.click('#tab4');
    assert.match(await page.locator('label[for="annualRate3"]').textContent(), /名义年利率（APR）/);
    assert.match(await page.locator('label[for="rateType4"]').textContent(), /周\/日年计息天数/);

    await page.fill('#principal3', '10000');
    await page.selectOption('#compoundingFrequency', 'monthly');
    await page.fill('#depositPeriod', '12');
    await page.fill('#annualRate3', '12');
    await page.selectOption('#rateType4', '360');
    await page.click('#calculate4');
    const monthly360 = await page.locator('#result4').textContent();
    await page.selectOption('#rateType4', '365');
    await page.click('#calculate4');
    const monthly365 = await page.locator('#result4').textContent();
    assert.equal(monthly360, monthly365, '360/365 selection must not affect monthly APR compounding');
    assert.match(monthly365, /11,268\.25/);

    await page.selectOption('#compoundingFrequency', 'daily');
    await page.fill('#depositPeriod', '365');
    await page.selectOption('#rateType4', '360');
    await page.click('#calculate4');
    const daily360 = await page.locator('#result4').textContent();
    await page.selectOption('#rateType4', '365');
    await page.click('#calculate4');
    const daily365 = await page.locator('#result4').textContent();
    assert.notEqual(daily360, daily365, '360/365 selection should affect daily APR compounding');

    assert.equal(pageErrors.length, 0, `financial calculator page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
}

try {
    await testRmbConverter();
    await testSpaceTool();
    await testRenovationCalculator();
    await testFinancialCalculatorAlgorithms();
    console.log(`utility tools smoke passed (${browserName})`);
} finally {
    await browser.close();
}