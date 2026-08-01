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
      if (viewport.name === 'narrow-mobile') await page.emulateMedia({ reducedMotion: 'reduce' });
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
      let releasePriceRequest;
      const priceRequestReleased = new Promise((resolve) => {
        releasePriceRequest = resolve;
      });
      await page.route('**/data/prices.json*', async (route) => {
        await priceRequestReleased;
        await route.continue();
      });

      try {
        await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded' });
        assert.equal(await page.locator('#loadStatus').isVisible(), true, `${viewport.name} should show loading status before price data arrives`);
        assert.match(await page.locator('#loadStatusText').textContent(), /正在加载价格数据/);
        assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'true');
        assert.equal(await page.locator('#searchInput').isDisabled(), true);
        assert.equal(await page.locator('#regionSelect').isDisabled(), true);
        if (viewport.name === 'narrow-mobile') {
          assert.equal(await page.locator('.spinner').first().evaluate((element) => getComputedStyle(element).animationName), 'none');
        }
        if (viewport.name === 'desktop') {
          await page.waitForTimeout(1_600);
          assert.match(await page.locator('#loadStatusText').textContent(), /网络较慢，仍在加载/);
        }
        releasePriceRequest();
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
        if (viewport.name === 'tablet') {
          const countryVisibility = await page.evaluate(() => {
            const scroller = document.querySelector('.table-scroll').getBoundingClientRect();
            const countryHeader = document.querySelector('.price-table th:nth-child(2)').getBoundingClientRect();
            return { scrollerLeft: scroller.left, scrollerRight: scroller.right, countryLeft: countryHeader.left, countryRight: countryHeader.right };
          });
          assert.ok(countryVisibility.countryLeft >= countryVisibility.scrollerLeft - 1, 'tablet country column must not be shifted off-screen');
          assert.ok(countryVisibility.countryRight <= countryVisibility.scrollerRight + 1, 'tablet country column must remain visible inside the table scroller');
        }
        if (viewport.name === 'narrow-mobile') {
          const metricLabels = await page.locator('.overview-stats dt > span:last-child').evaluateAll((labels) => labels.map((label) => ({
            height: label.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight)
          })));
          assert.ok(metricLabels.every(({ height, lineHeight }) => height <= lineHeight * 1.2), '320px metric labels must stay on one line');
        }
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
        if (process.env.SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${viewport.name}.png`) });
        }

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
        const historyRow = page.locator('#priceRows tr[data-country]').first();
        if (viewport.name === 'desktop') {
          await page.evaluate(() => {
            document.body.tabIndex = -1;
            document.body.focus();
            document.body.removeAttribute('tabindex');
          });
          await page.keyboard.press('Tab');
          assert.equal(await page.locator('.skip-link').evaluate((element) => document.activeElement === element), true, 'skip link must be the first keyboard stop');
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('#priceWorkspace').evaluate((element) => document.activeElement === element), true, 'skip link must move focus to the price workspace');
          await historyRow.focus();
          await page.keyboard.press('Enter');
        } else {
          await historyRow.click();
        }
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
        const expectedDialogName = expectedData.countries.find(({ country }) => country === historySearch)?.nameZh || historySearch;
        assert.equal(await page.getByRole('dialog', { name: expectedDialogName }).count(), 1, 'history dialog must have an accessible name');
        assert.ok(await page.locator('#historyRows tr').count() > 0);
        assert.equal(await page.locator('#historyTierControl button').count(), expectedData.tiers.length);
        if (historyCountry) {
          await page.waitForFunction(() => !document.querySelector('#chartWrap')?.hidden);
          await page.waitForFunction(() => {
            const canvas = document.querySelector('#historyChart');
            const context = canvas?.getContext('2d');
            if (!context || !canvas.width || !canvas.height) return false;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            for (let index = 3; index < pixels.length; index += 4) {
              if (pixels[index] > 0) return true;
            }
            return false;
          }, undefined, { timeout: 5_000 });
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
        if (viewport.name === 'desktop') await page.keyboard.press('Escape');
        else await page.locator('#closeHistory').click();
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === false);
        if (viewport.name === 'desktop') {
          assert.equal(await historyRow.evaluate((element) => document.activeElement === element), true, 'closing history with Escape must restore row focus');
        }

        await page.locator('#publishedDateButton').click();
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === true);
        assert.equal(await page.getByRole('dialog', { name: '发布日期变更' }).count(), 1, 'publication-date dialog must have an accessible name');
        assert.ok(await page.locator('#publishedDateRows tr').count() > 0);
        await page.locator('#closePublishedDate').click();
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === false);

        assert.deepEqual(errors, []);
      } finally {
        releasePriceRequest?.();
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

test('keeps current prices usable when optional history data is unavailable or malformed', { timeout: 30_000 }, async (context) => {
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
    const scenarios = [
      { status: 503, body: '{"error":"history temporarily unavailable"}' },
      {
        status: 200,
        body: JSON.stringify({
          schemaVersion: 2,
          countries: {},
          sourcePublishedDates: [{
            publishedDate: 'July 17, 2026',
            observedAt: '2026-08-01',
            kind: 'change',
            changes: { addedCountries: 'not-an-array' }
          }]
        })
      }
    ];
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/history.json*', (route) => route.fulfill({
        status: scenario.status,
        contentType: 'application/json',
        body: scenario.body
      }));
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 73);
        assert.equal(await page.locator('#loadStatus').isVisible(), false);
        assert.equal(await page.locator('#marketCount').textContent(), '73');
        assert.equal(await page.locator('#publishedDateButton').isVisible(), true);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rejects malformed price payloads and recovers without a full-page refresh', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the malformed-data UI test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }
  const validData = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data/prices.json'), 'utf8'));
  const corruptions = [
    ['duplicate country', (data) => data.countries.push(structuredClone(data.countries[0]))],
    ['invalid USD anchor', (data) => { data.fx.rates.USD = 2; }],
    ['invalid generated timestamp', (data) => { data.generatedAt = '2026-02-30T00:00:00.000Z'; }],
    ['invalid FX timestamp', (data) => { data.fx.fetchedAt = '2026-02-30'; }],
    ['invalid Apple publication date', (data) => { data.source.publishedDate = 'February 30, 2026'; }],
    ['missing region', (data) => { data.countries[0].region = ''; }],
    ['empty formatted price', (data) => { data.countries[0].plans[data.tiers[0].id].formattedPrice = '   '; }]
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    for (const [label, corrupt] of corruptions) {
      const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
      let serveValidData = false;
      const malformed = structuredClone(validData);
      corrupt(malformed);
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => {
        if (serveValidData) return route.continue();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(malformed) });
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
        assert.match(await page.locator('#loadStatusText').textContent(), /加载失败/, label);
        assert.equal(await page.locator('#searchInput').isDisabled(), true, label);
        serveValidData = true;
        await page.locator('#retryButton').click();
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-country]').length === count, validData.countries.length);
        assert.equal(await page.locator('#loadStatus').isVisible(), false, `${label} should recover after retry`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('marks stale data clearly and falls back from an invalid tier query', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the stale-data UI test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }
  const validData = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data/prices.json'), 'utf8'));
  const scenarios = [
    {
      label: 'old snapshot',
      mutate: (data) => {
        data.generatedAt = '2020-01-01T00:00:00.000Z';
        data.fx.stale = false;
        data.source.publishedDate = 'Published Date: July 17, 2026';
      },
      expected: /超过 36 小时/,
      expectedPublishedDate: '2026/07/17'
    },
    {
      label: 'fallback rates',
      mutate: (data) => { data.generatedAt = new Date().toISOString(); data.fx.stale = true; },
      expected: /汇率沿用上次成功结果/
    },
    {
      label: 'old snapshot with fallback rates',
      mutate: (data) => { data.generatedAt = '2020-01-01T00:00:00.000Z'; data.fx.stale = true; },
      expected: /超过 36 小时 · 汇率沿用上次成功结果/
    }
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  try {
    for (const { label, mutate, expected, expectedPublishedDate } of scenarios) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const payload = structuredClone(validData);
      mutate(payload);
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload)
      }));
      try {
        await page.goto(`http://127.0.0.1:${port}/?tier=not-a-real-tier`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-country]').length === count, validData.countries.length);
        assert.match(await page.locator('#updatedAt').textContent(), expected, label);
        if (expectedPublishedDate) {
          assert.equal(await page.locator('#applePublishedDate').textContent(), expectedPublishedDate, label);
        }
        assert.equal(await page.locator('.data-status').evaluate((element) => element.classList.contains('is-stale')), true, label);
        const statusLayout = await page.evaluate(() => {
          const rect = document.querySelector('.data-status').getBoundingClientRect();
          return {
            right: rect.right,
            viewportWidth: document.documentElement.clientWidth,
            documentWidth: document.documentElement.scrollWidth
          };
        });
        assert.ok(statusLayout.right <= statusLayout.viewportWidth + 1, `${label} status text must stay inside the viewport`);
        assert.ok(statusLayout.documentWidth <= statusLayout.viewportWidth + 1, `${label} must not create page-level horizontal overflow`);
        assert.equal(await page.locator('button[data-sort-tier="200GB"]').locator('xpath=ancestor::th').getAttribute('aria-sort'), 'ascending');
        assert.match(await page.locator('#resultSummary').textContent(), /200 GB/);
        if (process.env.SCREENSHOT_DIR && label === 'old snapshot with fallback rates') {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'stale-combined.png') });
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps 100 price and publication history records inside scrollable dialogs', { timeout: 30_000 }, async (context) => {
  const chromePath = await findChrome();
  if (!chromePath) {
    if (process.env.CI) assert.fail('Chrome or Chromium is required for the long-history UI test');
    context.skip('Chrome or Chromium is not installed');
    return;
  }

  const data = JSON.parse(await readFile(path.join(PROJECT_DIR, 'data/prices.json'), 'utf8'));
  const country = data.countries[0];
  const firstTier = data.tiers[0];
  const dayMs = 86_400_000;
  const priceEnd = Date.UTC(2026, 7, 1);
  const publicationEnd = Date.UTC(2026, 6, 17);
  const priceEvents = Array.from({ length: 100 }, (_, index) => {
    const observedAt = new Date(priceEnd - (99 - index) * dayMs).toISOString().slice(0, 10);
    return {
      observedAt,
      currency: country.currency,
      plans: Object.fromEntries(data.tiers.map(({ id }) => [id, country.plans[id].price + index / 100]))
    };
  });
  const verboseCountries = Array.from({ length: 24 }, (_, index) => ({
    country: `SyntheticCountry${index}${'UnbrokenName'.repeat(8)}`,
    nameZh: index === 0 ? '' : `测试地区${index}${'超长变化内容'.repeat(8)}`
  }));
  const verboseChanges = {
    addedTiers: Array.from({ length: 12 }, (_, index) => ({ id: `NEW${index}TB`, label: `新增容量 ${index + 1} TB` })),
    removedTiers: Array.from({ length: 12 }, (_, index) => ({ id: `OLD${index}TB`, label: `移除容量 ${index + 1} TB` })),
    addedCountries: verboseCountries,
    removedCountries: verboseCountries.map((entry, index) => ({ ...entry, country: `Removed${index}${entry.country}` })),
    changedCountries: verboseCountries.map((entry, index) => ({
      ...entry,
      fromCurrency: 'USD',
      toCurrency: 'CNY',
      fromRegion: 'Americas',
      toRegion: 'Asia Pacific',
      tiers: data.tiers.map(({ id }, tierIndex) => ({ id, from: index + tierIndex + 1, to: index + tierIndex + 2 }))
    }))
  };
  const sourcePublishedDates = Array.from({ length: 100 }, (_, index) => {
    const date = new Date(publicationEnd - (99 - index) * dayMs);
    const publishedDate = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'
    }).format(date);
    const emptyChanges = { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [] };
    return {
      publishedDate,
      observedAt: date.toISOString().slice(0, 10),
      kind: index === 0 ? 'initial' : 'change',
      changes: index === 99 ? verboseChanges : {
        ...emptyChanges,
        changedCountries: index === 0 ? [] : [{
          country: country.country,
          nameZh: country.nameZh,
          fromCurrency: country.currency,
          toCurrency: country.currency,
          fromRegion: country.region,
          toRegion: country.region,
          tiers: [{ id: firstTier.id, from: index, to: index + 1 }]
        }]
      }
    };
  });
  const history = {
    schemaVersion: 2,
    countries: {
      [country.country]: {
        nameZh: country.nameZh,
        region: country.region,
        events: priceEvents
      }
    },
    sourcePublishedDates
  };
  const server = await startServer();
  const { port } = server.address();
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });

  const assertScrollableDialog = async (page, dialogSelector, closeSelector, label) => {
    const dialog = page.locator(dialogSelector);
    const before = await dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth
      };
    });
    assert.ok(before.top >= -1 && before.bottom <= before.viewportHeight + 1, `${label} dialog must stay inside the viewport`);
    assert.ok(before.left >= -1 && before.right <= before.viewportWidth + 1, `${label} dialog width must stay inside the viewport`);
    assert.ok(before.scrollHeight > before.clientHeight, `${label} dialog must scroll vertically`);
    assert.ok(before.scrollWidth <= before.clientWidth + 1, `${label} dialog must not scroll horizontally`);
    assert.ok(before.documentWidth <= before.viewportWidth + 1, `${label} must not overflow the page`);
    assert.equal(
      await dialog.locator('.dialog-header').evaluate((header) => getComputedStyle(header).backgroundColor),
      'rgb(255, 255, 255)',
      `${label} sticky header must hide scrolling content behind it`
    );

    await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const sticky = await page.locator(closeSelector).evaluate((button) => {
      const buttonRect = button.getBoundingClientRect();
      const dialogRect = button.closest('dialog').getBoundingClientRect();
      return {
        buttonTop: buttonRect.top,
        buttonBottom: buttonRect.bottom,
        dialogTop: dialogRect.top,
        dialogBottom: dialogRect.bottom,
        viewportHeight: innerHeight
      };
    });
    assert.ok(sticky.buttonTop >= sticky.dialogTop - 1, `${label} close button must remain in the dialog`);
    assert.ok(sticky.buttonBottom <= Math.min(sticky.dialogBottom, sticky.viewportHeight) + 1, `${label} close button must remain visible after scrolling`);
  };

  try {
    for (const viewport of [
      { name: 'desktop', width: 1365, height: 900 },
      { name: 'narrow-mobile', width: 320, height: 720 }
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/history.json*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(history)
      }));
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-country]').length === count, data.countries.length);

        await page.locator('#searchInput').fill(country.country);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-country]').length === 1);
        await page.locator('#priceRows tr[data-country]').click();
        await page.waitForFunction(() => document.querySelectorAll('#historyRows tr').length === 100);
        await assertScrollableDialog(page, '#historyDialog', '#closeHistory', `${viewport.name} price history`);
        const priceTableScroller = page.locator('#historyDialog .history-table-scroll');
        if (viewport.name === 'narrow-mobile') {
          assert.ok(await priceTableScroller.evaluate((element) => element.scrollWidth > element.clientWidth), 'mobile price history must use its own horizontal scroller');
        } else {
          assert.ok(await priceTableScroller.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'desktop price history must not scroll horizontally');
        }
        if (process.env.SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `long-price-history-${viewport.name}.png`) });
        }
        await page.locator('#closeHistory').click();

        await page.locator('#publishedDateButton').click();
        await page.waitForFunction(() => document.querySelectorAll('#publishedDateRows tr').length === 100);
        await assertScrollableDialog(page, '#publishedDateDialog', '#closePublishedDate', `${viewport.name} publication history`);
        const tableScroller = page.locator('#publishedDateDialog .history-table-scroll');
        const verboseCell = page.locator('#publishedDateRows .published-change-cell').first();
        const verboseMetrics = await verboseCell.evaluate((element) => ({
          textLength: element.textContent.length,
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight)
        }));
        assert.ok(verboseMetrics.textLength > 5_000, 'publication history must render the complete long change description');
        assert.ok(verboseMetrics.scrollWidth <= verboseMetrics.clientWidth + 1, 'long change text must wrap inside its cell');
        assert.ok(verboseMetrics.height > verboseMetrics.lineHeight * 5, 'long change text must use multiple lines');
        if (viewport.name === 'narrow-mobile') {
          assert.ok(await tableScroller.evaluate((element) => element.scrollWidth > element.clientWidth), 'mobile publication table must use its own horizontal scroller');
        } else {
          assert.ok(await tableScroller.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), 'desktop publication table must not gain horizontal overflow from long text');
        }
        if (process.env.SCREENSHOT_DIR) {
          await verboseCell.scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `long-publication-history-${viewport.name}.png`) });
        }
        await page.locator('#closePublishedDate').click();
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
