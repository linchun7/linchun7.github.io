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

    assert.equal(await page.locator('script[src="spacing.js?v=20261012-url-parentheses"]').count(), 1, 'space tool should use its content-preserving helper');
    assert.equal(await page.locator('script[src="dist/browser/pangu.min.js"]').count(), 0, 'space UI should not depend on Pangu punctuation normalization');
    // Bound the regression inputs: enough unmatched delimiters to expose rescanning,
    // while keeping the test independent of a microbenchmark or unbounded input.
    const unmatchedFenceInput = '```js\n'.repeat(30000);
    const nestedUrl = `https://example.com/${'（'.repeat(20000)}中文ABC，测试DEF${'）'.repeat(20000)}`;
    const unclosedUrl = `https://example.com/${'（'.repeat(20000)}中文ABC，正文DEF。\n继续XYZ`;
    const unclosedUrlExpected = `https://example.com/${'（'.repeat(20000)}中文 ABC，正文 DEF。\n继续 XYZ`;
    const repeatedUnclosedUrls = 'https://example.com/目录（中文ABC，正文DEF。\n'.repeat(3000);
    const repeatedUnclosedUrlsExpected = 'https://example.com/目录（中文 ABC，正文 DEF。\n'.repeat(3000);
    const unmatchedInlineRuns = Array.from({ length: 600 }, (_, index) => '`'.repeat(index + 1));
    const withSpacingDeadline = async (operation, label) => {
        let timeout;
        try {
            return await Promise.race([
                operation(),
                new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error(`${label} exceeded its 10s deadline`)), 10000);
                })
            ]);
        } finally {
            clearTimeout(timeout);
        }
    };
    const spaceWithDeadline = (text) => withSpacingDeadline(
        () => page.evaluate((value) => window.spaceTextPreservingContent(value), text),
        `spacing helper (${text.length} characters)`
    );
    const cases = [
        ["", ""],
        [" \t \r\n\r ", " \t \r\n\r "],
        ["中A文B字1汉2", "中 A 文 B 字 1 汉 2"],
        ["中文`ABC中文123", "中文`ABC 中文 123"],
        ["王·小明", "王·小明"],
        ["中文( A )与[ B ]再{ C }", "中文 ( A ) 与 [ B ] 再 { C }"],
        ["中文ABC\r\n\r\n第二行123\r段落Z\n结束", "中文 ABC\r\n\r\n第二行 123\r段落 Z\n结束"],
        ["A中B文12号3C", "A 中 B 文 12 号 3C"],
        ["中文😀ABC👩‍💻数字123🧑🏽‍🚀完成", "中文😀ABC👩‍💻数字 123🧑🏽‍🚀完成"],
        ["中文  ABC\t第二行 123", "中文  ABC\t第二行 123"],
        ["访问https://example.com/中文ABC?q=测试123，继续ABC", "访问 https://example.com/中文ABC?q=测试123，继续 ABC"],
        // HTTP(S) schemes are case-insensitive; URL path/query text stays exact.
        ["访问HTTP://example.com/中文ABC?q=测试123，继续ABC", "访问 HTTP://example.com/中文ABC?q=测试123，继续 ABC"],
        ["访问HTTPS://example.com/中文ABC?q=测试123，继续ABC", "访问 HTTPS://example.com/中文ABC?q=测试123，继续 ABC"],
        ["前文ABC HtTpS://example.com/目录ABC?key=中文123&next=路Z，后文XYZ", "前文 ABC HtTpS://example.com/目录ABC?key=中文123&next=路Z，后文 XYZ"],
        // Fullwidth parentheses are legitimate URL path/query characters.
        ["<https://example.com/目录（中文ABC）>", "<https://example.com/目录（中文ABC）>"],
        ["https://example.com/目录（中文ABC）", "https://example.com/目录（中文ABC）"],
        ["访问https://example.com/目录（中文ABC），继续ABC", "访问 https://example.com/目录（中文ABC），继续 ABC"],
        ["访问HTTPS://example.com/目录（中文ABC）?q=测试（123ABC），继续ABC", "访问 HTTPS://example.com/目录（中文ABC）?q=测试（123ABC），继续 ABC"],
        ["前文ABC <HtTpS://example.com/目录（中文ABC）> 后文XYZ", "前文 ABC <HtTpS://example.com/目录（中文ABC）> 后文 XYZ"],
        ["<https://example.com/目录，中文ABC>", "<https://example.com/目录，中文ABC>"],
        ["访问https://example.com/目录（中文ABC）；后文XYZ。结束123", "访问 https://example.com/目录（中文ABC）；后文 XYZ。结束 123"],
        ["https://example.com/目录（中文ABC（测试DEF））", "https://example.com/目录（中文ABC（测试DEF））"],
        ["https://example.com/目录（中文ABC，测试DEF）", "https://example.com/目录（中文ABC，测试DEF）"],
        ["访问HTTP://example.com/目录（中文ABC（测试DEF，内文GHI））?q=（结束123），后文XYZ。正文DEF", "访问 HTTP://example.com/目录（中文ABC（测试DEF，内文GHI））?q=（结束123），后文 XYZ。正文 DEF"],
        ["https://example.com/目录（中文ABC，测试DEF。甲GHI；乙JKL）/尾段XYZ；正文DEF", "https://example.com/目录（中文ABC，测试DEF。甲GHI；乙JKL）/尾段XYZ；正文 DEF"],
        ["<https://example.com/目录（中文ABC（测试DEF，甲GHI））>", "<https://example.com/目录（中文ABC（测试DEF，甲GHI））>"],
        // Unclosed parentheses are prose, including a closed inner pair.
        ["https://example.com/目录（中文ABC，正文DEF。继续XYZ", "https://example.com/目录（中文 ABC，正文 DEF。继续 XYZ"],
        ["https://example.com/目录（中文ABC（测试DEF），正文GHI", "https://example.com/目录（中文 ABC（测试 DEF），正文 GHI"],
        ["https://example.com/目录（中文ABC\n正文DEF）继续XYZ", "https://example.com/目录（中文 ABC\n正文 DEF）继续 XYZ"],
        // A sentence's enclosing parenthesis is outside the bare URL target.
        ["中文（https://example.com/目录ABC）继续XYZ", "中文（https://example.com/目录ABC）继续 XYZ"],
        ["中文（https://example.com/目录（中文ABC））继续XYZ", "中文（https://example.com/目录（中文ABC））继续 XYZ"],
        ["https://example.com/目录（中文ABC）/后续XYZ，正文DEF", "https://example.com/目录（中文ABC）/后续XYZ，正文 DEF"],
        ["https://example.com/目录（中文ABC）（测试123）", "https://example.com/目录（中文ABC）（测试123）"],
        // Percent-encoded controls already worked and must remain byte-identical.
        ["https://example.com/目录%EF%BC%88中文ABC%EF%BC%89", "https://example.com/目录%EF%BC%88中文ABC%EF%BC%89"],
        ["<https://example.com/%E7%9B%AE%E5%BD%95%EF%BC%88%E4%B8%AD%E6%96%87ABC%EF%BC%89>", "<https://example.com/%E7%9B%AE%E5%BD%95%EF%BC%88%E4%B8%AD%E6%96%87ABC%EF%BC%89>"],
        // Scheme matching must not case-fold the ASCII-only boundary classes.
        ["中文K数字ſ结束", "中文K数字ſ结束"],
        ["中文`ABC中文123`", "中文`ABC中文123`"],
        // Whole backtick runs and complete fences must survive both helper and button paths.
        ["中文``变量ABC``继续123", "中文``变量ABC``继续 123"],
        ["中文``变量`ABC中文123`尾Z``继续ABC", "中文``变量`ABC中文123`尾Z``继续 ABC"],
        ["中文```变量``ABC中文123``尾`Z```继续ABC", "中文```变量``ABC中文123``尾`Z```继续 ABC"],
        ["中文``变量ABC```继续123", "中文``变量 ABC```继续 123"],
        ["中文``变量ABC", "中文``变量 ABC"],
        ["中文``未闭合ABC\n`变量ABC`结束123", "中文``未闭合 ABC\n`变量ABC`结束 123"],
        ["前文ABC\n```js\nconst label = `变量ABC`;\nconst value = 中文123;\n```\n后文XYZ", "前文 ABC\n```js\nconst label = `变量ABC`;\nconst value = 中文123;\n```\n后文 XYZ"],
        ["前文ABC\n``````js\n```嵌入ABC\n变量ABC\n`````仍在块内123\n````````\n后文XYZ", "前文 ABC\n``````js\n```嵌入ABC\n变量ABC\n`````仍在块内123\n````````\n后文 XYZ"],
        ["中文ABC\n   ```text\n变量ABC\n  ```` \t\n继续123", "中文 ABC\n   ```text\n变量ABC\n  ```` \t\n继续 123"],
        ["前文ABC\r\n```js\r\nconst label = `变量ABC`;\r\n变量ABC\r\n```\r\n后文123", "前文 ABC\r\n```js\r\nconst label = `变量ABC`;\r\n变量ABC\r\n```\r\n后文 123"],
        ["前文ABC\r```js\rconst label = `变量ABC`;\r变量ABC\r```\r后文123", "前文 ABC\r```js\rconst label = `变量ABC`;\r变量ABC\r```\r后文 123"],
        ["```js\n变量ABC\n```tail\n继续123\n```", "```js\n变量ABC\n```tail\n继续123\n```"],
        ["```js\n变量ABC\n    ```\n继续123\n```", "```js\n变量ABC\n    ```\n继续123\n```"],
        ["```js\n变量ABC\n``\n继续123", "```js\n变量 ABC\n``\n继续 123"],
        // An unclosable longer opener must not hide a later complete shorter fence.
        ["````js\n```js\n变量ABC\n```tail\n继续123\n```", "````js\n```js\n变量ABC\n```tail\n继续123\n```"],
        ["````js\n前文ABC\n```js\n变量ABC\n```\n后文123", "````js\n前文 ABC\n```js\n变量ABC\n```\n后文 123"],
        ["中文`未闭合ABC\n```js\n变量ABC\n```\n尾Z`中文ABC", "中文`未闭合 ABC\n```js\n变量ABC\n```\n尾 Z`中文 ABC"],
        ["中文\" A \":B,中文!数字1", "中文\" A \":B,中文!数字 1"],
        ["𠀀A中B", "𠀀 A 中 B"],
        ["中文(https://example.com/中文ABC)，继续123", "中文 (https://example.com/中文ABC)，继续 123"],
        [nestedUrl, nestedUrl],
        [unclosedUrl, unclosedUrlExpected],
        [repeatedUnclosedUrls, repeatedUnclosedUrlsExpected],
        [`${unmatchedFenceInput}中文ABC`, `${unmatchedFenceInput}中文 ABC`],
        [
            unmatchedInlineRuns.map((run) => `x${run}变量ABC`).join('\n'),
            unmatchedInlineRuns.map((run) => `x${run}变量 ABC`).join('\n')
        ]
    ];
    for (const [input, expected] of cases) {
        // A textarea normalizes CR/CRLF to LF. Check the pure helper first so
        // exact original line endings remain part of the content contract.
        const description = input.length > 1000 ? `${input.length}-character delimiter regression` : JSON.stringify(input);
        const output = await spaceWithDeadline(input);
        assert.equal(output, expected, `helper content preservation: ${description}`);
        assert.equal(
            await spaceWithDeadline(output),
            output,
            'repeated spacing should be idempotent'
        );

        if (input.length > 1000) {
            // Avoid Playwright's costly select/insert path for 30,000 textarea lines.
            // The real input handler and add button still run on the large fixture.
            await withSpacingDeadline(() => page.evaluate((value) => {
                const textarea = document.getElementById('info');
                textarea.value = value;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }, input), `${description} fixture`);
        } else {
            await page.fill('#info', input);
        }
        await page.click('#addBtn', { timeout: 10000 });
        const textareaExpected = expected.replace(/\r\n?/g, '\n');
        assert.equal(await page.inputValue('#info'), textareaExpected, `space UI: ${description}`);
        await page.click('#addBtn', { timeout: 10000 });
        assert.equal(await page.inputValue('#info'), textareaExpected, 'repeated button clicks should not add spaces');
        assert.match(await page.locator('#alertText').textContent(), input ? /已处理/ : /无内容/);
    }
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