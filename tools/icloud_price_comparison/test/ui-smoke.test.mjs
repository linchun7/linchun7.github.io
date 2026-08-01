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
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome-stable',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium',
    process.platform === 'win32' ? 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe' : '/usr/bin/chromium-browser',
    process.platform === 'win32' ? null : '/snap/bin/chromium'
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
      { name: 'wide-desktop', width: 1920, height: 1080 },
      { name: 'desktop', width: 1365, height: 900 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 390, height: 844 },
      { name: 'narrow-mobile', width: 320, height: 720 }
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
      await page.route('**/data/prices.json*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, viewport.name === 'desktop' ? 1_800 : 250));
        await route.continue();
      });

      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.locator('#loadStatus').isVisible(), true, `${viewport.name} should show loading status before price data arrives`);
        assert.match(await page.locator('#loadStatusText').textContent(), /正在加载价格数据/);
        assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'true');
        assert.equal(await page.locator('#searchInput').isDisabled(), true);
        assert.equal(await page.locator('#regionSelect').isDisabled(), true);
        if (viewport.name === 'desktop') {
          await page.waitForTimeout(1_600);
          assert.match(await page.locator('#loadStatusText').textContent(), /网络较慢，仍在加载/);
        }
        await page.waitForFunction(
          (count) => document.querySelectorAll('#priceRows tr[data-country]').length === count,
          expectedData.countries.length
        );

        assert.equal(await page.locator('#marketCount').textContent(), String(expectedData.countries.length));
        assert.equal(await page.locator('#tierCount').textContent(), String(expectedData.tiers.length));
        assert.equal(await page.locator('#loadStatus').isVisible(), false, `${viewport.name} should hide loading status after price data arrives`);
        assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'false');
        assert.equal(await page.locator('#searchInput').isEnabled(), true);
        assert.equal(await page.locator('#regionSelect').isEnabled(), true);
        assert.equal(await page.locator('.app-brand strong').textContent(), 'iCloud+ 全球价格对比');
        assert.equal(await page.locator('#pageTitle').textContent(), '各容量最低价');
        assert.equal(await page.locator('.workspace-heading h2').textContent(), '各地区 iCloud+ 价格');
        assert.equal(await page.locator('button[data-sort-tier]').count(), expectedData.tiers.length);
        if (viewport.width > 900) {
          const referenceBox = await page.locator('.overview-reference').boundingBox();
          const statsBox = await page.locator('.overview-stats').boundingBox();
          assert.ok(referenceBox && statsBox && statsBox.y >= referenceBox.y + referenceBox.height, `${viewport.name} metrics should form a separate row below the minimum summary`);
          assert.ok(referenceBox && statsBox && Math.abs(referenceBox.width - statsBox.width) <= 2, `${viewport.name} overview rows should share the same width`);
        }
        const statValues = await page.locator('.overview-stats dd').evaluateAll((elements) => elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent,
            color: style.color,
            fontSize: Number.parseFloat(style.fontSize)
          };
        }));
        assert.deepEqual(statValues.map(({ text }) => text), [String(expectedData.countries.length), String(new Set(expectedData.countries.map(({ currency }) => currency)).size), String(expectedData.tiers.length)]);
        assert.equal(new Set(statValues.map(({ color }) => color)).size, 1, `${viewport.name} stat colors should have equal emphasis`);
        assert.equal(new Set(statValues.map(({ fontSize }) => fontSize)).size, 1, `${viewport.name} stat sizes should have equal emphasis`);
        assert.ok(statValues.every(({ fontSize }) => fontSize >= (viewport.width > 900 ? 28 : 24)), `${viewport.name} stats should remain readable`);
        const statCards = await page.locator('.overview-stats > div').evaluateAll((elements) => elements.map((element) => {
          const style = getComputedStyle(element);
          return { backgroundColor: style.backgroundColor, borderColor: style.borderColor };
        }));
        assert.equal(new Set(statCards.map(({ backgroundColor }) => backgroundColor)).size, 1, `${viewport.name} stat backgrounds should have equal emphasis`);
        assert.equal(new Set(statCards.map(({ borderColor }) => borderColor)).size, 1, `${viewport.name} stat borders should have equal emphasis`);
        assert.equal(await page.locator('#minimumSummary > div').count(), expectedData.tiers.length);
        for (const tier of expectedData.tiers) {
          const lowest = expectedData.countries
            .map((country) => ({
              country,
              cny: country.plans[tier.id].price / expectedData.fx.rates[country.currency] * expectedData.fx.rates.CNY
            }))
            .sort((first, second) => first.cny - second.cny)[0];
          const summaryText = await page.locator('#minimumSummary > div').evaluateAll((items, label) => {
            const item = items.find((element) => element.querySelector('.minimum-tier-label')?.textContent === label);
            return item?.textContent ?? '';
          }, tier.label);
          assert.ok(summaryText.includes(lowest.country.nameZh || lowest.country.country));
        }
        const minimumCountrySize = await page.locator('#minimumSummary .minimum-country').first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        const minimumPriceSize = await page.locator('#minimumSummary .minimum-price').first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        assert.ok(minimumCountrySize > minimumPriceSize, 'minimum country should be the visual focus');
        assert.equal(await page.locator('#minimumSummary .minimum-tier-label').count(), expectedData.tiers.length);
        assert.equal(await page.locator('#minimumSummary .minimum-tier-label svg').count(), 0);
        const minimumBadges = page.locator('.price-cell.is-minimum .minimum-badge');
        assert.ok(await minimumBadges.count() >= expectedData.tiers.length, 'each tier should expose at least one minimum-price badge');
        const minimumBadgePosition = await minimumBadges.first().evaluate((badge) => ({
          badgeIndex: [...badge.parentElement.children].indexOf(badge),
          gapToPrice: badge.nextElementSibling.getBoundingClientRect().left - badge.getBoundingClientRect().right,
          text: badge.textContent
        }));
        assert.equal(minimumBadgePosition.badgeIndex, 0, 'minimum badge should sit directly before the price');
        assert.equal(minimumBadgePosition.text, '最低');
        assert.ok(minimumBadgePosition.gapToPrice >= 0 && minimumBadgePosition.gapToPrice <= 6, `${viewport.name} minimum badge should stay close to the price`);
        const minimumCellBackground = await page.locator('.price-cell.is-minimum').first().evaluate((cell) => getComputedStyle(cell).backgroundColor);
        const standardCellBackground = await page.locator('.price-cell:not(.is-minimum):not(.is-sorted)').first().evaluate((cell) => getComputedStyle(cell).backgroundColor);
        assert.notEqual(minimumCellBackground, standardCellBackground, 'minimum cell should use a restrained green tint');
        const sourceText = await page.locator('#sourceLinks').innerText();
        assert.equal(await page.locator('#sourceLinks .source-group').count(), 2);
        assert.equal(await page.locator('#sourceLinks .source-status svg').count(), 1);
        assert.ok(sourceText.indexOf('Apple iCloud+价格') < sourceText.indexOf('页面发布日期'));
        assert.ok(sourceText.indexOf('页面发布日期') < sourceText.indexOf('人民币参考汇率'));
        assert.match(sourceText, /更新时间：.+北京时间/);
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

test('shows an actionable error and recovers after a temporary price-data outage', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the UI error-state test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  let attempts = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/data/prices.json*', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"temporary outage"}' });
        return;
      }
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await page.locator('#loadStatus').isVisible(), true);
    assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'false');
    assert.equal(await page.locator('#searchInput').isDisabled(), true);
    assert.match(await page.locator('#loadStatusText').textContent(), /加载失败/);
    assert.equal(await page.locator('#retryButton').textContent(), '重新加载');
    await page.locator('#retryButton').click();
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 73);
    assert.equal(await page.locator('#loadStatus').isVisible(), false);
    assert.equal(await page.locator('.data-status').evaluate((element) => element.classList.contains('is-error')), false);
    assert.equal(attempts, 2);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps current prices usable when optional history data is unavailable', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the history fallback test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/data/history.json*', (route) => route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":"history temporarily unavailable"}'
    }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 73);
    assert.equal(await page.locator('#loadStatus').isVisible(), false);
    assert.equal(await page.locator('#marketCount').textContent(), '73');
    assert.equal(await page.locator('#publishedDateButton').isVisible(), true);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
