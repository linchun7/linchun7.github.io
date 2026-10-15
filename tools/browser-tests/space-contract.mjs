import assert from 'node:assert/strict';

// Shared by ordinary PR validation and every staged Pangu upgrade. All formatting
// runs through the real page -> worker -> on-disk vendor -> URL guard path.
export async function testSpaceContract(browser, baseUrl) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    const bundleRequests = [];
    const differences = [];
    let caseIndex = 0;
    page.on('pageerror', error => errors.push(error.message));
    context.on('request', request => {
        if (new URL(request.url()).pathname === '/tools/space/dist/browser/pangu.min.js') bundleRequests.push(request.url());
    });
    await page.route('**/googletagmanager.com/**', route => route.abort());
    const setInput = async text => page.evaluate(value => {
        const input = document.getElementById('info');
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    const process = async (input, expected) => {
        const index = caseIndex++;
        await setInput(input);
        await page.click('#addBtn');
        await page.waitForFunction(() => { const status = document.getElementById('alertText').textContent; return status && status !== '处理中'; }, null, { timeout: 10000 });
        const status = await page.locator('#alertText').textContent();
        if (status !== '已处理') differences.push({ index, length: input.length, input: input.slice(0, 180), status });
        assert.equal(await page.inputValue('#info'), input.replace(/\r\n?/g, '\n'), 'formatting must leave the source intact');
        const actual = await page.inputValue('#result');
        const normalizedExpected = expected.replace(/\r\n?/g, '\n');
        if (actual !== normalizedExpected) differences.push({ index, length: input.length, input: input.slice(0, 180), actual: actual.slice(0, 180), expected: normalizedExpected.slice(0, 180) });
    };
    try {
        await page.goto(`${baseUrl}/tools/space/`, { waitUntil: 'domcontentloaded' });
        assert.match(await page.locator('.calculator-note').textContent(), /普通文本.*Markdown.*4 秒/);
        assert.equal(await page.locator('#result').getAttribute('readonly'), '');
        // Exact numbered upstream-reserved markers must fail closed. Ordinary
        // private-use glyphs and incomplete/non-numbered lookalikes remain valid.
        for (const literal of [
            '\uE000BACKTICK_CONTENT_0\uE001',
            '\uE002HTML_TAG_PLACEHOLDER_0\uE003',
            '\uE004HTML_TAG_MENTION_0\uE005',
            '\uE006SINGLE_QUOTE_CJK_PLACEHOLDER_0\uE007',
            '\uE008COMPOUND_WORD_PLACEHOLDER_0\uE009',
            '\uE00AHTTP_URL_PLACEHOLDER_0\uE00B'
        ]) {
            const input = '中文 ABC ' + literal;
            await setInput(input);
            await page.click('#addBtn');
            await page.waitForFunction(() => document.getElementById('alertText').textContent.includes('Pangu 保留标记'));
            assert.equal(await page.inputValue('#info'), input);
            assert.equal(await page.inputValue('#result'), '');
        }
        const cases = [
            ['中文\uE100字ABC', '中文\uE100字 ABC'],
            ['中文\uE000字ABC\uE001', '中文\uE000字 ABC\uE001'],
            ['中文 \uE000BACKTICK_CONTENT_x\uE001', '中文 \uE000BACKTICK_CONTENT_x\uE001'],
            ['访问https://[2001:db8::1]/中文ABC，后文DEF', '访问 https://[2001:db8::1]/中文ABC，后文 DEF'],
            ['HTTP://[::1]:8080/Ａ中文ABC]后文DEF', 'HTTP://[::1]:8080/Ａ中文ABC] 后文 DEF'],
            ['<https://[2001:db8::1]/目录[中文ABC]{尾DEF}>', '<https://[2001:db8::1]/目录[中文ABC]{尾DEF}>'],
            ['中文ABC\n第二行123', '中文 ABC\n第二行 123'],
            ['中文:ABC', '中文: ABC'],
            ['王·小明', '王・小明'],
            ['中文,标点!测试?', '中文, 标点! 测试?'],
            ['中文`ABC中文123`后文DEF', '中文 `ABC中文123` 后文 DEF'],
            ['中文  ABC\t第二行\u00a0123', '中文  ABC\t第二行\u00a0123'],
            ['中文ABC\r\n\r\n第二行123\r段落Z', '中文 ABC\r\n\r\n第二行 123\r段落 Z'],
            ['PANGUURLTOKEN0X0END PANGUURLTOKEN1X0END 中文ABC', 'PANGUURLTOKEN0X0END PANGUURLTOKEN1X0END 中文 ABC'],
            ['访问HTTP://example.com/中文ABC?q=测试123，继续ABC', '访问 HTTP://example.com/中文ABC?q=测试123，继续 ABC'],
            ['访问HTTPS://example.com/中文ABC?q=测试123，继续ABC', '访问 HTTPS://example.com/中文ABC?q=测试123，继续 ABC'],
            ['前文ABC HtTpS://example.com/目录ABC?key=中文123&next=路Z，后文XYZ', '前文 ABC HtTpS://example.com/目录ABC?key=中文123&next=路Z，后文 XYZ'],
            ['(https://example.com)中文ABC', '(https://example.com) 中文 ABC'],
            ['中文(https://example.com/中文ABC)后文DEF', '中文 (https://example.com/中文ABC) 后文 DEF'],
            ['https://example.com/a(b(c)d)e?x=(中文ABC)', 'https://example.com/a(b(c)d)e?x=(中文ABC)'],
            ['访问https://example.com/目录（中文ABC，测试DEF）/尾XYZ，正文DEF', '访问 https://example.com/目录（中文ABC，测试DEF）/尾XYZ，正文 DEF'],
            ['https://example.com/目录（未闭合ABC，正文DEF', 'https://example.com/目录（未闭合 ABC，正文 DEF'],
            ['https://example.com/目录（中文ABC\n正文DEF）继续XYZ', 'https://example.com/目录（中文 ABC\n正文 DEF）继续 XYZ'],
            ['<https://example.com/a)中文ABC>', '<https://example.com/a)中文ABC>'],
            ['<HTTPS://example.com/目录，中文ABC[甲DEF]{乙GHI}>', '<HTTPS://example.com/目录，中文ABC[甲DEF]{乙GHI}>'],
            ['https://example.com/中文ABC]后文DEF', 'https://example.com/中文ABC] 后文 DEF'],
            ['https://example.com/中文ABC}后文DEF', 'https://example.com/中文ABC} 后文 DEF'],
            ['https://example.com/中文ABC[后文DEF]', 'https://example.com/中文ABC [后文 DEF]'],
            ['https://example.com/中文ABC{后文DEF}', 'https://example.com/中文ABC {后文 DEF}'],
            ['中文[https://example.com/中文ABC]后文DEF', '中文 [https://example.com/中文ABC] 后文 DEF'],
            ['PANGUURLTOKEN0X0END 访问https://example.com/中文ABC，后文DEF', 'PANGUURLTOKEN0X0END 访问 https://example.com/中文ABC，后文 DEF']
        ];
        for (const path of ['Ａ', '１２', 'ｶﾀｶﾅ', '￥', '＄', '￦', '〇', '〆', '〻', '々']) {
            for (const scheme of ['http', 'HTTPS', 'HtTpS']) {
                const url = `${scheme}://example.com/${path}中文ABC?q=测试123`;
                cases.push([url, url], [`访问${url}，后文DEF`, `访问 ${url}，后文 DEF`]);
            }
        }
        const nestedUrl = `https://example.com/${'（'.repeat(20000)}中文ABC，测试DEF${'）'.repeat(20000)}`;
        cases.push([nestedUrl, nestedUrl]);
        cases.push(['中文ABC '.repeat(10000), '中文 ABC '.repeat(10000)]);
        for (const [input, expected] of cases) await process(input, expected);
        // Repeat processing and copy the result, never mutate the source.
        await process('中文ABC', '中文 ABC');
        await page.click('#addBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '已处理');
        assert.equal(await page.inputValue('#info'), '中文ABC');
        assert.equal(await page.inputValue('#result'), '中文 ABC');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
                writeText: async text => { window.__copied = text; }
            } });
        });
        await page.click('#copyBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '已复制');
        assert.equal(await page.evaluate(() => window.__copied), '中文 ABC');
        await page.click('#clearBtn');
        assert.equal(await page.inputValue('#info'), '');
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.locator('#countText').textContent(), '已输入字符：0');
        await page.click('#addBtn');
        assert.equal(await page.locator('#alertText').textContent(), '无内容');

        // A real previously pathological 180k input must have a bounded terminal
        // state while the main UI remains responsive. Completion OR timeout is
        // acceptable here: no claim is made that fenced code is supported.
        const hostile = '```js\n'.repeat(30000) + '中文ABC';
        await setInput(hostile);
        const started = Date.now();
        await page.click('#addBtn');
        await page.evaluate(() => {
            window.__responsive = false;
            setTimeout(() => { window.__responsive = true; }, 0);
        });
        await page.waitForFunction(() => window.__responsive, null, { timeout: 1000 });
        await page.waitForFunction(() => /已处理|处理超时/.test(document.getElementById('alertText').textContent), null, { timeout: 10000 });
        assert.ok(Date.now() - started < 10000, 'hostile input must complete or be terminated');
        assert.equal(await page.inputValue('#info'), hostile);
        if ((await page.locator('#alertText').textContent()).includes('超时')) assert.equal(await page.inputValue('#result'), '');
        await page.click('#clearBtn');
        await process('恢复ABC', '恢复 ABC');

        await setInput('x'.repeat(200001));
        await page.click('#addBtn');
        assert.match(await page.locator('#alertText').textContent(), /最多处理 20 万/);
        assert.equal(await page.inputValue('#result'), '');
        assert.ok(bundleRequests.length >= cases.length, 'each real worker must request the staged bundle');
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'narrow screen must not overflow');
        assert.ok((await page.locator('#copyBtn').boundingBox()).width > 40);
        assert.deepEqual(errors, [], 'page errors');
        assert.deepEqual(differences, [], 'exact upstream/URL UI outputs');
        console.log(JSON.stringify({ suite: 'space-real-ui-upgrade-contract', cases: cases.length, bundleRequests: bundleRequests.length, status: 'passed' }));
    } finally {
        await context.close();
    }
}

export async function testSpaceFailures(browser, baseUrl) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route('**/googletagmanager.com/**', route => route.abort());
    await page.addInitScript(() => {
        window.__workers = [];
        window.Worker = class {
            constructor() { this.terminated = 0; window.__workers.push(this); }
            postMessage(data) { this.data = data; }
            terminate() { this.terminated += 1; }
        };
    });
    const input = async text => page.fill('#info', text);
    const reply = async (index, result) => page.evaluate(({ index, result }) => {
        const instance = window.__workers[index];
        instance.onmessage({ data: { id: instance.data.id, result } });
    }, { index, result });
    try {
        await page.goto(`${baseUrl}/tools/space/`, { waitUntil: 'domcontentloaded' });
        await input('旧ABC');
        await page.click('#addBtn');
        await input('新DEF');
        await reply(0, '旧 ABC');
        assert.equal(await page.inputValue('#info'), '新DEF');
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.evaluate(() => window.__workers[0].terminated), 1);

        await page.click('#addBtn');
        await page.click('#addBtn');
        await reply(1, '新 DEF');
        assert.match(await page.locator('#alertText').textContent(), /已取消/);
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.evaluate(() => window.__workers[1].terminated), 1);

        await page.click('#addBtn');
        await page.click('#clearBtn');
        await reply(2, '新 DEF');
        assert.equal(await page.inputValue('#info'), '');
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.locator('#alertText').textContent(), '已清空');

        await input('超时ABC');
        await page.click('#addBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent.includes('处理超时'), null, { timeout: 7000 });
        assert.equal(await page.evaluate(() => window.__workers[3].terminated), 1, 'deadline must release the worker');
        await reply(3, '超时 ABC');
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.inputValue('#info'), '超时ABC');
        await page.click('#addBtn');
        await reply(4, '超时 ABC');
        assert.equal(await page.inputValue('#result'), '超时 ABC', 'a fresh attempt works after timeout');

        await input('异常ABC');
        await page.click('#addBtn');
        await page.evaluate(() => window.__workers[5].onerror({ preventDefault() {} }));
        assert.match(await page.locator('#alertText').textContent(), /组件加载失败/);
        assert.equal(await page.inputValue('#info'), '异常ABC');
        assert.equal(await page.inputValue('#result'), '');
        assert.equal(await page.evaluate(() => window.__workers[5].terminated), 1);
        await page.click('#addBtn');
        await reply(6, null);
        assert.match(await page.locator('#alertText').textContent(), /排版失败/);
        assert.equal(await page.inputValue('#info'), '异常ABC');
        assert.equal(await page.evaluate(() => window.__workers[6].terminated), 1);
        console.log(JSON.stringify({ suite: 'space-cancel-stale-timeout-errors', status: 'passed' }));
    } finally { await context.close(); }

    for (const blocked of ['worker.js', 'dist/browser/pangu.min.js', 'format.js']) {
        const failureContext = await browser.newContext();
        await failureContext.route('**/googletagmanager.com/**', route => route.abort());
        await failureContext.route(`**/tools/space/${blocked}*`, route => route.abort());
        const failurePage = await failureContext.newPage();
        try {
            await failurePage.goto(`${baseUrl}/tools/space/`, { waitUntil: 'domcontentloaded' });
            await failurePage.fill('#info', '原文ABC');
            await failurePage.click('#addBtn');
            await failurePage.waitForFunction(() => /组件加载失败/.test(document.getElementById('alertText').textContent), null, { timeout: 7000 });
            assert.equal(await failurePage.inputValue('#info'), '原文ABC');
            assert.equal(await failurePage.inputValue('#result'), '');
            assert.equal(await failurePage.locator('#addBtn').getAttribute('aria-busy'), null);
        } finally { await failureContext.close(); }
    }
}
