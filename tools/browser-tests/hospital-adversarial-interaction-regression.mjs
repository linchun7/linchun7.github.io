import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const type = { chromium, firefox, webkit }[name];
if (!type) throw new Error(`Unsupported browser: ${name}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await type.launch({ headless: true });
const failures = [];

try {
    for (const scenario of ['pending-search-history-return', 'new-hospital-history-scroll']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 500 } });
        try {
            await context.route('**/googletagmanager.com/**', route => route.abort());
            await context.route('**/google-analytics.com/**', route => route.abort());
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${base}/tools/hospital_rank/`);
            await page.waitForSelector('.hospital-history-button');
            let evidence;

            if (scenario === 'pending-search-history-return') {
                await page.clock.install();
                const hospitalId = await page.evaluate(() => {
                    const initial = document.querySelector('.hospital-history-button');
                    const hospitalId = initial.dataset.hospitalId;
                    const search = document.getElementById('hospitalSearch');
                    search.value = initial.textContent.trim();
                    search.dispatchEvent(new Event('input', { bubbles: true }));
                    // Re-query after input so immediate-render implementations also work.
                    const trigger = [...document.querySelectorAll('.hospital-history-button')]
                        .find(node => node.dataset.hospitalId === hospitalId);
                    window.__hospitalPendingSearchTrigger = trigger;
                    trigger.focus();
                    trigger.click();
                    return hospitalId;
                });
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
                // Release the real application debounce without replacing dialog methods.
                await page.clock.fastForward(250);
                const beforeClose = await page.evaluate(() => ({
                    originalTriggerConnected: window.__hospitalPendingSearchTrigger.isConnected,
                    dialogOpen: document.getElementById('historyDialog').open,
                    rowCount: document.querySelectorAll('#hospitalList tr.data-row').length
                }));
                await page.keyboard.press('Escape');
                await page.locator('#historyDialog').waitFor({ state: 'hidden' });
                evidence = await page.evaluate(({ hospitalId, beforeClose }) => {
                    const active = document.activeElement;
                    return {
                        ...beforeClose,
                        activeTag: active?.tagName,
                        activeId: active?.id,
                        activeHospitalId: active?.dataset.hospitalId,
                        usefulReturnFocus: active === document.getElementById('hospitalSearch') ||
                            (active?.isConnected && active.matches('.hospital-history-button') &&
                                active.dataset.hospitalId === hospitalId)
                    };
                }, { hospitalId, beforeClose });
                console.log(JSON.stringify({ label: 'hospital-adversarial-interaction', browser: name, scenario, evidence }));
                assert.equal(evidence.usefulReturnFocus, true,
                    'closing history after a pending search must return focus to the current same-hospital button or search input');
            } else {
                await page.locator('.hospital-history-button').nth(0).focus();
                await page.keyboard.press('Enter');
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
                const firstTitle = await page.locator('#historyDialogTitle').innerText();
                const firstScroll = await page.locator('#historyDialogBody').evaluate(async body => {
                    body.scrollTop = body.scrollHeight;
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    return { top: body.scrollTop, height: body.scrollHeight, viewport: body.clientHeight };
                });
                assert.ok(firstScroll.top > 0, 'fixture must actually scroll the first hospital history');
                await page.keyboard.press('Escape');
                await page.locator('#historyDialog').waitFor({ state: 'hidden' });
                await page.locator('.hospital-history-button').nth(1).focus();
                await page.keyboard.press('Enter');
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
                const secondTitle = await page.locator('#historyDialogTitle').innerText();
                const secondScroll = await page.locator('#historyDialogBody').evaluate(async body => {
                    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                    return { top: body.scrollTop, height: body.scrollHeight, viewport: body.clientHeight };
                });
                evidence = { firstTitle, secondTitle, firstScroll, secondScroll };
                console.log(JSON.stringify({ label: 'hospital-adversarial-interaction', browser: name, scenario, evidence }));
                assert.notEqual(firstTitle, secondTitle, 'fixture must open a different hospital');
                assert.equal(secondScroll.top, 0,
                    'a different hospital history must start at its latest year, rather than inherit the previous scroll position');
            }
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ label: 'hospital-adversarial-interaction', browser: name, scenario, status: 'passed' }));
        } catch (error) {
            failures.push({ scenario, message: error.message });
            console.error(JSON.stringify({ label: 'hospital-adversarial-interaction', browser: name, scenario, status: 'failed', message: error.message }));
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'hospital adversarial interaction regressions');
} finally {
    await browser.close();
}
