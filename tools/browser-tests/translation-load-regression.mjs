import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const messages = {
    "en": "Samples have not loaded yet. If they do not appear, reload this page to try again.",
    "ja": "サンプルはまだ読み込まれていません。表示されない場合は、ページを再読み込みしてください。",
    "ko": "샘플이 아직 표시되지 않았습니다. 계속 표시되지 않으면 페이지를 새로고침해 주세요.",
    "fr": "Les exemples ne sont pas encore chargés. S’ils ne s’affichent pas, rechargez cette page.",
    "de": "Die Beispiele sind noch nicht geladen. Falls sie nicht erscheinen, laden Sie diese Seite neu.",
    "es": "Las muestras aún no se han cargado. Si no aparecen, vuelve a cargar esta página."
};
const browser = await browserType.launch({ headless: true });
const failures = [];
try {
    for (const [language, message] of Object.entries(messages)) {
        const url = `${baseUrl}/tools/translation_benchmark/${language}.html`;
        const context = await browser.newContext();
        try {
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const scriptPattern = '**/tools/translation_benchmark/script.js*';
            await page.route(scriptPattern, route => route.abort());
            await page.goto(url, { waitUntil: 'load' });
            assert.equal(await page.locator('html').getAttribute('lang'), language);
            assert.equal(await page.locator('.sample-item').count(), 0);
            const status = page.locator('#categoryList .corpus-load-status');
            assert.equal(await status.count(), 1, `${language}: failed script must not leave a silent blank corpus`);
            assert.equal(await status.isVisible(), true, language);
            assert.equal((await status.textContent()).trim(), message, language);

            await page.unroute(scriptPattern);
            await page.reload({ waitUntil: 'load' });
            assert.equal(await page.locator('.category-section').count(), 16, language);
            assert.equal(await page.locator('.sample-item').count(), 48, language);
            assert.equal(await status.count(), 0, `${language}: successful rendering replaces the fallback`);
            const counts = await page.locator('.category-section').evaluateAll(
                sections => sections.map(section => section.querySelectorAll('.sample-item').length)
            );
            assert.deepEqual(counts, Array(16).fill(3), language);
            assert.deepEqual(errors, [], language);
        } catch (error) {
            failures.push({ language, scenario: 'failed-script-and-reload', message: error.message });
            console.error(JSON.stringify({ label: 'translation-load', browser: browserName, language, scenario: 'failed-script-and-reload', status: 'failed', message: error.message }));
        } finally {
            await context.close();
        }

        const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
        try {
            const noScriptPage = await noScriptContext.newPage();
            await noScriptPage.goto(url, { waitUntil: 'load' });
            assert.equal(
                (await noScriptPage.locator('#categoryList .corpus-load-status').textContent()).trim(),
                message,
                `${language}: fallback must not depend on script execution`
            );
        } catch (error) {
            failures.push({ language, scenario: 'javascript-disabled', message: error.message });
            console.error(JSON.stringify({ label: 'translation-load', browser: browserName, language, scenario: 'javascript-disabled', status: 'failed', message: error.message }));
        } finally {
            await noScriptContext.close();
        }
    }
    assert.deepEqual(failures, [], 'translation corpus-load regressions');
    console.log(`Translation corpus load regression passed (${browserName}).`);
} finally {
    await browser.close();
}
