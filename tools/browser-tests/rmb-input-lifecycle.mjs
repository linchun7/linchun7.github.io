import assert from 'node:assert/strict';

async function state(page) {
    return page.locator('#inputmoney').evaluate(input => {
        const result = document.getElementById('result1');
        return {
            value: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
            direction: input.selectionDirection,
            focus: document.activeElement === input,
            output: result.textContent,
            empty: result.classList.contains('empty'),
            error: result.classList.contains('error')
        };
    });
}

async function assertSource(page, value, start, end = start) {
    const actual = await state(page);
    assert.equal(actual.value, value, 'editable source is preserved literally');
    assert.equal(actual.start, start, 'caret/selection start is preserved');
    assert.equal(actual.end, end, 'caret/selection end is preserved');
    assert.equal(actual.focus, true);
}

async function assertMoney(page, expected) {
    const actual = await state(page);
    assert.equal(actual.output, expected);
    assert.equal(actual.error, false);
    assert.equal(actual.empty, false);
}

export async function checkRmbInputLifecycle(check, browserName) {
    await check('RMB full-width middle insertion preserves caret and next edit', 'rmb_converter', async page => {
        await page.fill('#inputmoney', '1234.56');
        await page.locator('#inputmoney').evaluate(input => input.setSelectionRange(2, 2));
        await page.keyboard.insertText('９');
        console.log('RMB middle evidence ' + browserName + ': ' + JSON.stringify(await state(page)));
        await assertSource(page, '12９34.56', 3);
        await assertMoney(page, '人民币壹万贰仟玖佰叁拾肆元伍角陆分');
        await page.keyboard.type('8');
        await assertSource(page, '12９834.56', 4);
        await assertMoney(page, '人民币壹拾贰万玖仟捌佰叁拾肆元伍角陆分');
    });

    await check('RMB selection replacement preserves raw suffix and caret', 'rmb_converter', async page => {
        await page.fill('#inputmoney', '1234.56');
        await page.locator('#inputmoney').evaluate(input => input.setSelectionRange(2, 4, 'backward'));
        await page.keyboard.insertText('９');
        console.log('RMB replacement evidence ' + browserName + ': ' + JSON.stringify(await state(page)));
        await assertSource(page, '12９.56', 3);
        await assertMoney(page, '人民币壹佰贰拾玖元伍角陆分');
        await page.keyboard.press('Backspace');
        await assertSource(page, '12.56', 2);
        await assertMoney(page, '人民币壹拾贰元伍角陆分');
    });

    for (const [label, inserted, output] of [
        ['ASCII', '123.45', '人民币壹佰贰拾叁元肆角伍分'],
        ['full-width', '１２３．４５', '人民币壹佰贰拾叁元肆角伍分']
    ]) {
        await check('RMB ' + label + ' native undo/redo round-trips three times', 'rmb_converter', async page => {
            await page.locator('#inputmoney').focus();
            // A single trusted browser insertion defines one native edit transaction.
            // No value assignment, synthetic history event, or app-owned history is used.
            await page.keyboard.insertText(inserted);
            const samples = [{ phase: 'insert', ...(await state(page)) }];
            for (let cycle = 0; cycle < 3; cycle++) {
                await page.keyboard.press('Control+z');
                samples.push({ phase: 'undo', ...(await state(page)) });
                await page.keyboard.press('Control+Shift+z');
                samples.push({ phase: 'redo', ...(await state(page)) });
            }
            console.log('RMB history evidence ' + browserName + ' ' + label + ': ' + JSON.stringify(samples));
            for (const sample of samples) {
                const undo = sample.phase === 'undo';
                assert.equal(sample.value, undo ? '' : inserted, sample.phase + ' restores the exact source once');
                assert.equal(sample.output, undo ? '等待输入金额。' : output);
                assert.equal(sample.empty, undo);
                assert.equal(sample.error, false);
                assert.equal(sample.focus, true);
                if (!undo) assert.deepEqual([sample.start, sample.end], [inserted.length, inserted.length]);
            }
        });
    }

    await check('RMB native selection replacement and deletion undo/redo preserve amounts', 'rmb_converter', async page => {
        await page.locator('#inputmoney').focus();
        await page.keyboard.insertText('1234.56');
        await page.keyboard.press('Home');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.press('Shift+ArrowRight');
        await page.keyboard.insertText('９');
        const samples = [{ phase: 'replace', ...(await state(page)) }];
        for (let cycle = 0; cycle < 3; cycle++) {
            await page.keyboard.press('Control+z');
            samples.push({ phase: 'undo', ...(await state(page)) });
            await page.keyboard.press('Control+Shift+z');
            samples.push({ phase: 'redo', ...(await state(page)) });
        }
        console.log('RMB replacement history evidence ' + browserName + ': ' + JSON.stringify(samples));
        for (const sample of samples) {
            const undo = sample.phase === 'undo';
            assert.equal(sample.value, undo ? '1234.56' : '12９.56', sample.phase);
            assert.equal(sample.output, undo ? '人民币壹仟贰佰叁拾肆元伍角陆分' : '人民币壹佰贰拾玖元伍角陆分');
            assert.equal(sample.error, false);
        }
        await page.keyboard.press('Home');
        await page.keyboard.press('Shift+End');
        await page.keyboard.press('Backspace');
        assert.equal(await page.inputValue('#inputmoney'), '');
        assert.equal((await state(page)).empty, true);
        await page.keyboard.press('Control+z');
        assert.equal(await page.inputValue('#inputmoney'), '12９.56');
        await assertMoney(page, '人民币壹佰贰拾玖元伍角陆分');
        await page.keyboard.press('Control+Shift+z');
        assert.equal(await page.inputValue('#inputmoney'), '');
        assert.equal((await state(page)).empty, true);
    });

    await check('RMB modeled post-paste processing preserves backward selection and focus', 'rmb_converter', async page => {
        // Models a post-paste input event; this is not an OS clipboard or native paste test.
        await page.locator('#copyBtn').focus();
        await page.locator('#inputmoney').evaluate(input => {
            input.value = '　１２３．４５　';
            input.setSelectionRange(2, 6, 'backward');
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' }));
        });
        const actual = await state(page);
        assert.equal(actual.value, '　１２３．４５　');
        assert.deepEqual([actual.start, actual.end, actual.direction], [2, 6, 'backward']);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'copyBtn');
        await assertMoney(page, '人民币壹佰贰拾叁元肆角伍分');
    });

    await check('RMB modeled IME commits raw text and converts only after composition', 'rmb_converter', async page => {
        // Synthetic composition contract only; no claim of real OS IME coverage.
        await page.fill('#inputmoney', '1234.56');
        await page.locator('#inputmoney').evaluate(input => {
            input.setSelectionRange(2, 2);
            input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            input.setRangeText('９', 2, 2, 'end');
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertCompositionText', isComposing: true }));
        });
        await assertSource(page, '12９34.56', 3);
        await assertMoney(page, '人民币壹仟贰佰叁拾肆元伍角陆分');
        await page.locator('#inputmoney').evaluate(input => {
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '９' }));
            input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '９', inputType: 'insertText' }));
        });
        await assertSource(page, '12９34.56', 3);
        await assertMoney(page, '人民币壹万贰仟玖佰叁拾肆元伍角陆分');
        await page.keyboard.type('8');
        await assertSource(page, '12９834.56', 4);
    });

    await check('RMB NFKC calculation retains signs science precision zero and literal source', 'rmb_converter', async page => {
        const cases = [
            ['　１２３．４５　', '123.45'],
            ['－１２３．４５', '-123.45'],
            ['＋１．２３ｅ２', '123'],
            ['１２３００Ｅ－２', '123'],
            ['．５', '0.5'],
            ['１．２３００', '1.23'],
            ['－０．００', '0'],
            ['０ｅ９９', '0'],
            ['⑩', '10']
        ];
        for (const [raw, normalized] of cases) {
            const expected = await page.evaluate(value => Nzh.cn.toMoney(value), normalized);
            await page.fill('#inputmoney', raw);
            assert.equal(await page.inputValue('#inputmoney'), raw);
            await assertMoney(page, expected);
        }
        for (const [raw, message] of [
            ['１．２３９', '两位小数'],
            ['１ｅ－３', '两位小数'],
            ['１万元', '有效数字'],
            ['１２３abc４５６', '有效数字'],
            ['１ｅ１０００００００００', '金额过长'],
            ['１ｅ－１０００００００００', '金额过长'],
            ['９'.repeat(2001), '金额过长']
        ]) {
            await page.fill('#inputmoney', raw);
            assert.equal(await page.inputValue('#inputmoney'), raw);
            assert.equal((await state(page)).error, true);
            assert.ok((await state(page)).output.includes(message));
        }
        await page.fill('#inputmoney', '　');
        assert.equal(await page.inputValue('#inputmoney'), '　');
        assert.equal((await state(page)).empty, true);
        await page.fill('#inputmoney', '１２３．４５');
        await assertMoney(page, '人民币壹佰贰拾叁元肆角伍分');
    });

    await check('RMB full-width result copies normalized money and clear restores focus', 'rmb_converter', async page => {
        await page.fill('#inputmoney', '１２３．４５');
        await page.evaluate(() => {
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText: async text => { window.__rmbCopied = text; } }
            });
        });
        await page.click('#copyBtn');
        await page.waitForFunction(() => document.getElementById('alertText').textContent === '已复制');
        assert.equal(await page.evaluate(() => window.__rmbCopied), '人民币壹佰贰拾叁元肆角伍分');
        assert.equal(await page.inputValue('#inputmoney'), '１２３．４５');
        await page.click('#clearBtn');
        await assertSource(page, '', 0);
        assert.equal((await state(page)).empty, true);
        await page.keyboard.insertText('１２３．４５');
        await assertSource(page, '１２３．４５', 6);
        await assertMoney(page, '人民币壹佰贰拾叁元肆角伍分');
    });
}
