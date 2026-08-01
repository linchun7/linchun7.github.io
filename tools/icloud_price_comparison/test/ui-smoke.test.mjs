import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

async function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next system browser path.
    }
  }
  return null;
}

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const requestedPath = path.resolve(PROJECT_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!requestedPath.startsWith(`${PROJECT_DIR}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const fileStat = await stat(requestedPath);
      if (!fileStat.isFile()) throw new Error('Not a file');
      response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(requestedPath)] ?? 'application/octet-stream' });
      response.end(await readFile(requestedPath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

test('renders current prices, sorting, and country history in a real browser', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the UI smoke test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }

  const expectedData = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data/prices.json'), 'utf8'));
  const expectedHistory = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data/history.json'), 'utf8'));
  const historyCountry = Object.entries(expectedHistory.countries)
    .find(([, record]) => record.events.length > 1)?.[0];
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });

  try {
    for (const viewport of [
      { name: 'desktop', width: 1365, height: 900 },
      { name: 'mobile', width: 390, height: 844 }
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
      });
      page.on('response', (response) => {
        const resourceType = response.request().resourceType();
        const pathname = new URL(response.url()).pathname;
        if (response.url().startsWith(baseUrl)
          && response.status() >= 400
          && resourceType !== 'image'
          && !pathname.startsWith('/images/')) {
          errors.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.route('https://**/*', (route) => route.abort());

      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          (count) => document.querySelectorAll('#priceRows tr[data-country]').length === count,
          expectedData.countries.length
        );

        assert.equal(await page.locator('#marketCount').textContent(), String(expectedData.countries.length));
        assert.equal(await page.locator('#tierCount').textContent(), String(expectedData.tiers.length));
        assert.equal(await page.locator('button[data-sort-tier]').count(), expectedData.tiers.length);
        const layout = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        }));
        assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${viewport.name} page has unexpected body overflow`);

        const firstCountry = expectedData.countries[0].country;
        await page.locator('#searchInput').fill(firstCountry);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 1);
        await page.locator('#searchInput').fill('');
        await page.locator('#regionSelect').selectOption(expectedData.countries[0].region);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length > 0);
        await page.locator('#regionSelect').selectOption('all');

        await page.locator('button[data-sort="country"]').click();
        assert.equal(await page.locator('button[data-sort="country"]').locator('xpath=ancestor::th').getAttribute('aria-sort'), 'ascending');
        await page.locator('button[data-sort="country"]').click();
        assert.equal(await page.locator('button[data-sort="country"]').locator('xpath=ancestor::th').getAttribute('aria-sort'), 'descending');

        const firstTier = expectedData.tiers[0].id;
        await page.locator(`button[data-sort-tier="${firstTier}"]`).click();
        assert.equal(
          await page.locator(`button[data-sort-tier="${firstTier}"]`).locator('xpath=ancestor::th').getAttribute('aria-sort'),
          'ascending'
        );

        const historySearch = historyCountry ?? firstCountry;
        await page.locator('#searchInput').fill(historySearch);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 1);
        await page.locator('#priceRows tr[data-country]').first().click();
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
        assert.ok(await page.locator('#historyRows tr').count() > 0);
        assert.equal(await page.locator('#historyTierControl button').count(), expectedData.tiers.length);
        if (historyCountry) {
          await page.waitForFunction(() => !document.querySelector('#chartWrap')?.hidden);
          const chartPixels = await page.locator('#historyChart').evaluate((canvas) => {
            const context = canvas.getContext('2d');
            if (!context || !canvas.width || !canvas.height) return 0;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let nonTransparent = 0;
            for (let index = 3; index < pixels.length; index += 4) {
              if (pixels[index] > 0) nonTransparent += 1;
            }
            return nonTransparent;
          });
          assert.ok(chartPixels > 0, `${viewport.name} chart canvas is blank`);
        }
        await page.locator('#closeHistory').click();
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === false);

        await page.locator('#publishedDateButton').click();
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === true);
        assert.ok(await page.locator('#publishedDateRows tr').count() > 0);
        await page.locator('#closePublishedDate').click();
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === false);

        if (process.env.SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${viewport.name}.png`), fullPage: true });
        }
        assert.deepEqual(errors, []);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
