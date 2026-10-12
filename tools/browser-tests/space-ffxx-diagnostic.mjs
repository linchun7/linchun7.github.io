import { resolve } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

// Place under tools/browser-tests; run from repository root. Read-only probe.
// Expected here expresses the candidate URL-preservation contract, not a
// pre-established defect. Output differences do not fail this diagnostic.
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const cases = [
  ['fullwidth-letter', 'https://example.com/Ａ中文ABC'],
  ['fullwidth-digits', 'https://example.com/１２中文ABC'],
  ['halfwidth-katakana', 'https://example.com/ｶﾀｶﾅ中文ABC'],
  ['angle-control', '<https://example.com/Ａ中文ABC>']
];
const browser = await browserType.launch({ headless: true });
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ status: 'infrastructure-error', reason: '30s global deadline' }));
  process.exit(2);
}, 30000);
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addScriptTag({ path: resolve('tools/space/spacing.js') });
  for (const [id, input] of cases) {
    const actual = await page.evaluate(text => window.spaceTextPreservingContent(text), input);
    if (typeof actual !== 'string') throw new Error('Non-string result: ' + id);
    console.log(JSON.stringify({
      id, browser: browserName, input, expected: input, actual,
      matchesCandidateContract: actual === input,
      inputCodePoints: Array.from(input, ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase()),
      actualCodePoints: Array.from(actual, ch => 'U+' + ch.codePointAt(0).toString(16).toUpperCase())
    }));
  }
  if (errors.length) throw new Error(errors.join('; '));
} catch (error) {
  console.error(JSON.stringify({ status: 'infrastructure-error', reason: error.message }));
  process.exitCode = 2;
} finally {
  await browser.close();
  clearTimeout(watchdog);
}
