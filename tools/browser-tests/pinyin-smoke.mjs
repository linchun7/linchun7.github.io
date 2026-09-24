import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function waitForPinyin(page) {
    const colors = await page.waitForFunction(() => {
        const result = document.querySelector('#result1');
        const placeholder = result?.querySelector('.empty-text');
        if (!window.pinyinPro?.pinyin || !result || !placeholder || placeholder.parentElement !== result) return null;
        const foreground = getComputedStyle(placeholder).color;
        const background = getComputedStyle(result).backgroundColor;
        if (!/\d/.test(foreground) || !/\d/.test(background)) return null;
        return { foreground, background };
    });
    return colors.jsonValue();
}

async function resultText(page, id) {
    return (await page.locator(id).textContent()).trim();
}

function contrastRatio(foreground, background) {
    const parse = (value) => {
        const channels = value.match(/[\d.]+/g);
        assert.ok(channels?.length >= 3, `unsupported computed color: ${value}`);
        return channels.slice(0, 3).map(Number);
    };
    const luminance = (value) => {
        const [r, g, b] = parse(value).map(channel => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const left = luminance(foreground);
    const right = luminance(background);
    return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/pinyin/`, { waitUntil: 'domcontentloaded' });
    const emptyColors = await waitForPinyin(page);
    assert.ok(
        contrastRatio(emptyColors.foreground, emptyColors.background) >= 4.5,
        `empty-result text contrast must meet WCAG AA: ${JSON.stringify(emptyColors)}`
    );

    await page.fill('#inputInfo', '汉语拼音');
    assert.equal(await resultText(page, '#result1'), 'han yu pin yin');
    assert.equal(await resultText(page, '#result2'), 'hàn yǔ pīn yīn');
    assert.equal(await resultText(page, '#result3'), 'han4 yu3 pin1 yin1');
    assert.equal(await resultText(page, '#result4'), 'hypy');
    assert.equal(await page.locator('[data-result="result5"]').isDisabled(), true);
    assert.match(await resultText(page, '#result5'), /仅单个汉字时显示/);

    await page.fill('#inputInfo', '吕布');
    assert.equal(await resultText(page, '#result1'), 'lü bu');
    assert.equal(await resultText(page, '#result2'), 'lǚ bù');
    assert.equal(await resultText(page, '#result3'), 'lü3 bu4');

    await page.fill('#inputInfo', '行长');
    assert.equal(await resultText(page, '#result2'), 'háng zhǎng');

    await page.fill('#inputInfo', '重庆');
    assert.equal(await resultText(page, '#result2'), 'chóng qìng');

    await page.fill('#inputInfo', '音乐');
    assert.equal(await resultText(page, '#result2'), 'yīn yuè');

    await page.fill('#inputInfo', '银行');
    assert.equal(await resultText(page, '#result2'), 'yín háng');

    await page.fill('#inputInfo', '行');
    const multiple = await resultText(page, '#result5');
    assert.match(multiple, /xíng/);
    assert.match(multiple, /háng/);
    assert.equal(await page.locator('[data-result="result5"]').isDisabled(), false);

    await page.fill('#inputInfo', 'A汉1字!');
    assert.equal(await resultText(page, '#result1'), 'han zi');
    assert.equal(await resultText(page, '#result4'), 'hz');

    await page.fill('#inputInfo', '中文');
    const beforeComposition = await resultText(page, '#result2');
    await page.evaluate(() => {
        const input = document.querySelector('#inputInfo');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '吕' }));
        input.value = '吕';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '吕', inputType: 'insertCompositionText', isComposing: true }));
    });
    assert.equal(await resultText(page, '#result2'), beforeComposition);
    await page.evaluate(() => {
        const input = document.querySelector('#inputInfo');
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '吕' }));
    });
    assert.equal(await resultText(page, '#result2'), 'lǚ');

    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: async (value) => {
                    window.__pinyinCopied = value;
                }
            }
        });
    });
    await page.fill('#inputInfo', '汉字');
    await page.click('[data-result="result2"]');
    assert.equal(await page.evaluate(() => window.__pinyinCopied), 'hàn zì');
    assert.match(await page.locator('#toast').textContent(), /已复制/);

    await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async () => { throw new Error('denied'); } }
        });
        document.execCommand = () => false;
    });
    await page.click('[data-result="result2"]');
    assert.match(await page.locator('#toast').textContent(), /复制失败/);

    await page.click('#clearBtn');
    assert.equal(await page.locator('#inputInfo').inputValue(), '');
    assert.match(await resultText(page, '#result1'), /等待输入/);
    assert.equal(await page.locator('[data-result="result1"]').isDisabled(), true);

    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    assert.equal(pageErrors.length, 0, `pinyin page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
    console.log(`Pinyin smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
