import assert from 'node:assert/strict';

async function state(page) {
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

async function assertInput(page, value, start, end = start) {
    const actual = await state(page);
    assert.equal(actual.value, value, 'the editable source is preserved exactly');
    assert.equal(actual.start, start);
    assert.equal(actual.end, end);
    assert.equal(actual.focus, true);
}

async function done(page) {
    await page.waitForFunction(() => document.getElementById('status-bar').textContent.includes('计算完成') && document.getElementById('stopBtn').hidden);
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
            for (const [name, inserted, count] of [
                ['ASCII', '9', 5],
                ['full-width', '９', 5],
                ['unsupported and supplementary characters', '?🙂', 4],
                ['repeated whitespace', '  ', 4],
                ['NFKC expansion', '⑩', 6]
            ]) {
                await check(`${name} middle edits keep source, caret and calculation count`, async () => {
                    await editAt(page, '1234', 2);
                    await page.keyboard.insertText(inserted);
                    await assertInput(page, '12' + inserted + '34', 2 + inserted.length);
                    assert.equal(await page.locator('#validCount').textContent(), String(count));
                    await page.keyboard.type('8');
                    await assertInput(page, '12' + inserted + '834', 3 + inserted.length);
                    assert.equal(await page.locator('#validCount').textContent(), String(count + 1));
                });
            }

            await check('selection replacement preserves the literal replacement and suffix', async () => {
                await editAt(page, '123456', 2, 4, 'backward');
                await page.keyboard.insertText('９?');
                await assertInput(page, '12９?56', 4);
                await page.keyboard.type('8');
                await assertInput(page, '12９?856', 5);
                assert.equal(await page.locator('#validCount').textContent(), '6');
            });

            await check('modeled post-paste event never rewrites source or backward selection', async () => {
                // This models the post-paste handler contract, not an OS clipboard.
                await page.locator('#inputField').evaluate(input => {
                    input.focus();
                    input.value = '１２?  ３４';
                    input.setSelectionRange(2, 6, 'backward');
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: '１２?  ３４' }));
                });
                await assertInput(page, '１２?  ３４', 2, 6);
                assert.equal((await state(page)).direction, 'backward');
                assert.equal(await page.locator('#validCount').textContent(), '4');
                await page.keyboard.insertText('９');
                await assertInput(page, '１２９４', 3);
            });

            await check('input processing never steals another control focus', async () => {
                const button = legacy ? '#generateButton' : '#calcBtn';
                await page.locator(button).focus();
                await page.locator('#inputField').evaluate(input => {
                    input.value = '１２?３４';
                    input.setSelectionRange(2, 3);
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
                });
                assert.equal(await page.inputValue('#inputField'), '１２?３４');
                assert.equal(await page.evaluate(() => document.activeElement.id), button.slice(1));
                assert.deepEqual(await page.locator('#inputField').evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 3]);
            });

            await check('modeled IME commitment preserves source and does not submit confirmation Enter', async () => {
                await editAt(page, '1234', 2);
                await page.locator('#inputField').evaluate(input => {
                    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                    input.setRangeText('９', 2, 2, 'end');
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertCompositionText', isComposing: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229, bubbles: true }));
                });
                await assertInput(page, '12９34', 3);
                assert.equal(await page.locator('#inputField').isDisabled(), false);
                assert.equal(await page.locator('#validCount').textContent(), '4');
                await page.locator('#inputField').evaluate(input => {
                    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '９' }));
                    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertText' }));
                });
                await assertInput(page, '12９34', 3);
                assert.equal(await page.locator('#validCount').textContent(), '5');
                await page.keyboard.type('8');
                await assertInput(page, '12９834', 4);
                if (!legacy) assert.equal(await page.locator('#status-bar').isVisible(), false);
            });

            for (const [name, inserted, count] of [
                ['ASCII', '7', 1],
                ['full-width', '９', 1],
                ['unsupported characters', '?🙂', 0],
                ['whitespace', '  ', 0]
            ]) {
                await check(`${name} native undo and redo round-trip three times without duplication`, async () => {
                    await page.locator('#inputField').focus();
                    // One native insertion from an empty page gives a defined
                    // transaction without assuming how multiple keypresses coalesce.
                    await page.keyboard.insertText(inserted);
                    assert.equal(await page.inputValue('#inputField'), inserted);
                    for (let cycle = 0; cycle < 3; cycle++) {
                        await page.keyboard.press('Control+z');
                        assert.equal(await page.inputValue('#inputField'), '', 'undo restores the exact source');
                        assert.equal(await page.locator('#validCount').textContent(), '0');
                        await page.keyboard.press('Control+Shift+z');
                        assert.equal(await page.inputValue('#inputField'), inserted, 'redo restores one literal insertion');
                        assert.equal(await page.locator('#validCount').textContent(), String(count));
                    }
                });
            }

            await check('native selection replacement and deletion undo and redo accurately', async () => {
                await page.locator('#inputField').focus();
                await page.keyboard.insertText('123456');
                await page.keyboard.press('Home');
                await page.keyboard.press('ArrowRight');
                await page.keyboard.press('ArrowRight');
                await page.keyboard.press('Shift+ArrowRight');
                await page.keyboard.press('Shift+ArrowRight');
                await page.keyboard.insertText('９? ');
                assert.equal(await page.inputValue('#inputField'), '12９? 56');
                for (let cycle = 0; cycle < 3; cycle++) {
                    await page.keyboard.press('Control+z');
                    assert.equal(await page.inputValue('#inputField'), '123456');
                    await page.keyboard.press('Control+Shift+z');
                    assert.equal(await page.inputValue('#inputField'), '12９? 56');
                }
                await page.keyboard.press('Home');
                await page.keyboard.press('Shift+End');
                await page.keyboard.press('Backspace');
                assert.equal(await page.inputValue('#inputField'), '');
                await page.keyboard.press('Control+z');
                assert.equal(await page.inputValue('#inputField'), '12９? 56');
                await page.keyboard.press('Control+Shift+z');
                assert.equal(await page.inputValue('#inputField'), '');
            });

            await check('clear and keyboard generation use the normalized calculation snapshot', async () => {
                await page.fill('#inputField', '７９９２７３９８７１＊?');
                await page.locator(legacy ? '#generateButton' : '#clearBtn').focus();
                await page.keyboard.press('Enter');
                await assertInput(page, '', 0);
                assert.equal(await page.locator('#validCount').textContent(), '0');
                await page.keyboard.insertText('７９９２　７３９８?７１３');
                await assertInput(page, '７９９２　７３９８?７１３', 13);
                assert.equal(await page.locator('#validCount').textContent(), '11');
                if (legacy) {
                    assert.equal(await page.locator('#count').textContent(), '1');
                    assert.equal((await page.locator('#result').textContent()).trim(), '7992 7398 713');
                } else {
                    await page.keyboard.press('Enter');
                    await done(page);
                    assert.equal(await page.locator('#resultCount').textContent(), '1');
                    assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');
                    assert.equal(await page.inputValue('#inputField'), '７９９２　７３９８?７１３');
                }
            });


            if (!legacy) {
                await check('copy and CSV retain the normalized result snapshot after raw input changes', async () => {
                    await page.fill('#inputField', '７９９２７３９８７１＊?');
                    await page.click('#calcBtn');
                    await done(page);
                    assert.equal(await page.locator('.result-row').getAttribute('data-clipboard'), '79927398713');
                    await page.fill('#inputField', '１２**');
                    await page.evaluate(() => {
                        window.__cardCopies = [];
                        Object.defineProperty(navigator, 'clipboard', {
                            configurable: true,
                            value: { writeText: async text => { window.__cardCopies.push(text); } }
                        });
                    });
                    await page.locator('.result-row').focus();
                    await page.keyboard.press('Enter');
                    await page.waitForFunction(() => window.__cardCopies.length === 1);
                    assert.equal(await page.evaluate(() => window.__cardCopies[0]), '79927398713');
                    await page.click('#copyPageBtn');
                    await page.waitForFunction(() => window.__cardCopies.length === 2);
                    assert.match(await page.evaluate(() => window.__cardCopies[1]), /^7992 7398 713/);
                    const downloadPromise = page.waitForEvent('download');
                    await page.click('#downloadBtn');
                    const download = await downloadPromise;
                    const stream = await download.createReadStream();
                    const parts = [];
                    for await (const part of stream) parts.push(part);
                    const csv = Buffer.concat(parts).toString('utf8');
                    assert.match(csv, /7992 7398 713/);
                    assert.doesNotMatch(csv, /[０-９＊?]/);
                    assert.equal(await page.inputValue('#inputField'), '１２**');
                });
            }

            await check('length policies leave the source intact and recover hidden tail edits', async () => {
                await page.fill('#inputField', '0'.repeat(100));
                await page.locator('#inputField').evaluate(input => input.setSelectionRange(50, 50));
                await page.keyboard.insertText('１');
                const raw = '0'.repeat(50) + '１' + '0'.repeat(50);
                await assertInput(page, raw, 51);
                if (legacy) {
                    assert.equal(await page.locator('#validCount').textContent(), '101');
                    assert.equal(await page.locator('#inputField').getAttribute('aria-invalid'), 'true');
                    assert.match(await page.locator('#count').textContent(), /100/);
                } else {
                    assert.equal(await page.locator('#validCount').textContent(), '100');
                    assert.match(await page.locator('#lenWarning').textContent(), /前 100/);
                    assert.match(await page.locator('#lenWarning').textContent(), /原输入/);
                    await page.keyboard.press('Home');
                    await page.keyboard.press('Delete');
                    assert.equal((await page.inputValue('#inputField')).length, 100, 'the original tail was never discarded');
                    assert.equal(await page.locator('#validCount').textContent(), '100');
                    assert.doesNotMatch(await page.locator('#lenWarning').textContent(), /前 100/);
                }
                await page.fill('#inputField', '７９９２７３９８７１３');
                assert.equal(await page.inputValue('#inputField'), '７９９２７３９８７１３');
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
