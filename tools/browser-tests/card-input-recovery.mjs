import assert from 'node:assert/strict';

export async function checkCardInputRecovery(browser, baseUrl, browserName) {
    const failures = [];
    for (const tool of ['card_number', 'card_number_new']) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.route('**/googletagmanager.com/**', route => route.abort());
        try {
            await page.goto(`${baseUrl}/tools/${tool}/`, { waitUntil: 'domcontentloaded' });
            for (const [name, inserted, expected, caret] of [
                ['full-width middle insertion', '９', '12934', 3],
                ['unsupported middle insertion', '?', '1234', 2],
                ['whitespace middle insertion', '  ', '12 34', 3]
            ]) {
                await page.fill('#inputField', '1234');
                await page.locator('#inputField').evaluate(input => { input.focus(); input.setSelectionRange(2, 2); });
                await page.keyboard.insertText(inserted);
                const state = await page.locator('#inputField').evaluate(input => ({
                    value: input.value, start: input.selectionStart, end: input.selectionEnd,
                    focus: document.activeElement === input
                }));
                console.log(`INPUT-RECOVERY ${browserName} ${tool} ${name}: ${JSON.stringify(state)}`);
                try {
                    assert.deepEqual(state, { value: expected, start: caret, end: caret, focus: true });
                } catch (error) {
                    failures.push(`${tool} ${name}: ${error.message}`);
                }
            }
            await page.fill('#inputField', '');
            await page.keyboard.type('12');
            await page.keyboard.insertText('９');
            console.log(`INPUT-HISTORY ${browserName} ${tool} before undo: ${await page.inputValue('#inputField')}`);
            await page.keyboard.press('Control+z');
            console.log(`INPUT-HISTORY ${browserName} ${tool} after undo: ${await page.inputValue('#inputField')}`);
            await page.keyboard.press('Control+Shift+z');
            console.log(`INPUT-HISTORY ${browserName} ${tool} after redo: ${await page.inputValue('#inputField')}`);
        } finally {
            await context.close();
        }
    }
    assert.deepEqual(failures, [], 'card input recovery regressions');
}
