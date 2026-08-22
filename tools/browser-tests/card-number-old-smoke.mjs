import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);

const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

function luhnValid(value) {
    const digits = String(value).replace(/\s/g, '');
    let sum = 0;
    for (let index = 0; index < digits.length; index++) {
        let digit = Number(digits[index]);
        if (((digits.length - 1 - index) & 1) === 1) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

async function fillAndWait(page, rule, expectedCount) {
    await page.fill('#inputField', rule);
    await page.waitForFunction(
        (count) => document.querySelector('#count')?.textContent?.trim() === String(count),
        expectedCount
    );
}

try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    await page.route('**/googletagmanager.com/**', (route) => route.abort());

    await page.goto(`${baseUrl}/tools/card_number/`, { waitUntil: 'domcontentloaded' });

    await fillAndWait(page, '7992739871*', 1);
    assert.match(await page.locator('#result').textContent(), /7992 7398 713/);

    await page.click('#generateButton');
    assert.equal(await page.locator('#count').textContent(), '0');

    await fillAndWait(page, '12aa', 2);
    const repeatedLetterResults = (await page.locator('#result').textContent())
        .split(/\n+/)
        .map((line) => line.replace(/\s/g, ''))
        .filter(Boolean);
    assert.equal(repeatedLetterResults.length, 2);
    for (const result of repeatedLetterResults) {
        assert.equal(result[2], result[3], `Repeated-letter rule broken for ${result}`);
        assert.equal(luhnValid(result), true, `Invalid Luhn result: ${result}`);
    }

    await page.click('#generateButton');
    await fillAndWait(page, '12**', 10);
    const independentStarResults = (await page.locator('#result').textContent())
        .split(/\n+/)
        .map((line) => line.replace(/\s/g, ''))
        .filter(Boolean);
    assert.equal(independentStarResults.length, 10);
    assert.ok(independentStarResults.some((result) => result[2] !== result[3]), 'Independent * positions unexpectedly behave like one shared variable');
    assert.ok(independentStarResults.every(luhnValid), 'Old generator emitted a non-Luhn result');

    assert.equal(pageErrors.length, 0, `old card number page errors: ${pageErrors.map(String).join('; ')}`);
    await context.close();
    console.log(`Old card number smoke tests passed in ${browserName}.`);
} finally {
    await browser.close();
}
