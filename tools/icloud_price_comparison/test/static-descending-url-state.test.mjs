import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

import './forced-colors-smoke.test.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BROWSER = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const BROWSER_TYPE = { chromium, firefox, webkit }[BROWSER];
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

if (!BROWSER_TYPE) throw new Error(`Unsupported Playwright browser: ${BROWSER}`);

async function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const filePath = path.resolve(PROJECT_DIR, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filePath.startsWith(`${PROJECT_DIR}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) throw new Error('Not a file');
      response.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      response.end(await readFile(filePath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function expectedDescendingOrder(data, tierId) {
  return [...data.countries].sort((first, second) => (
    second.plans[tierId].cnyRank - first.plans[tierId].cnyRank
    || first.marketId.localeCompare(second.marketId, 'en')
  ));
}

async function assertDescendingStaticState(page, data, tierId) {
  const tier = data.tiers.find(({ id }) => id === tierId);
  const expected = expectedDescendingOrder(data, tierId);
  assert.ok(tier);
  assert.equal(new URL(page.url()).search, `?tier=${tierId}&dir=desc`);
  assert.equal(await page.locator(`th[data-tier="${tierId}"]`).getAttribute('aria-sort'), 'descending');
  assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), expected[0].marketId);
  assert.equal(await page.locator('#priceRows tr[data-market-id]').first().locator('td').first().textContent(), String(expected[0].plans[tierId].cnyRank));
  assert.equal(await page.locator('#resultSummary').textContent(), `${data.countries.length} 个地区 · ${tier.label} 从高到低`);
  assert.equal(await page.locator('.rank-top').count(), 0, 'descending static state must not retain ascending top-three emphasis');
}

test('reconciles descending tier URL state before hydration and during static fallback', { timeout: 45_000 }, async () => {
  const data = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data', 'prices.json'), 'utf8'));
  const server = await startServer();
  const { port } = server.address();
  const browser = await BROWSER_TYPE.launch({ headless: true });
  try {
    for (const tierId of ['200GB', '6TB']) {
      const pendingPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      let releaseRequest;
      const requestReleased = new Promise((resolve) => { releaseRequest = resolve; });
      await pendingPage.route('https://**/*', (route) => route.abort());
      await pendingPage.route('**/data/prices.json*', async (route) => {
        await requestReleased;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
      });
      try {
        await pendingPage.goto(`http://127.0.0.1:${port}/?tier=${tierId}&dir=desc`, { waitUntil: 'domcontentloaded' });
        await pendingPage.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === false);
        await assertDescendingStaticState(pendingPage, data, tierId);
        releaseRequest();
        await pendingPage.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
        await assertDescendingStaticState(pendingPage, data, tierId);
      } finally {
        releaseRequest?.();
        await pendingPage.close();
      }

      const fallbackPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await fallbackPage.route('https://**/*', (route) => route.abort());
      await fallbackPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
      try {
        await fallbackPage.goto(`http://127.0.0.1:${port}/?tier=${tierId}&dir=desc`, { waitUntil: 'domcontentloaded' });
        await fallbackPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
        await assertDescendingStaticState(fallbackPage, data, tierId);
      } finally {
        await fallbackPage.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
