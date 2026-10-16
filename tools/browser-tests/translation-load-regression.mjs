import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { isDeploymentTelemetryRequest, isDeploymentTelemetryScript } from './translation-deployment-telemetry.mjs';
import { CORPUS } from '../translation_benchmark/scripts/corpus.mjs';
import { LANGUAGES, escapeHtml, renderCorpus } from '../translation_benchmark/scripts/render-pages.mjs';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error('Unsupported browser: ' + browserName);
const baseUrl = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const browser = await browserType.launch({ headless: true });

async function assertCorpus(page, language) {
  assert.equal(await page.locator('html').getAttribute('lang'), language);
  assert.equal(await page.locator('body').getAttribute('data-language'), language);
  assert.equal(await page.locator('#categoryList').getAttribute('lang'), language);
  assert.equal(await page.locator('.category-section').count(), 16);
  assert.equal(await page.locator('.sample-item').count(), 48);
  assert.equal(await page.locator('.corpus-load-status').count(), 0);
  const scripts = await page.locator('script').evaluateAll(nodes => nodes.map(node => ({
    src: node.getAttribute('src') || '', text: node.textContent || '',
    beacon: node.hasAttribute('data-cf-beacon')
  })));
  assert.deepEqual(scripts.filter(script => !isDeploymentTelemetryScript(script, baseUrl)), [], 'no application or unknown scripts');
  assert.deepEqual(await page.locator('.category-header h2').allTextContents(), CORPUS[language].map(([title]) => title));
  assert.deepEqual(await page.locator('.sample-text').allTextContents(), CORPUS[language].flatMap(([, samples]) => samples));
  assert.deepEqual(await page.locator('.sample-index').allTextContents(), Array.from({ length: 48 }, (_, index) => String(index + 1).padStart(2, '0')));
  assert.deepEqual(await page.locator('.category-section').evaluateAll(sections => sections.map(section => section.querySelectorAll('.sample-item').length)), Array(16).fill(3));
  assert.deepEqual(await page.locator('.sample-list').evaluateAll(lists => lists.map(list => list.start)), Array.from({ length: 16 }, (_, index) => index * 3 + 1));
  assert.equal(await page.locator('.test-nav a[aria-current="page"]').getAttribute('href'), language + '.html');
  assert.equal(await page.locator('.test-nav a').count(), 6);
  assert.equal(await page.locator('.sample-text').first().isVisible(), true);
  const headings = await page.locator('.category-section').evaluateAll(sections => sections.every(section => {
    const heading = document.getElementById(section.getAttribute('aria-labelledby'));
    return heading?.tagName === 'H2' && section.contains(heading);
  }));
  assert.equal(headings, true, 'semantic category labels resolve');
  const layout = await page.evaluate(() => ({
    width: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    overflowing: [...document.querySelectorAll('body *')].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1).map(element => element.tagName + '.' + element.className).slice(0, 8)
  }));
  assert.ok(layout.scrollWidth <= layout.width, 'no horizontal overflow: ' + JSON.stringify(layout));
}

try {
  for (const language of LANGUAGES) {
    for (const mode of ['normal', 'javascript-disabled', 'scripts-blocked']) {
      const context = await browser.newContext({
        javaScriptEnabled: mode !== 'javascript-disabled',
        viewport: mode === 'normal' ? { width: 1280, height: 900 } : { width: 390, height: 844 }
      });
      try {
        const page = await context.newPage();
        const errors = [];
        const payloadRequests = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('request', request => {
          const type = request.resourceType();
          if (['script', 'xhr', 'fetch'].includes(type) && !isDeploymentTelemetryRequest(request.url(), baseUrl, type)) {
            payloadRequests.push(request.url());
          }
        });
        // Deployment analytics must neither become a corpus dependency nor make
        // these content checks depend on a third-party beacon being reachable.
        await page.route('**/*', route => {
          const request = route.request();
          const blocked = isDeploymentTelemetryRequest(request.url(), baseUrl, request.resourceType()) ||
            (mode === 'scripts-blocked' && request.resourceType() === 'script');
          return blocked ? route.abort() : route.continue();
        });
        const url = baseUrl + '/tools/translation_benchmark/' + language + '.html';
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        const initialHtml = await response.text();
        assert.equal((initialHtml.match(/class="sample-text"/g) ?? []).length, 48, 'all samples are present in the document response');
        assert.ok(Buffer.byteLength(initialHtml) < 30000, 'single-language HTML stays below 30 KB');
        for (const [, samples] of CORPUS[language]) {
          for (const sample of samples) assert.ok(initialHtml.includes(escapeHtml(sample)));
        }
        await assertCorpus(page, language);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await assertCorpus(page, language);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await assertCorpus(page, language);
        const next = LANGUAGES[(LANGUAGES.indexOf(language) + 1) % LANGUAGES.length];
        await Promise.all([
          page.waitForURL('**/' + next + '.html'),
          page.locator('.test-nav a[href="' + next + '.html"]').click()
        ]);
        await assertCorpus(page, next);
        await page.goBack({ waitUntil: 'domcontentloaded' });
        await assertCorpus(page, language);
        await page.goForward({ waitUntil: 'domcontentloaded' });
        await assertCorpus(page, next);
        assert.deepEqual(errors, [], language + ': ' + mode);
        assert.deepEqual(payloadRequests, [], 'no application script, corpus or translation API requests');
        console.log(JSON.stringify({ label: 'translation-prerender', browser: browserName, language, mode, samples: 48, status: 'passed' }));
      } finally {
        await context.close();
      }
    }
  }

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const groups = structuredClone(CORPUS.en);
    groups[0][0] = '<img src=x onerror="window.injected=true">';
    groups[0][1][0] = '</p><script>window.injected=true</script>& "\' 日本語';
    await page.route('**/translation-escape-fixture', route => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><html lang="en"><head><meta charset="UTF-8"></head><body>' + renderCorpus('en', groups) + '</body></html>'
    }));
    await page.goto(baseUrl + '/translation-escape-fixture', { waitUntil: 'load' });
    assert.equal(await page.locator('.category-header h2').first().textContent(), groups[0][0]);
    assert.equal(await page.locator('.sample-text').first().textContent(), groups[0][1][0]);
    assert.equal(await page.locator('script, img, [onerror]').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    console.log('Translation escaping browser fixture passed (' + browserName + ').');
  } finally {
    await context.close();
  }
  console.log('Translation static corpus regression passed (' + browserName + '): six languages, three execution modes, reload and history navigation.');
} finally {
  await browser.close();
}
