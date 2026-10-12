import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const type = { chromium, firefox, webkit }[name];
if (!type) throw new Error(`Unsupported browser: ${name}`);
const base = process.env.BASE_URL || 'http://127.0.0.1:4173';
const browser = await type.launch({ headless: true });
const failures = [];
try {
    for (const scenario of ['native-keyboard-return', 'new-search-focus', 'new-dialog-session']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
        try {
            await context.route('**/googletagmanager.com/**', route => route.abort());
            await context.route('**/google-analytics.com/**', route => route.abort());
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${base}/tools/bank_rank/`);
            await page.waitForSelector('.bank-history-button:not(:disabled)');
            if (scenario === 'new-search-focus') {
                await page.locator('#bankSearch').fill('中国工商银行');
                await page.waitForFunction(() => {
                    const buttons = [...document.querySelectorAll('.bank-history-button')];
                    return buttons.length > 0 && buttons.every(node => node.textContent.includes('中国工商银行'));
                });
            }
            await page.locator('.bank-history-button').nth(0).evaluate(node => { node.dataset.closeProbe = 'first'; });
            if (scenario === 'new-dialog-session') {
                await page.locator('.bank-history-button').nth(1).evaluate(node => { node.dataset.closeProbe = 'second'; });
            }
            const first = page.locator('[data-close-probe="first"]');
            await first.focus();
            await page.keyboard.press('Enter');
            await page.locator('#historyDialog').waitFor({ state: 'visible' });
            let evidence;

            if (scenario === 'native-keyboard-return') {
                await page.evaluate(() => {
                    const dialog = document.getElementById('historyDialog');
                    window.__bankClosed = new Promise(resolve => dialog.addEventListener('close',
                        event => resolve({ trusted: event.isTrusted, open: dialog.open, active: document.activeElement?.dataset.closeProbe }),
                        { once: true }));
                });
                await page.keyboard.press('Escape');
                evidence = await page.evaluate(() => window.__bankClosed);
                assert.deepEqual(evidence, { trusted: true, open: false, active: 'first' });
                await page.keyboard.press('Enter');
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
                await page.evaluate(() => {
                    const dialog = document.getElementById('historyDialog');
                    window.__bankClosed = new Promise(resolve => dialog.addEventListener('close',
                        event => resolve({ trusted: event.isTrusted, open: dialog.open, active: document.activeElement?.dataset.closeProbe }),
                        { once: true }));
                });
                await page.locator('#dialogClose').click();
                assert.deepEqual(await page.evaluate(() => window.__bankClosed),
                    { trusted: true, open: false, active: 'first' });
            } else if (scenario === 'new-search-focus') {
                // Real native close queues its event. A newer user action starts
                // synchronously after close; no event stubs, sleeps or retrying edits.
                evidence = await page.evaluate(() => new Promise(resolve => {
                    const dialog = document.getElementById('historyDialog');
                    const search = document.getElementById('bankSearch');
                    dialog.addEventListener('close', event => resolve({
                        trusted: event.isTrusted, open: dialog.open,
                        focusPreserved: document.activeElement === search,
                        valueBeforeKey: search.value
                    }), { once: true });
                    dialog.close();
                    search.focus();
                    search.select();
                }));
                await page.keyboard.press('Backspace');
                const value = await page.locator('#bankSearch').inputValue();
                assert.deepEqual({ ...evidence, value }, {
                    trusted: true, open: false, focusPreserved: true,
                    valueBeforeKey: '中国工商银行', value: ''
                }, 'a queued close must not steal a newer search edit');
            } else {
                evidence = await page.evaluate(() => new Promise(resolve => {
                    const dialog = document.getElementById('historyDialog');
                    const second = document.querySelector('[data-close-probe="second"]');
                    let nextTitle;
                    let nextActive;
                    dialog.addEventListener('close', event => resolve({
                        trusted: event.isTrusted, open: dialog.open,
                        sameTitle: document.getElementById('historyDialogTitle').textContent === nextTitle,
                        sameFocus: document.activeElement === nextActive
                    }), { once: true });
                    dialog.close();
                    second.focus();
                    second.click();
                    nextTitle = document.getElementById('historyDialogTitle').textContent;
                    nextActive = document.activeElement;
                }));
                assert.deepEqual(evidence, { trusted: true, open: true, sameTitle: true, sameFocus: true },
                    'an old native close event must not disrupt a newly opened session');
                await page.evaluate(() => {
                    const dialog = document.getElementById('historyDialog');
                    window.__bankClosed = new Promise(resolve => dialog.addEventListener('close',
                        event => resolve({ trusted: event.isTrusted, open: dialog.open, active: document.activeElement?.dataset.closeProbe }),
                        { once: true }));
                });
                await page.keyboard.press('Escape');
                assert.deepEqual(await page.evaluate(() => window.__bankClosed),
                    { trusted: true, open: false, active: 'second' },
                    'the new session must return focus to its own trigger');
            }
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ label: 'bank-dialog-close-order', browser: name, scenario, evidence, status: 'passed' }));
        } catch (error) {
            failures.push({ scenario, message: error.message });
            console.error(JSON.stringify({ label: 'bank-dialog-close-order', browser: name, scenario, status: 'failed', message: error.message }));
        } finally { await context.close(); }
    }
    assert.deepEqual(failures, [], 'bank dialog close-order regressions');
} finally { await browser.close(); }
