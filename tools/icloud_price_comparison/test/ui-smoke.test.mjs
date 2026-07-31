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
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
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

    const firstTier = expectedData.tiers[0].id;
    await page.locator(`button[data-sort-tier="${firstTier}"]`).click();
    assert.equal(
      await page.locator(`button[data-sort-tier="${firstTier}"]`).locator('xpath=ancestor::th').getAttribute('aria-sort'),
      'ascending'
    );

    await page.locator('#priceRows tr[data-country]').first().click();
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
    assert.ok(await page.locator('#historyRows tr').count() > 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
