import assert from 'node:assert/strict';

async function selection(page) {
    return page.locator('#inputField').evaluate(input => ({
        value: input.value,
        start: input.selectionStart,
        end: input.selectionEnd,
        direction: input.selectionDirection,
        focus: document.activeElement === input
    }));
}

async function editAt(page, value, start, end = start, direction = 'none') {
    await page.fill('#inputField', value);
    await page.locator('#inputField').evaluate((input, range) => {
        input.focus();
        input.setSelectionRange(...range);
    }, [start, end, direction]);
}

async function assertCaret(page, value, start, end = start) {
    const actual = await selection(page);
    assert.equal(actual.value, value);
    assert.equal(actual.start, start, 'selection start follows the normalized prefix');
    assert.equal(actual.end, end, 'selection end follows the normalized prefix');
    assert.equal(actual.focus, true, 'normalization keeps input focus');
}

export async function checkCardInputRecovery(browser, baseUrl, browserName) {
    const failures = [];
    let passed = 0;
    for (const tool of ['card_number', 'card_number_new']) {
        const legacy = tool === 'card_number';
        const context = await browser.newContext();
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await page.route('**/googletagmanager.com/**', route => route.abort());

        async function check(name, run) {
            const errors = [];
            const recordError = error => errors.push(error.message);
            page.on('pageerror', recordError);
            try {
                await page.goto(`${baseUrl}/tools/${tool}/`, { waitUntil: 'domcontentloaded' });
                await run();
                assert.deepEqual(errors, [], 'no unhandled page errors');
                passed++;
                console.log(`PASS input-recovery ${browserName} ${tool}: ${name}`);
            } catch (error) {
                failures.push(`${tool} ${name}: ${error.message}`);
                console.error(`FAIL input-recovery ${browserName} ${tool}: ${name}: ${error.stack}`);
            } finally {
                page.off('pageerror', recordError);
            }
        }

        try {
            for (const [name, inserted, expected, caret] of [
                ['ASCII middle insertion', '9', '12934', 3],
                ['full-width middle insertion', '９', '12934', 3],
                ['unsupported middle insertion', '?🙂', '1234', 2],
                ['collapsed middle whitespace', '  ', '12 34', 3],
                ['NFKC expansion before the caret', '⑩', '121034', 4]
            ]) {
                await check(name, async () => {
                    await editAt(page, '1234', 2);
                    await page.keyboard.insertText(inserted);
                    await assertCaret(page, expected, caret);
                    await page.keyboard.press('Backspace');
                    assert.equal(await page.locator('#inputField').evaluate(input => input.selectionStart), Math.max(0, caret - 1));
                });
            }
            await check('selection replacement normalizes without losing the suffix', async () => {
                await editAt(page, '123456', 2, 4, 'backward');
                await page.keyboard.insertText('９?');
                await assertCaret(page, '12956', 3);
                await page.keyboard.type('8');
                await assertCaret(page, '129856', 4);
                assert.equal(await page.locator('#validCount').textContent(), '6');
            });

            await check('paste input contract preserves a backward selection', async () => {
                // Clipboard APIs are not portable across all three engines. Model
                // the post-paste input event, including a live selection, explicitly.
                await page.locator('#inputField').evaluate(input => {
                    input.focus();
                    input.value = '１２?  ３４';
                    input.setSelectionRange(2, 6, 'backward');
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: '１２?  ３４' }));
                });
                await assertCaret(page, '12 34', 2, 4);
                assert.equal((await selection(page)).direction, 'backward');
                await page.keyboard.insertText('９');
                await assertCaret(page, '1294', 3);
            });

            await check('normalization does not steal focus from another control', async () => {
                const button = legacy ? '#generateButton' : '#calcBtn';
                await page.locator(button).focus();
                await page.locator('#inputField').evaluate(input => {
                    input.value = '１２?３４';
                    input.setSelectionRange(2, 3);
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
                });
                assert.equal(await page.inputValue('#inputField'), '1234');
                assert.equal(await page.evaluate(() => document.activeElement.id), button.slice(1));
                assert.deepEqual(await page.locator('#inputField').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 2]);
            });

            await check('IME waits for commitment and preserves a middle caret', async () => {
                await editAt(page, '1234', 2);
                await page.locator('#inputField').evaluate(input => {
                    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                    input.setRangeText('９', 2, 2, 'end');
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertCompositionText', isComposing: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
                });
                await assertCaret(page, '12９34', 3);
                assert.equal(await page.locator('#inputField').isDisabled(), false);
                assert.equal(await page.locator('#validCount').textContent(), '4');
                await page.locator('#inputField').evaluate(input => {
                    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '９' }));
                    // Some engines also deliver a final non-composing input.
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertText' }));
                });
                await assertCaret(page, '12934', 3);
                assert.equal(await page.locator('#validCount').textContent(), '5');
                await page.keyboard.type('8');
                await assertCaret(page, '129834', 4);
                if (!legacy) assert.equal(await page.locator('#status-bar').isVisible(), false, 'IME confirmation must not start a calculation');
            });

            await check('a native ASCII edit can be undone and redone', async () => {
                await page.locator('#inputField').focus();
                await page.keyboard.type('7');
                await page.keyboard.press('Control+z');
                assert.equal(await page.inputValue('#inputField'), '');
                await page.keyboard.press('Control+Shift+z');
                assert.equal(await page.inputValue('#inputField'), '7');
                assert.equal(await page.locator('#validCount').textContent(), '1');
            });

            await check('history around normalized input stays editable', async () => {
                await page.locator('#inputField').focus();
                await page.keyboard.type('12');
                await page.keyboard.insertText('９');
                await page.keyboard.press('Control+z');
                const undone = await page.inputValue('#inputField');
                await page.keyboard.press('Control+Shift+z');
                const redone = await page.inputValue('#inputField');
                console.log(`INPUT-HISTORY ${browserName} ${tool}: ${JSON.stringify({ undone, redone })}`);
                assert.match(undone, /^[a-zA-Z0-9* ]*$/);
                assert.match(redone, /^[a-zA-Z0-9* ]*$/);
                assert.equal(await page.locator('#validCount').textContent(), String(redone.replace(/ /g, '').length));
                await editAt(page, redone, Math.min(1, redone.length));
                await page.keyboard.type('8');
                assert.equal(await page.locator('#inputField').evaluate(input => input.selectionStart), Math.min(1, redone.length) + 1);
            });

            await check('clear restores an empty focused and usable input', async () => {
                await page.fill('#inputField', '７９９２７３９８７１＊?');
                await page.locator(legacy ? '#generateButton' : '#clearBtn').focus();
                await page.keyboard.press('Enter');
                await assertCaret(page, '', 0);
                assert.equal(await page.locator('#validCount').textContent(), '0');
                await page.keyboard.insertText('７９９２７３９８７１３');
                await assertCaret(page, '79927398713', 11);
                if (legacy) {
                    assert.equal(await page.locator('#count').textContent(), '1');
                } else {
                    await page.keyboard.press('Enter');
                    await page.waitForFunction(() => document.getElementById('status-bar').textContent.includes('计算完成') && document.getElementById('stopBtn').hidden);
                    assert.equal(await page.locator('#resultCount').textContent(), '1');
                }
            });

            await check('length boundary keeps the existing truncation policy and recovers', async () => {
                await page.fill('#inputField', '0'.repeat(100));
                await page.locator('#inputField').evaluate(input => input.setSelectionRange(50, 50));
                await page.keyboard.insertText('１');
                if (legacy) {
                    await assertCaret(page, '0'.repeat(50) + '1' + '0'.repeat(50), 51);
                    assert.equal(await page.locator('#inputField').getAttribute('aria-invalid'), 'true');
                    assert.match(await page.locator('#count').textContent(), /100/);
                } else {
                    await assertCaret(page, '0'.repeat(50) + '1' + '0'.repeat(49), 51);
                    assert.match(await page.locator('#toast').textContent(), /100/);
                }
                await page.fill('#inputField', '７９９２７３９８７１３');
                assert.equal(await page.locator('#inputField').getAttribute('aria-invalid'), 'false');
                assert.equal(await page.locator('#validCount').textContent(), '11');
                if (legacy) assert.equal(await page.locator('#count').textContent(), '1');
            });
        } finally {
            await context.close();
        }
    }
    console.log(`Card input recovery (${browserName}): ${passed} passed, ${failures.length} failed.`);
    assert.deepEqual(failures, [], 'card input recovery regressions');
}
