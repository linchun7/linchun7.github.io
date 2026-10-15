import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, firefox, webkit } from 'playwright';

const name = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const type = { chromium, firefox, webkit }[name];
if (!type) throw new Error(`Unsupported browser: ${name}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const data = JSON.parse(await readFile(new URL('../hospital_rank/data/rankings.json', import.meta.url), 'utf8'));
const histories = new Map();
for (const block of data.years) for (const record of block.records) {
    const history = histories.get(record.hospitalId) || [];
    history.push(block.year);
    histories.set(record.hospitalId, history);
}
const hospital = data.hospitals.find(item => histories.get(item.id)?.length === 1);
assert.ok(hospital, 'fixture needs a real hospital with a one-year history');
const year = String(histories.get(hospital.id)[0]);
const cases = [
    ['mobile', 'blank-mouse'],
    ['mobile', 'blank-touch'],
    ...['desktop', 'mobile'].flatMap(view => [
        [view, 'interior-clicks'],
        [view, 'backdrop-click'],
        [view, 'drag-inside-outside'],
        [view, 'drag-outside-inside'],
        [view, 'backdrop-drag-return']
    ]),
    ['mobile', 'backdrop-touch']
];
const browser = await type.launch({ headless: true });
const failures = [];
try {
    for (const [view, scenario] of cases) {
        const viewport = view === 'mobile' ? { width: 390, height: 844 } : { width: 1365, height: 900 };
        const context = await browser.newContext({ viewport, hasTouch: view === 'mobile' });
        try {
            await context.route('**/googletagmanager.com/**', route => route.abort());
            await context.route('**/google-analytics.com/**', route => route.abort());
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`${base}/tools/hospital_rank/`);
            await page.waitForFunction(() => !document.getElementById('yearSelect').disabled);
            await page.locator('#yearSelect').selectOption(year);
            await page.locator('#hospitalSearch').fill(hospital.name);
            await page.waitForFunction(id => {
                const buttons = [...document.querySelectorAll('.hospital-history-button')];
                return buttons.length === 1 && buttons[0].dataset.hospitalId === id;
            }, hospital.id);
            const trigger = page.locator('.hospital-history-button');
            await trigger.focus();
            await page.keyboard.press('Enter');
            await page.locator('#historyDialog').waitFor({ state: 'visible' });
            const points = await page.evaluate(() => {
                const dialog = document.getElementById('historyDialog');
                const shell = dialog.querySelector('.history-dialog-shell');
                const rect = dialog.getBoundingClientRect();
                const shellRect = shell.getBoundingClientRect();
                const text = dialog.querySelector('.dialog-history-year').getBoundingClientRect();
                const header = document.getElementById('historyDialogTitle').getBoundingClientRect();
                window.__hospitalPointerEvents = [];
                for (const eventName of ['pointerdown', 'pointerup', 'pointercancel', 'click']) {
                    dialog.addEventListener(eventName, event => {
                        window.__hospitalPointerEvents.push({
                            type: event.type, trusted: event.isTrusted,
                            targetIsDialog: event.target === dialog,
                            pointerType: event.pointerType || null,
                            x: event.clientX, y: event.clientY,
                            selection: window.getSelection()?.toString() || ''
                        });
                    }, true);
                }
                const blank = { x: rect.left + rect.width / 2, y: (shellRect.bottom + rect.bottom) / 2 };
                return {
                    inside: { x: text.left + text.width / 2, y: text.top + text.height / 2 },
                    header: { x: header.left + header.width / 2, y: header.top + header.height / 2 },
                    outside: { x: rect.left + rect.width / 2, y: Math.max(4, rect.top / 2) },
                    blank,
                    blankHeight: rect.bottom - shellRect.bottom,
                    blankIsDialog: document.elementFromPoint(blank.x, blank.y) === dialog,
                    dialogTop: rect.top
                };
            });
            assert.ok(points.dialogTop > 8, 'fixture must expose a real backdrop above the dialog');
            const click = point => page.mouse.click(point.x, point.y);
            const move = (point, steps = 1) => page.mouse.move(point.x, point.y, { steps });
            let shouldClose = false;
            if (scenario.startsWith('blank-')) {
                assert.ok(points.blankHeight > 40, `mobile short history must expose dialog-owned whitespace: ${JSON.stringify(points)}`);
                assert.equal(points.blankIsDialog, true, 'blank fixture must hit the dialog itself, not a child');
                if (scenario === 'blank-touch') await page.touchscreen.tap(points.blank.x, points.blank.y);
                else await click(points.blank);
            } else if (scenario === 'interior-clicks') {
                await click(points.header);
                await click(points.inside);
            } else if (scenario === 'backdrop-click' || scenario === 'backdrop-touch') {
                shouldClose = true;
                if (scenario === 'backdrop-touch') await page.touchscreen.tap(points.outside.x, points.outside.y);
                else await click(points.outside);
            } else {
                const start = scenario === 'drag-inside-outside' ? points.inside : points.outside;
                const end = scenario === 'drag-outside-inside' ? points.inside : points.outside;
                await move(start);
                await page.mouse.down();
                if (scenario === 'backdrop-drag-return') await move({ x: start.x + 40, y: start.y }, 6);
                await move(end, 12);
                await page.mouse.up();
            }
            const evidence = await page.evaluate(async () => {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return {
                    open: document.getElementById('historyDialog').open,
                    activeHospitalId: document.activeElement?.dataset.hospitalId || null,
                    events: window.__hospitalPointerEvents
                };
            });
            console.log(JSON.stringify({ label: 'hospital-dialog-pointer', browser: name, view, scenario, points, evidence }));
            assert.equal(evidence.open, !shouldClose,
                shouldClose ? 'a genuine backdrop click/tap must close history' : 'interior whitespace/content and drag gestures must keep history open');
            assert.ok(evidence.events.length > 0 && evidence.events.every(event => event.trusted), 'regression must use native pointer events');
            if (shouldClose) {
                assert.equal(evidence.activeHospitalId, hospital.id, 'backdrop dismissal must preserve native return focus');
                await page.keyboard.press('Enter');
                await page.locator('#historyDialog').waitFor({ state: 'visible' });
            }
            await page.keyboard.press('Escape');
            await page.locator('#historyDialog').waitFor({ state: 'hidden' });
            assert.equal(await trigger.evaluate(node => document.activeElement === node), true,
                'Escape must still return focus to the original hospital trigger');
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ label: 'hospital-dialog-pointer', browser: name, view, scenario, status: 'passed' }));
        } catch (error) {
            failures.push({ view, scenario, message: error.message });
            console.error(JSON.stringify({ label: 'hospital-dialog-pointer', browser: name, view, scenario, status: 'failed', message: error.message }));
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'hospital dialog pointer regressions');
} finally {
    await browser.close();
}
