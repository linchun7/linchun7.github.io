import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, 'Unsupported browser: ' + browserName);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });
const failures = [];
let passed = 0;

// Most checks intentionally stub writeText: they verify payloads and races,
// not OS permissions. A separate Chromium-only check uses the real browser API.
async function check(name, run, options = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.route('**/googletagmanager.com/**', route => route.abort());
    await page.addInitScript(() => {
        window.__copies = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async text => { window.__copies.push(text); } }
        });
    });
    try {
        await page.goto(base + '/tools/financial_calculator/', { waitUntil: 'domcontentloaded' });
        await run(page);
        assert.deepEqual(errors, [], 'no uncaught page errors');
        passed++;
        console.log('PASS ' + name);
    } catch (error) {
        failures.push({ name, message: error.message });
        console.error('FAIL ' + name + ': ' + error.stack);
    } finally {
        await context.close();
    }
}

const cases = [
    { tab: 1, title: '单利年化',
      fields: { principal1: '1000', days1: '360', interest1: '50' }, selects: { rateType1: '360' },
      result: '单利年化收益率：5.00%',
      lines: ['本金：1000 元', '持有天数：360 天', '收益：50 元', '年化天数：360 天'],
      method: '单利：收益 ÷ 本金 ÷ 持有天数 × 年化天数' },
    { tab: 2, title: '利息收益',
      fields: { principal2: '1000', days2: '360', annualRate2: '5' }, selects: { rateType2: '360' },
      result: '利息收益：50.00 元',
      lines: ['本金：1000 元', '持有天数：360 天', '单利年化收益率：5%', '年化天数：360 天'],
      method: '单利：本金 × 年化收益率 × 持有天数 ÷ 年化天数' },
    { tab: 3, title: '净值年化（CAGR）',
      fields: { startDate: '2026-01-01', startNetValue: '1', endDate: '2027-01-01', endNetValue: '1.1' },
      selects: { rateType3: '365' }, result: '净值年化收益率（CAGR）：10.00%（持有 365 天）',
      lines: ['起始日期：2026-01-01', '起始净值：1', '终止日期：2027-01-01', '终止净值：1.1', '年化天数：365 天'],
      method: 'CAGR：(终止净值 ÷ 起始净值)^(年化天数 ÷ 持有天数) − 1；持有天数按 UTC 日期差计算' },
    { tab: 4, title: '复利收益',
      fields: { principal3: '1000', annualRate3: '12', depositPeriod: '2' },
      selects: { compoundingFrequency: 'monthly', rateType4: '360' },
      result: '本息总计：1,020.10 元；利息总计：20.10 元' }
];

async function establish(page, item) {
    await page.click('#tab' + item.tab);
    for (const [id, value] of Object.entries(item.fields)) await page.fill('#' + id, value);
    for (const [id, value] of Object.entries(item.selects)) await page.selectOption('#' + id, value);
    await page.click('#calculate' + item.tab);
    assert.equal(await page.locator('#copySummary' + item.tab).isDisabled(), false);
}
async function copied(page, tab) {
    const count = await page.evaluate(() => window.__copies.length);
    await page.click('#copySummary' + tab);
    await page.waitForFunction(tab => document.getElementById('copyStatus' + tab).textContent === '已复制计算摘要', tab);
    assert.equal(await page.evaluate(() => window.__copies.length), count + 1);
    return page.evaluate(() => window.__copies.at(-1));
}

try {
    for (const item of cases) {
        await check('exact summary and unchanged visible result, panel ' + item.tab, async page => {
            assert.equal(await page.locator('#copySummary' + item.tab).isDisabled(), true);
            await establish(page, item);
            assert.equal(await page.locator('#result' + item.tab).textContent(), item.result);
            assert.equal(await page.evaluate(() => window.__copies.length), 0, 'calculating does not touch clipboard');
            const summary = await copied(page, item.tab);
            if (item.tab !== 4) {
                assert.equal(summary, [
                    '金融计算摘要｜' + item.title, ...item.lines,
                    '计算口径：' + item.method, '计算结果：' + item.result
                ].join('\n'));
            } else {
                assert.ok(summary.startsWith('金融计算摘要｜复利收益\n'));
                assert.ok(summary.endsWith('计算结果：' + item.result));
            }
            assert.equal(await page.locator('#result' + item.tab).textContent(), item.result);
            await page.click('#empty' + item.tab);
            assert.equal(await page.locator('#copySummary' + item.tab).isDisabled(), true);
            assert.equal(await page.locator('#copyStatus' + item.tab).textContent(), '');
            assert.equal(await page.locator('#result' + item.tab).textContent(), '');
            assert.equal(await page.evaluate(() => document.activeElement.id), Object.keys(item.fields)[0]);
        });
    }

    for (const item of cases) {
        for (const id of [...Object.keys(item.fields), ...Object.keys(item.selects)]) {
            for (const event of ['input', 'change'].filter(event => !Object.hasOwn(item.selects, id) || event === 'change')) {
                await check('invalidate ' + id + ' on ' + event, async page => {
                    await establish(page, item);
                    await copied(page, item.tab);
                    await page.evaluate(({ id, event }) => {
                        const input = document.getElementById(id);
                        if (input.tagName === 'SELECT') input.selectedIndex = input.selectedIndex ? 0 : 1;
                        else if (input.type === 'date') input.value = '2026-03-01';
                        else input.value = '2';
                        input.dispatchEvent(new Event(event, { bubbles: true }));
                    }, { id, event });
                    assert.equal(await page.locator('#copySummary' + item.tab).isDisabled(), true);
                    assert.equal(await page.locator('#copyStatus' + item.tab).textContent(), '');
                    assert.equal(await page.locator('#result' + item.tab).textContent(), '');
                    if (item.tab === 4) assert.equal(await page.locator('#result4-table').textContent(), '');
                    await page.evaluate(tab => document.getElementById('copySummary' + tab).click(), item.tab);
                    assert.equal(await page.evaluate(() => window.__copies.length), 1, 'invalidated payload cannot be copied');
                    await establish(page, item);
                    assert.ok((await copied(page, item.tab)).includes('计算结果：' + item.result));
                });
            }
        }
    }

    // Literal expected display values are independent of implementation math.
    const compoundVectors = [
        ['annually', '年', 1, '1,254.40', '254.40'],
        ['semi-annually', '半年', 2, '1,123.60', '123.60'],
        ['quarterly', '季', 4, '1,060.90', '60.90'],
        ['monthly', '月', 12, '1,020.10', '20.10'],
        ['weekly', '周', 7, ['1,004.67', '1,004.61'], ['4.67', '4.61']],
        ['daily', '日', 1, ['1,000.67', '1,000.66'], ['0.67', '0.66']]
    ];
    for (const [frequency, unit, divisor, totals, gains] of compoundVectors) {
        for (const [index, basis] of ['360', '365'].entries()) {
            await check('compound ' + frequency + ', basis ' + basis, async page => {
                const item = { ...cases[3], selects: { compoundingFrequency: frequency, rateType4: basis } };
                await establish(page, item);
                const result = '本息总计：' + (Array.isArray(totals) ? totals[index] : totals) + ' 元；利息总计：' + (Array.isArray(gains) ? gains[index] : gains) + ' 元';
                assert.equal(await page.locator('#result4').textContent(), result);
                const summary = await copied(page, 4);
                const dayBased = ['weekly', 'daily'].includes(frequency);
                const basisLine = dayBased
                    ? '年计息天数：' + basis + ' 天；单期利率 = APR × ' + divisor + ' ÷ 年计息天数'
                    : '单期利率 = APR ÷ ' + divisor + '；360 / 365 天不参与本复利方式';
                assert.equal(summary, [
                    '金融计算摘要｜复利收益', '本金：1000 元', '名义年利率（APR）：12%',
                    '复利方式：按' + unit + '复利', '存期：2 ' + unit + '（共 2 期）',
                    basisLine, '复制范围：仅汇总，不含逐期明细',
                    '计算口径：复利：本金 × (1 + 单期利率)^期数；结果保留页面显示精度',
                    '计算结果：' + result
                ].join('\n'));
                assert.equal(await page.locator('#result4-table tbody tr').count(), 2);
            });
        }
    }

    for (const [tab, result] of [[1, '单利年化收益率：5.07%'], [2, '利息收益：49.32 元'], [3, '净值年化收益率（CAGR）：9.86%（持有 365 天）']]) {
        await check('alternate annual basis, panel ' + tab, async page => {
            const item = cases[tab - 1];
            await establish(page, item);
            const basis = tab === 3 ? '360' : '365';
            await page.selectOption('#rateType' + tab, basis);
            await page.click('#calculate' + tab);
            assert.equal(await page.locator('#result' + tab).textContent(), result);
            const summary = await copied(page, tab);
            assert.ok(summary.includes('年化天数：' + basis + ' 天'));
            assert.ok(summary.endsWith('计算结果：' + result));
        });
    }

    await check('parsed numeric inputs and bounded detail-free payload', async page => {
        await establish(page, { ...cases[3], fields: { principal3: '1e3', annualRate3: '0', depositPeriod: '2001' } });
        const summary = await copied(page, 4);
        assert.ok(summary.includes('本金：1000 元'));
        assert.ok(summary.includes('存期：2001 月（共 2001 期）'));
        assert.ok(summary.length < 600);
        assert.equal(await page.locator('#result4-table tbody tr').count(), 0);
        assert.match(await page.locator('#result4-table').textContent(), /仅显示汇总/);
        assert.doesNotMatch(summary, /期初本金|累计收益/);
    });


    for (const [tab, fields, result] of [
        [1, { principal1: '1000', days1: '360', interest1: '-50' }, '单利年化收益率：-5.00%'],
        [2, { principal2: '1000', days2: '360', annualRate2: '0' }, '利息收益：0.00 元'],
        [3, { startDate: '2026-01-01', startNetValue: '1', endDate: '2027-01-01', endNetValue: '0' }, '净值年化收益率（CAGR）：-100.00%（持有 365 天）'],
        [4, { principal3: '1000', annualRate3: '-12', depositPeriod: '2' }, '本息总计：980.10 元；利息总计：-19.90 元']
    ]) {
        await check('valid zero/loss summary, panel ' + tab, async page => {
            await establish(page, { ...cases[tab - 1], fields });
            assert.equal(await page.locator('#result' + tab).textContent(), result);
            assert.ok((await copied(page, tab)).endsWith('计算结果：' + result));
        });
    }

    await check('irrelevant non-day basis is ignored in successful compound snapshot', async page => {
        await establish(page, cases[3]);
        await page.evaluate(() => {
            const select = document.getElementById('rateType4');
            select.append(new Option('irrelevant invalid basis', '999'));
            select.value = '999';
        });
        await page.click('#calculate4');
        const summary = await copied(page, 4);
        assert.ok(summary.includes('360 / 365 天不参与本复利方式'));
        assert.doesNotMatch(summary, /999|irrelevant/);
        assert.ok(summary.endsWith('计算结果：' + cases[3].result));
    });

    for (const item of cases) {
        await check('failed recalculation cannot keep old summary, panel ' + item.tab, async page => {
            await establish(page, item);
            await copied(page, item.tab);
            await page.evaluate(id => { document.getElementById(id).value = ''; }, Object.keys(item.fields)[0]);
            await page.click('#calculate' + item.tab);
            assert.equal(await page.locator('#result' + item.tab).evaluate(el => el.classList.contains('result-error')), true);
            assert.equal(await page.locator('#copySummary' + item.tab).isDisabled(), true);
            assert.equal(await page.locator('#copyStatus' + item.tab).textContent(), '');
            if (item.tab === 4) assert.equal(await page.locator('#result4-table').textContent(), '');
        });
    }

    await check('tab independence, keyboard copy, and no automatic clipboard writes', async page => {
        await establish(page, cases[0]);
        await page.click('#tab2');
        await page.fill('#principal2', '9');
        assert.equal(await page.locator('#copySummary1').isDisabled(), false);
        await page.locator('#tab2').focus();
        await page.keyboard.press('ArrowLeft');
        assert.equal(await page.locator('#content1').isVisible(), true);
        await page.locator('#calculate1').focus();
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'copySummary1');
        assert.equal(await page.evaluate(() => window.__copies.length), 0);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.getElementById('copyStatus1').textContent === '已复制计算摘要');
        assert.equal(await page.evaluate(() => window.__copies.length), 1);
        assert.equal(await page.locator('#copyStatus1').getAttribute('role'), 'status');
        assert.equal(await page.locator('#copyStatus1').getAttribute('aria-live'), 'polite');
    });

    for (const mode of ['missing', 'reject', 'throw']) {
        await check('explicit copy failure and recovery: ' + mode, async page => {
            await establish(page, cases[0]);
            await page.evaluate(mode => {
                Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
                    writeText: mode === 'throw'
                        ? () => { throw new Error('sync failure'); }
                        : async () => { throw new DOMException('denied', 'NotAllowedError'); }
                } });
            }, mode);
            await page.click('#copySummary1');
            await page.waitForFunction(() => document.getElementById('copyStatus1').textContent.includes('复制失败'));
            assert.match(await page.locator('#copyStatus1').textContent(), /手动复制页面结果/);
            assert.equal(await page.locator('#copySummary1').isDisabled(), false);
            assert.equal(await page.locator('#result1').textContent(), cases[0].result);
            await page.evaluate(() => {
                Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => window.__copies.push(text) } });
            });
            assert.ok((await copied(page, 1)).endsWith('计算结果：' + cases[0].result));
        });
    }

    for (const outcome of ['resolve', 'reject']) {
        await check('pending global lock, edit/recalculate and stale ' + outcome, async page => {
            await establish(page, cases[1]);
            await establish(page, cases[0]);
            await page.evaluate(() => {
                navigator.clipboard.writeText = text => {
                    window.__copies.push(text);
                    return new Promise((resolve, reject) => { window.__finish = resolve; window.__fail = reject; });
                };
                document.getElementById('copySummary1').click();
                for (let i = 0; i < 10; i++) document.getElementById('copySummary1').click();
                document.getElementById('copySummary2').click();
            });
            assert.equal(await page.evaluate(() => window.__copies.length), 1);
            assert.equal(await page.locator('#copyStatus1').textContent(), '正在复制…');
            assert.equal(await page.locator('#copySummary2').isDisabled(), true);
            await page.fill('#interest1', '100');
            await page.click('#calculate1');
            assert.equal(await page.locator('#result1').textContent(), '单利年化收益率：10.00%');
            assert.equal(await page.locator('#copyStatus1').textContent(), '');
            assert.equal(await page.locator('#copySummary1').isDisabled(), true);
            await page.evaluate(outcome => {
                if (outcome === 'resolve') window.__finish();
                else window.__fail(new Error('late denial'));
            }, outcome);
            await page.waitForFunction(() => !document.getElementById('copySummary1').disabled);
            assert.equal(await page.locator('#copyStatus1').textContent(), '', 'stale completion cannot claim success/failure');
            assert.equal(await page.locator('#copySummary2').isDisabled(), false);
            await page.evaluate(() => { navigator.clipboard.writeText = async text => window.__copies.push(text); });
            assert.ok((await copied(page, 1)).endsWith('计算结果：单利年化收益率：10.00%'));
        });
    }

    await check('programmatic no-event edits blocked before and during copy', async page => {
        await establish(page, cases[0]);
        await page.evaluate(() => { document.getElementById('principal1').value = '2000'; });
        await page.click('#copySummary1');
        assert.equal(await page.evaluate(() => window.__copies.length), 0);
        assert.equal(await page.locator('#copySummary1').isDisabled(), true);
        assert.match(await page.locator('#copyStatus1').textContent(), /重新计算/);
        await establish(page, cases[0]);
        await page.evaluate(() => {
            navigator.clipboard.writeText = text => {
                window.__copies.push(text);
                return new Promise(resolve => { window.__finish = resolve; });
            };
            document.getElementById('copySummary1').click();
            document.getElementById('principal1').value = '2000';
            window.__finish();
        });
        await page.waitForFunction(() => document.getElementById('copySummary1').disabled && document.getElementById('result1').textContent === '');
        assert.equal(await page.locator('#copyStatus1').textContent(), '');
    });

    await check('clear while pending never resurrects summary', async page => {
        await establish(page, cases[3]);
        await page.evaluate(() => {
            navigator.clipboard.writeText = () => new Promise(resolve => { window.__finish = resolve; });
            document.getElementById('copySummary4').click();
        });
        await page.click('#empty4');
        await page.evaluate(() => window.__finish());
        await page.waitForFunction(() => document.getElementById('copySummary4').disabled);
        assert.equal(await page.locator('#copyStatus4').textContent(), '');
        assert.equal(await page.locator('#result4-table').textContent(), '');
        assert.equal(await page.evaluate(() => document.activeElement.id), 'principal3');
    });

    for (const width of [320, 390, 620, 621, 1280]) {
        await check('copy controls and failure text fit viewport ' + width, async page => {
            await page.setViewportSize({ width, height: 844 });
            for (const item of cases) {
                await establish(page, item);
                await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('denied'); }; });
                await page.click('#copySummary' + item.tab);
                await page.waitForFunction(tab => document.getElementById('copyStatus' + tab).textContent.includes('复制失败'), item.tab);
                const layout = await page.locator('#content' + item.tab + ' .summary-actions').evaluate(el => {
                    const button = el.querySelector('button').getBoundingClientRect();
                    const status = el.querySelector('[role="status"]').getBoundingClientRect();
                    return { button: { left: button.left, right: button.right, height: button.height },
                        status: { left: status.left, right: status.right },
                        scroll: document.documentElement.scrollWidth, width: innerWidth };
                });
                assert.ok(layout.button.left >= 0 && layout.button.right <= width && layout.button.height >= 42);
                assert.ok(layout.status.left >= 0 && layout.status.right <= width);
                assert.ok(layout.scroll <= layout.width, 'no page horizontal overflow');
            }
        });
    }

    console.log(JSON.stringify({ browser: browserName, stubbedClipboardChecks: passed, failures }, null, 2));
    assert.deepEqual(failures, [], 'calculation summary acceptance checks');

    if (browserName === 'chromium') {
        const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage();
        await page.route('**/googletagmanager.com/**', route => route.abort());
        try {
            await page.goto(base + '/tools/financial_calculator/', { waitUntil: 'domcontentloaded' });
            await establish(page, cases[0]);
            await page.click('#copySummary1');
            await page.waitForFunction(() => document.getElementById('copyStatus1').textContent === '已复制计算摘要');
            const text = await page.evaluate(() => navigator.clipboard.readText());
            assert.ok(text.startsWith('金融计算摘要｜单利年化\n'));
            assert.ok(text.endsWith('计算结果：单利年化收益率：5.00%'));
            console.log('PASS real Chromium headless clipboard API round trip (CI sandbox, not user OS)');
        } finally {
            await context.close();
        }
    } else {
        console.log('LIMITATION: real clipboard permissions not asserted for ' + browserName + '; deterministic stubs cover API success/failure/races.');
    }
} finally {
    await browser.close();
}
