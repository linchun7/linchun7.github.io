import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

import { validatePriceHistoryConsistency } from '../data-contract.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_DIR = path.resolve(PROJECT_DIR, '../..');
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
const BROWSER_UNDER_TEST = process.env.PLAYWRIGHT_BROWSER || 'chromium';
let sharedBrowserPromise = null;
let sharedServerPromise = null;

if (!['chromium', 'firefox', 'webkit'].includes(BROWSER_UNDER_TEST)) {
  throw new Error(`Unsupported Playwright browser: ${BROWSER_UNDER_TEST}`);
}

async function readFixture(fileName) {
  return JSON.parse(await readFile(path.join(PROJECT_DIR, 'data', fileName), 'utf8'));
}

function formatUiDate(value) {
  const text = String(value).trim().replace(/^published\s+date\s*:?\s*/i, '');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? new Date(`${text}T00:00:00Z`)
    : new Date(`${text} 00:00:00 UTC`);
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'UTC'
  }).format(date);
}

function setPayloadGeneratedAt(data, generatedAt) {
  data.generatedAt = generatedAt;
  data.run.startedAtUtc = generatedAt;
  data.run.finishedAtUtc = generatedAt;
  data.run.observedAtUtc = generatedAt;
  data.run.observedAtBeijing = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai'
  }).format(new Date(generatedAt));
}

const uiNumberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

function compactExpectedSeries(events, tier) {
  const availableEvents = events.filter((event) => Number.isFinite(event.plans[tier]));
  return availableEvents.filter((event, index) => (
    index === 0
    || event.currency !== availableEvents[index - 1].currency
    || event.plans[tier] !== availableEvents[index - 1].plans[tier]
  ));
}

function canRenderExpectedChart(series) {
  return series.length > 1 && new Set(series.map(({ currency }) => currency)).size === 1;
}

function historyRecords(history) {
  return history.markets ?? history.countries;
}

function historyRecordForCountry(history, data, countryName) {
  const country = data.countries.find((entry) => entry.country === countryName);
  return historyRecords(history)[country?.marketId ?? countryName];
}

function rerankPriceFixture(data) {
  for (const { id } of data.tiers) {
    const ordered = [...data.countries].sort((first, second) => (
      first.plans[id].cnyPrice - second.plans[id].cnyPrice
      || first.marketId.localeCompare(second.marketId, 'en')
    ));
    let rank = 0;
    let previousPrice = null;
    for (const country of ordered) {
      const price = country.plans[id].cnyPrice;
      if (previousPrice === null || Math.abs(price - previousPrice) > 1e-9) {
        rank += 1;
        previousPrice = price;
      }
      country.plans[id].cnyRank = rank;
    }
  }
  return data;
}

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

async function resolveBrowser(context, purpose) {
  if (BROWSER_UNDER_TEST !== 'chromium') {
    const browserType = BROWSER_UNDER_TEST === 'firefox' ? firefox : webkit;
    const browserName = BROWSER_UNDER_TEST === 'firefox' ? 'Firefox' : 'WebKit';
    try {
      await access(browserType.executablePath());
    } catch {
      if (process.env.CI) assert.fail(`Playwright ${browserName} is required for ${purpose}`);
      context.skip(`Playwright ${browserName} is not installed`);
      return null;
    }
    return { browserType: sharedBrowserType(browserType), launchOptions: { headless: true } };
  }

  try {
    await access(chromium.executablePath());
    return { browserType: sharedBrowserType(chromium), launchOptions: { headless: true } };
  } catch {
    // Fall back to a system browser when Playwright Chromium is not installed.
  }
  const executablePath = await findChrome();
  if (!executablePath) {
    if (process.env.CI) assert.fail(`Chrome or Chromium is required for ${purpose}`);
    context.skip('Chrome or Chromium is not installed');
    return null;
  }
  return { browserType: sharedBrowserType(chromium), launchOptions: { executablePath, headless: true } };
}

function sharedBrowserType(browserType) {
  return {
    async launch(launchOptions) {
      if (!sharedBrowserPromise) sharedBrowserPromise = browserType.launch(launchOptions);
      const sharedBrowser = await sharedBrowserPromise;
      const pages = new Set();
      return {
        async newPage(options) {
          const page = await sharedBrowser.newPage(options);
          pages.add(page);
          page.once('close', () => pages.delete(page));
          return page;
        },
        async close() {
          await Promise.allSettled([...pages].map((page) => page.close()));
          pages.clear();
        }
      };
    }
  };
}

async function createServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname === '/data/prices.json' && request.headers['x-icloud-test-price-response'] === 'redirect') {
        response.writeHead(302, { location: '/data/history.json' }).end();
        return;
      }
      const publicRoot = pathname.startsWith('/images/') ? REPOSITORY_DIR : PROJECT_DIR;
      const requestedPath = path.resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!requestedPath.startsWith(`${publicRoot}${path.sep}`)) {
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

async function startServer() {
  if (!sharedServerPromise) sharedServerPromise = createServer();
  const sharedServer = await sharedServerPromise;
  return {
    address: () => sharedServer.address(),
    close: (callback) => queueMicrotask(() => callback?.())
  };
}

after(async () => {
  const cleanup = [];
  if (sharedBrowserPromise) cleanup.push(sharedBrowserPromise.then((browser) => browser.close()));
  if (sharedServerPromise) {
    cleanup.push(sharedServerPromise.then((server) => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })));
  }
  await Promise.allSettled(cleanup);
});

test('starts price data early and deprioritizes optional third-party work', async () => {
  const [html, bootstrapSource, moduleSource, styleSource] = await Promise.all([
    readFile(path.join(PROJECT_DIR, 'index.html'), 'utf8'),
    readFile(path.join(PROJECT_DIR, 'price-bootstrap.js'), 'utf8'),
    readFile(path.join(PROJECT_DIR, 'script.js'), 'utf8'),
    readFile(path.join(PROJECT_DIR, 'style.css'), 'utf8')
  ]);
  const eagerPriceFetch = html.match(/<script data-cfasync="false" src="price-bootstrap\.js\?v=[0-9a-f]{8}"><\/script>/)?.[0];
  const moduleScript = html.match(/<script data-cfasync="false" type="module" src="script\.js\?v=[0-9a-f]{8}"><\/script>/)?.[0];
  assert.ok(eagerPriceFetch, 'prices.json bootstrap should run during HTML parsing with a content hash');
  assert.ok(moduleScript, 'the application module should use a content hash');
  assert.ok(html.indexOf(eagerPriceFetch) < html.indexOf(moduleScript), 'the initial price request should precede module execution');
  assert.doesNotMatch(html, /rel="preload" href="data\/prices\.json"/, 'cross-browser loading should not rely on a fetch preload that WebKit may duplicate');
  assert.doesNotMatch(html, /<script[^>]+src="https:\/\/www\.googletagmanager\.com/, 'analytics must not block HTML parsing');
  assert.doesNotMatch(html, /analyticsConsent|privacySettings|允许匿名统计/, 'analytics consent overlay and its settings entry must be absent');
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<meta name="referrer" content="origin">/, 'subresource requests must not receive URL paths or query parameters in Referer');
  assert.match(html, /<input id="searchInput"[^>]+maxlength="160"/, 'free-text search input must have a bounded length');
  assert.match(html, /script-src[^;]+www\.googletagmanager\.com/, 'the deferred GA4 loader must be explicitly allowed by CSP');
  assert.match(html, /script-src[^;]+static\.cloudflareinsights\.com/, 'Cloudflare Web Analytics must be explicitly allowed by CSP');
  assert.match(html, /connect-src[^;]+google-analytics\.com[^;]+analytics\.google\.com[^;]+www\.googletagmanager\.com/, 'GA4 collection endpoints must be explicitly allowed by CSP');
  assert.match(html, /img-src[^;]+google-analytics\.com[^;]+www\.googletagmanager\.com/, 'GA4 image endpoints must be explicitly allowed by CSP');
  assert.doesNotMatch(html, /访问统计使用 Google Analytics 和 Cloudflare Web Analytics；站内搜索词不会发送给统计服务。/);
  assert.doesNotMatch(html, /raw\.githubusercontent\.com/, 'frontend data must not fall back to a mutable branch URL');
  assert.match(html, /参考汇率：ExchangeRate-API/);
  assert.match(html, /data-cfasync="false" type="module"/, 'Rocket Loader must not rewrite the module entry point');
  assert.match(bootstrapSource, /redirect:\s*'error'/, 'the eager price request must reject redirects');
  assert.match(bootstrapSource, /String\(amount\) === match\[1\]/, 'bootstrap URL tiers must use the same canonical numeric spelling as the module');
  assert.match(bootstrapSource, /finish:\s*\(\) => clearTimeout\(timeout\)/, 'the eager timeout must remain active while its body is read');
  assert.doesNotMatch(bootstrapSource, /\.finally\(\(\) => clearTimeout\(timeout\)\)/, 'receiving response headers must not clear the eager body timeout');
  assert.match(moduleSource, /MAX_RESPONSE_BYTES[\s\S]*?'prices\.json': 1024 \* 1024[\s\S]*?'history\.json': 8 \* 1024 \* 1024/);
  assert.match(moduleSource, /TextDecoder\('utf-8', \{ fatal: true \}\)/, 'network JSON must use strict UTF-8 decoding');
  assert.match(moduleSource, /fetch\(url,[\s\S]*?redirect:\s*'error'/, 'all later data requests must reject redirects');
  assert.match(moduleSource, /serialized\.length > MAX_PRICE_CACHE_CHARACTERS/, 'oversized price payloads must not be persisted');
  assert.match(moduleSource, /PRICE_FRESH_MAX_AGE_MS = 36 \* 60 \* 60 \* 1_000/);
  assert.match(moduleSource, /PRICE_HARD_MAX_AGE_MS = 7 \* 24 \* 60 \* 60 \* 1_000/);
  assert.match(moduleSource, /function scheduleFreshnessBoundary\(\)[\s\S]*?setTimeout\([\s\S]*?refreshPriceFreshnessLifecycle/);
  assert.doesNotMatch(moduleSource, /setInterval\(/, 'freshness lifecycle must use one-shot boundaries, not polling');
  assert.match(moduleSource, /document\.addEventListener\('visibilitychange'/);
  assert.match(moduleSource, /window\.addEventListener\('pageshow'/);
  assert.match(bootstrapSource, /cache:\s*'no-cache'/, 'the eager prices request must revalidate its HTTP cache');
  assert.match(moduleSource, /fileName === 'prices\.json' \? 'no-cache' : 'default'/, 'ordinary prices requests must revalidate while preserving HTTP caching');
  assert.match(moduleSource, /const ANALYTICS_ID = 'G-K2S9L4CHNP'/, 'the approved GA4 measurement ID must remain configured');
  assert.match(moduleSource, /page_location:\s*analyticsUrl\.href/, 'GA4 must receive only the sanitized page location');
  assert.match(moduleSource, /allow_google_signals:\s*false/, 'Google Signals must remain disabled');
  assert.match(moduleSource, /allow_ad_personalization_signals:\s*false/, 'ad personalization signals must remain disabled');
  assert.match(moduleSource, /absoluteChangePercent < 0\.01[\s\S]*?'< 0\.01'/, 'non-zero sub-basis-point trends must not be displayed as 0%');
  assert.match(styleSource, /@media \(forced-colors: active\)/, 'high-contrast mode must retain explicit selection and minimum-price cues');
  assert.match(styleSource, /th button:hover/);
  assert.match(styleSource, /\.segmented button:hover/);
  assert.doesNotMatch(styleSource, /\.overview h1/);
  assert.doesNotMatch(styleSource, /\.workspace\s*\{[^}]*overflow:\s*visible/);
});

test('preserves sorting, selection and minimum-price cues in forced-colors mode', { timeout: 30_000 }, async (context) => {
  if (BROWSER_UNDER_TEST !== 'chromium') {
    context.skip('forced-colors emulation is covered in Chromium');
    return;
  }
  const browserConfig = await resolveBrowser(context, 'the forced-colors accessibility regression test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 }, forcedColors: 'active' });
  await page.route('https://**/*', (route) => route.abort());
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 0);
    assert.equal(await page.evaluate(() => matchMedia('(forced-colors: active)').matches), true);
    const sortedHeader = page.locator('th[aria-sort="ascending"], th[aria-sort="descending"]').first();
    const activeCard = page.locator('.minimum-card.is-active-tier').first();
    const minimumCell = page.locator('.price-cell.is-minimum').first();
    assert.equal(await sortedHeader.count(), 1, 'the active sort must remain exposed semantically');
    assert.equal(await activeCard.count(), 1, 'the active tier card must be present');
    assert.equal(await minimumCell.count(), 1, 'the minimum-price cell must be present');
    const cues = await page.evaluate(() => {
      const sorted = document.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]');
      const active = document.querySelector('.minimum-card.is-active-tier');
      const minimum = document.querySelector('.price-cell.is-minimum');
      return {
        sortedBorder: getComputedStyle(sorted).borderBottomStyle,
        sortedBorderWidth: getComputedStyle(sorted).borderBottomWidth,
        activeOutline: getComputedStyle(active).outlineStyle,
        activeOutlineWidth: getComputedStyle(active).outlineWidth,
        minimumOutline: getComputedStyle(minimum).outlineStyle,
        minimumOutlineWidth: getComputedStyle(minimum).outlineWidth
      };
    });
    assert.deepEqual(cues, {
      sortedBorder: 'solid',
      sortedBorderWidth: '3px',
      activeOutline: 'solid',
      activeOutlineWidth: '2px',
      minimumOutline: 'solid',
      minimumOutlineWidth: '1px'
    });
  } finally {
    await browser.close();
  }
});

test('loads deferred GA4 with a sanitized page location and no consent overlay', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the deferred analytics privacy regression test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const origin = `http://127.0.0.1:${port}`;
  const privateQuery = `privateSearchTerm${'x'.repeat(200)}`;
  const expectedQuery = [...privateQuery].slice(0, 160).join('');
  const googleRequests = [];
  const sameOriginSubresourceReferrers = [];
  page.on('request', (request) => {
    if (/googletagmanager\.com|google-analytics\.com/i.test(request.url())) googleRequests.push(request.url());
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === origin && request.resourceType() !== 'document') {
      sameOriginSubresourceReferrers.push({
        url: request.url(),
        referrer: request.headers().referer || ''
      });
    }
  });
  await page.route('https://**/*', (route) => {
    if (route.request().url().startsWith('https://www.googletagmanager.com/')) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    }
    return route.abort();
  });
  try {
    const privateUrl = new URL(origin);
    privateUrl.searchParams.append('q', privateQuery);
    privateUrl.searchParams.append('privateToken', 'sensitiveValue');
    privateUrl.searchParams.append('tier', '200GB');
    privateUrl.searchParams.append('tier', 'sensitiveTier');
    privateUrl.searchParams.append('sort', 'tier');
    privateUrl.searchParams.append('sort', 'sensitiveSort');
    privateUrl.searchParams.append('dir', 'asc');
    privateUrl.searchParams.append('dir', 'sensitiveDirection');
    privateUrl.searchParams.append('region', 'sensitiveRegion');
    privateUrl.hash = 'sensitiveFragment';
    await page.goto(privateUrl.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#marketCount')?.textContent !== '--');
    assert.equal(await page.locator('#analyticsConsent, #privacySettings').count(), 0);
    await page.locator('script[data-analytics-loader]').waitFor({ state: 'attached' });
    assert.equal(await page.locator('script[data-analytics-loader]').count(), 1);
    assert.equal(
      await page.locator('script[data-analytics-loader]').getAttribute('src'),
      'https://www.googletagmanager.com/gtag/js?id=G-K2S9L4CHNP'
    );
    assert.equal(googleRequests.length, 1, 'the test stub must observe exactly one deferred Google tag request');
    assert.match(googleRequests[0], /^https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-K2S9L4CHNP$/);
    assert.equal(await page.locator('#searchInput').inputValue(), expectedQuery);
    const sanitizedUrl = new URL(page.url());
    assert.equal(sanitizedUrl.searchParams.has('q'), false);
    assert.equal(sanitizedUrl.searchParams.has('privateToken'), false);
    assert.equal(sanitizedUrl.searchParams.get('tier'), '200GB');
    assert.equal(sanitizedUrl.searchParams.getAll('tier').length, 1, 'duplicate public state must be canonicalized');
    assert.equal(sanitizedUrl.searchParams.get('sort'), 'tier');
    assert.equal(sanitizedUrl.searchParams.getAll('sort').length, 1, 'duplicate sort state must be canonicalized');
    assert.equal(sanitizedUrl.searchParams.get('dir'), 'asc');
    assert.equal(sanitizedUrl.searchParams.getAll('dir').length, 1, 'duplicate direction state must be canonicalized');
    assert.equal(sanitizedUrl.searchParams.has('region'), false, 'invalid values of public URL keys must be removed');
    assert.equal(sanitizedUrl.hash, '', 'unknown fragments must be removed before analytics can observe them');
    assert.doesNotMatch(page.url(), /privateSearchTerm|sensitive/i);
    const analyticsCommands = await page.evaluate(() => globalThis.dataLayer.map((entry) => Array.from(entry)));
    const configCommand = analyticsCommands.find(([command]) => command === 'config');
    assert.ok(configCommand, 'GA4 config command must be queued before the deferred loader executes');
    assert.equal(configCommand[1], 'G-K2S9L4CHNP');
    assert.equal(configCommand[2].page_location, sanitizedUrl.href);
    assert.equal(configCommand[2].allow_google_signals, false);
    assert.equal(configCommand[2].allow_ad_personalization_signals, false);
    assert.doesNotMatch(configCommand[2].page_location, /privateSearchTerm|privateToken|sensitive|[?&]q=/i);
    assert.ok(sameOriginSubresourceReferrers.length > 0, 'the privacy test must observe same-origin subresources');
    for (const { url, referrer } of sameOriginSubresourceReferrers) {
      assert.doesNotMatch(referrer, /privateSearchTerm|privateToken|sensitive|[?&]q=/i, `private URL state leaked in the Referer for ${url}`);
      if (referrer) {
        const referrerUrl = new URL(referrer);
        assert.equal(referrerUrl.origin, origin, `unexpected Referer origin for ${url}`);
        assert.equal(referrerUrl.pathname, '/', `same-origin subresource Referer must be origin-only for ${url}`);
        assert.equal(referrerUrl.search, '', `same-origin subresource Referer must not include a query for ${url}`);
      }
    }
    const googleCookiesBeforeStubbedLibrary = (await page.context().cookies()).filter(({ name }) => /^_ga(?:_|$)/.test(name));
    assert.deepEqual(googleCookiesBeforeStubbedLibrary, [], 'the local loader must not write analytics cookies itself');
    const footerText = await page.locator('.page-footer').innerText();
    assert.match(footerText, /本工具与 Apple Inc\. 无关联，数据仅供参考。/);
    assert.doesNotMatch(footerText, /访问统计使用 Google Analytics 和 Cloudflare Web Analytics；站内搜索词不会发送给统计服务。/);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /script-src[^;]+www\.googletagmanager\.com/);
    assert.match(csp, /connect-src[^;]+google-analytics\.com[^;]+analytics\.google\.com[^;]+www\.googletagmanager\.com/);
    assert.match(csp, /img-src[^;]+google-analytics\.com[^;]+www\.googletagmanager\.com/);
    for (const directive of [
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "media-src 'none'",
      "manifest-src 'none'"
    ]) assert.ok(csp.includes(directive), `missing restrictive CSP directive: ${directive}`);
  } finally {
    await browser.close();
  }
});

test('keeps keyboard focus inside modal dialogs and exposes the skip link in both browsers', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the modal focus and skip-link keyboard test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://**/*', (route) => route.abort());

  const assertFocusLoop = async (dialogSelector, iterations) => {
    await page.waitForFunction((selector) => {
      const dialog = document.querySelector(selector);
      return dialog?.open && dialog.contains(document.activeElement);
    }, dialogSelector);
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let index = 0; index < iterations; index += 1) {
        await page.keyboard.press(key);
        const focusState = await page.locator(dialogSelector).evaluate((dialog) => ({
          activeTag: document.activeElement?.tagName || '',
          activeId: document.activeElement?.id || '',
          inside: dialog.contains(document.activeElement)
        }));
        assert.equal(focusState.inside, true, `${key} moved focus outside ${dialogSelector}: ${JSON.stringify(focusState)}`);
      }
    }
  };

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#priceRows tr[data-market-id]'));

    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.skip-link').evaluate((element) => document.activeElement === element), true, 'the first Tab stop must be the skip link');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#priceWorkspace').evaluate((element) => document.activeElement === element), true, 'activating the skip link must move focus to the price workspace');
    assert.equal(new URL(page.url()).hash, '#priceWorkspace');

    const historyTrigger = page.locator('.country-history-button').first();
    await historyTrigger.click();
    await assertFocusLoop('#historyDialog', 10);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === false);
    await page.waitForFunction(() => document.activeElement === document.querySelector('.country-history-button'));
    assert.equal(await historyTrigger.evaluate((element) => document.activeElement === element), true, 'closing price history must restore its trigger focus');

    const publicationTrigger = page.locator('#publishedDateButton');
    await publicationTrigger.click();
    await assertFocusLoop('#publishedDateDialog', 4);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === false);
    await page.waitForFunction(() => document.activeElement === document.querySelector('#publishedDateButton'));
    assert.equal(await publicationTrigger.evaluate((element) => document.activeElement === element), true, 'closing publication history must restore its trigger focus');
  } finally {
    await browser.close();
  }
});

test('shows a usable explanation when JavaScript is disabled', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the no-JavaScript fallback test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, javaScriptEnabled: false });
  await page.route('https://**/*', (route) => route.abort());
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    const notice = page.locator('.noscript-notice');
    await notice.waitFor({ state: 'visible' });
    assert.equal(await notice.isVisible(), true);
    assert.match(await notice.innerText(), /JavaScript/);
    assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), 73);
    assert.equal(await page.locator('#minimumSummary .minimum-card').count(), 5);
    assert.equal(await page.getByText('中国大陆', { exact: true }).count(), 1);
    assert.equal(await page.getByText('日本', { exact: true }).count(), 1);
    assert.equal(await page.getByText('美国', { exact: true }).count(), 1);
  } finally {
    await browser.close();
  }
});

test('renders current prices, sorting, and country history in a real browser', { timeout: 60_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the UI smoke test');
  if (!browserConfig) return;

  const expectedData = await readFixture('prices.json');
  const expectedHistory = await readFixture('history.json');
  const historyCountry = Object.values(historyRecords(expectedHistory))
    .find((record) => expectedData.tiers.some(({ id }) => (
      canRenderExpectedChart(compactExpectedSeries(record.events, id))
    )))?.country;
  const server = await startServer();
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);

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
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('response', (response) => {
        if (response.url().startsWith(baseUrl)
          && response.status() >= 400) {
          errors.push(`${response.status()} ${response.url()}`);
        }
      });
      await page.route('https://**/*', (route) => {
        if (route.request().url().startsWith('https://www.googletagmanager.com/')) {
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        }
        return route.abort();
      });
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
        assert.match(await page.locator('#loadStatusText').textContent(), /正在检查最新价格/);
        assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'true');
        assert.equal(await page.locator('#searchInput').isDisabled(), true);
        assert.equal(await page.locator('#regionSelect').isDisabled(), true);
        assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), expectedData.countries.length, `${viewport.name} must show static prices before network hydration`);
        if (viewport.name === 'narrow-mobile') {
          assert.equal(await page.locator('.spinner').first().evaluate((element) => getComputedStyle(element).animationName), 'none');
        }
        if (viewport.name === 'desktop') {
          await page.waitForTimeout(1_600);
          assert.match(await page.locator('#loadStatusText').textContent(), /正在检查更新，当前价格仍可查看/);
        }
        releasePriceRequest();
        await page.waitForFunction(
          (count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count,
          expectedData.countries.length
        );
        assert.equal(await page.locator('th[data-tier-placeholder]').count(), 0, `${viewport.name} price header placeholders must be replaced after data validation`);
        const initialResources = await page.evaluate(() => performance.getEntriesByType('resource').map(({ name }) => name));
        assert.equal(initialResources.some((url) => url.includes('/data/history.json')), false, `${viewport.name} must defer history data`);
        assert.equal(initialResources.some((url) => url.includes('/vendor/chart.umd.min.js')), false, `${viewport.name} must defer Chart.js`);
        assert.equal(initialResources.some((url) => url.includes('/vendor/lucide.min.js')), false, `${viewport.name} must not load the full Lucide bundle`);
        assert.equal(initialResources.some((url) => url.includes('/vendor/lucide-subset.js')), true, `${viewport.name} must load the Lucide subset`);

        assert.equal(await page.locator('#marketCount').textContent(), `${expectedData.countries.length} 个地区`);
        assert.equal(await page.locator('#tierCount').textContent(), `${expectedData.tiers.length} 档`);
        assert.equal(await page.locator('#loadStatus').isVisible(), false, `${viewport.name} should hide loading status after price data arrives`);
        assert.equal(await page.locator('.workspace').getAttribute('aria-busy'), 'false');
        assert.equal(await page.locator('#searchInput').isEnabled(), true);
        assert.equal(await page.locator('#regionSelect').isEnabled(), true);
        assert.equal(await page.locator('.app-brand h1').textContent(), 'iCloud+ 全球价格对比');
        assert.equal(await page.locator('#overviewTitle').textContent(), '各容量全球最低价');
        assert.equal(await page.locator('.workspace-heading h2').textContent(), '全球 iCloud+ 月费');
        assert.equal(await page.locator('button[data-sort-tier]').count(), expectedData.tiers.length);
        if (viewport.width > 900) {
          const referenceBox = await page.locator('.overview-reference').boundingBox();
          const statsBox = await page.locator('.overview-stats').boundingBox();
          assert.ok(referenceBox && statsBox && statsBox.y >= referenceBox.y + referenceBox.height, `${viewport.name} metrics should form a separate row below the minimum summary`);
          assert.ok(referenceBox && statsBox && Math.abs(referenceBox.width - statsBox.width) <= 2, `${viewport.name} overview rows should share the same width`);
        }
        const sectionGaps = await page.evaluate(() => {
          const header = document.querySelector('.app-header').getBoundingClientRect();
          const reference = document.querySelector('.overview-reference').getBoundingClientRect();
          const stats = document.querySelector('.overview-stats').getBoundingClientRect();
          const workspace = document.querySelector('.workspace').getBoundingClientRect();
          return [reference.top - header.bottom, stats.top - reference.bottom, workspace.top - stats.bottom];
        });
        assert.ok(sectionGaps.every((gap) => gap >= 11 && gap <= 15), `${viewport.name} section gaps should stay compact: ${sectionGaps.join(', ')}`);
        assert.ok(Math.max(...sectionGaps) - Math.min(...sectionGaps) <= 1, `${viewport.name} section gaps should share one vertical rhythm: ${sectionGaps.join(', ')}`);
        const statValues = await page.locator('.overview-stats dd').evaluateAll((elements) => elements.map((element) => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent,
            color: style.color,
            fontSize: Number.parseFloat(style.fontSize)
          };
        }));
        assert.deepEqual(statValues.map(({ text }) => text), [`${expectedData.countries.length} 个地区`, `${new Set(expectedData.countries.map(({ currency }) => currency)).size} 种`, `${expectedData.tiers.length} 档`]);
        assert.equal(new Set(statValues.map(({ color }) => color)).size, 1, `${viewport.name} stat colors should have equal emphasis`);
        assert.equal(new Set(statValues.map(({ fontSize }) => fontSize)).size, 1, `${viewport.name} stat sizes should have equal emphasis`);
        assert.ok(statValues.every(({ fontSize }) => fontSize >= 13), `${viewport.name} compact stats should remain readable`);
        const statCards = await page.locator('.overview-stats > div').evaluateAll((elements) => elements.map((element) => {
          const style = getComputedStyle(element);
          return { backgroundColor: style.backgroundColor, borderColor: style.borderColor };
        }));
        assert.equal(new Set(statCards.map(({ backgroundColor }) => backgroundColor)).size, 1, `${viewport.name} stat backgrounds should have equal emphasis`);
        assert.equal(new Set(statCards.map(({ borderColor }) => borderColor)).size, 1, `${viewport.name} stat borders should have equal emphasis`);
        assert.equal(await page.locator('#minimumSummary > button').count(), expectedData.tiers.length);
        for (const tier of expectedData.tiers) {
          const lowest = expectedData.countries.find((country) => country.plans[tier.id].cnyRank === 1);
          const summaryText = await page.locator('#minimumSummary > button').evaluateAll((items, label) => {
            const item = items.find((element) => element.querySelector('.minimum-tier-label')?.textContent === label);
            return item?.textContent ?? '';
          }, tier.label);
          assert.ok(summaryText.includes(lowest.nameZh || lowest.country));
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
        if (viewport.width <= 1100) {
          const mobileControlMetrics = await page.locator('#searchInput, #regionSelect').evaluateAll((controls) => controls.map((control) => ({
            fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
            height: control.getBoundingClientRect().height
          })));
          assert.ok(mobileControlMetrics.every(({ fontSize }) => fontSize >= 16), `${viewport.name} form controls must not trigger iOS focus zoom`);
          assert.ok(mobileControlMetrics.every(({ height }) => height >= 44), `${viewport.name} form controls must retain comfortable touch targets`);
          const mobileTierHeights = await page.locator('#mobileTierControl button').evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
          assert.ok(mobileTierHeights.every((height) => height >= 44), `${viewport.name} tier controls must retain comfortable touch targets`);
        }
        if (viewport.width <= 640) {
          const sourceTargetHeights = await page.locator('.source-item, .source-meta-button').evaluateAll((targets) => targets.map((target) => target.getBoundingClientRect().height));
          assert.ok(sourceTargetHeights.every((height) => height >= 44), `${viewport.name} source actions must retain comfortable touch targets`);
        }
        if (viewport.name === 'narrow-mobile') {
          const metricLabels = await page.locator('.overview-stats dt > span:last-child').evaluateAll((labels) => labels.map((label) => ({
            height: label.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(label).lineHeight)
          })));
          assert.ok(metricLabels.every(({ height, lineHeight }) => height <= lineHeight * 1.2), '320px metric labels must stay on one line');
        }
        const semanticAlignments = await page.evaluate(() => ({
          minimumCard: getComputedStyle(document.querySelector('#minimumSummary .minimum-card')).textAlign,
          metricCard: getComputedStyle(document.querySelector('.overview-stats > div')).textAlign,
          rankHeader: getComputedStyle(document.querySelector('.price-table .rank-column')).textAlign,
          countryHeader: getComputedStyle(document.querySelector('.price-table th:nth-child(2)')).textAlign,
          priceHeader: getComputedStyle(document.querySelector('.price-table th[data-tier-header]')).textAlign,
          countryCell: getComputedStyle(document.querySelector('#priceRows tr[data-market-id] td:nth-child(2)')).textAlign,
          priceCell: getComputedStyle(document.querySelector('#priceRows tr[data-market-id] .price-cell')).textAlign
        }));
        assert.deepEqual(semanticAlignments, {
          minimumCard: 'left',
          metricCard: 'start',
          rankHeader: 'center',
          countryHeader: 'left',
          priceHeader: 'right',
          countryCell: 'left',
          priceCell: 'right'
        }, 'cards and the main comparison table must follow semantic alignment rules');
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
        assert.ok(await page.locator('#sourceLinks svg').count() >= 4);
        assert.match(sourceText, /价格来源：Apple/);
        assert.match(sourceText, /Apple 价格页更新/);
        const fxAttribution = page.locator('a[href="https://www.exchangerate-api.com"]');
        assert.match((await fxAttribution.textContent()).trim(), /参考汇率：ExchangeRate-API$/);
        assert.equal(await fxAttribution.getAttribute('aria-label'), null);
        assert.equal(await page.getByRole('link', { name: /参考汇率：ExchangeRate-API/ }).count(), 1);
        assert.match(sourceText, /汇率更新：/);
        const labelInNameFailures = await page.locator('#minimumSummary .minimum-card, .country-history-button, #publishedDateButton').evaluateAll((controls) => controls.flatMap((control) => {
          const normalize = (value) => value.replace(/\s+/g, ' ').trim();
          const visibleText = normalize(control.innerText);
          const accessibleName = normalize(control.getAttribute('aria-label') || visibleText);
          return accessibleName.includes(visibleText) ? [] : [{ visibleText, accessibleName }];
        }));
        assert.deepEqual(labelInNameFailures, [], `${viewport.name} interactive labels must contain their visible text in order`);
        const layout = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        }));
        assert.ok(layout.documentWidth <= layout.viewportWidth + 1, `${viewport.name} page has unexpected body overflow`);
        if (process.env.SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `${viewport.name}.png`) });
        }

        const searchableCountry = expectedData.countries.find(({ nameZh, country }) => nameZh && nameZh !== country) ?? expectedData.countries[0];
        const firstCountry = searchableCountry.country;
        const firstTier = expectedData.tiers[0].id;
        const tierSortControl = viewport.width <= 1100
          ? page.locator(`#mobileTierControl button[data-tier="${firstTier}"]`)
          : page.locator(`button[data-sort-tier="${firstTier}"]`);
        await page.locator('#searchInput').fill(searchableCountry.nameZh || firstCountry);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        await page.locator('#searchInput').fill('不存在的国家或币种');
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 0);
        const emptyResultCell = page.locator('#priceRows .empty-cell');
        assert.match(await emptyResultCell.textContent(), /没有符合当前条件的结果/);
        assert.equal(await emptyResultCell.isVisible(), true, `${viewport.name} empty-result message must remain visible`);
        await page.locator('#searchInput').fill('');
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, expectedData.countries.length);
        await page.locator('#regionSelect').selectOption(searchableCountry.region);
        await page.locator('#searchInput').fill(searchableCountry.nameZh || firstCountry);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        await tierSortControl.click();
        assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), 1, 'combined search, region, and tier sorting should retain the matching country');
        await page.locator('#searchInput').fill('');
        await page.locator('#regionSelect').selectOption('all');

        await page.locator('button[data-sort="country"]').click();
        assert.equal(await page.locator('button[data-sort="country"]').locator('xpath=ancestor::th').getAttribute('aria-sort'), 'ascending');
        await page.locator('button[data-sort="country"]').click();
        assert.equal(await page.locator('button[data-sort="country"]').locator('xpath=ancestor::th').getAttribute('aria-sort'), 'descending');

        await tierSortControl.click();
        assert.equal(
          await page.locator(`button[data-sort-tier="${firstTier}"]`).locator('xpath=ancestor::th').getAttribute('aria-sort'),
          'ascending'
        );

        const historySearch = historyCountry ?? firstCountry;
        const expectedRecord = historyRecordForCountry(expectedHistory, expectedData, historySearch);
        await page.locator('#searchInput').fill(historySearch);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        const historyRow = page.locator('#priceRows tr[data-market-id]').first();
        const historyButton = historyRow.locator('button.country-history-button');
        assert.equal(await historyRow.getAttribute('tabindex'), null, 'table rows should not masquerade as interactive controls');
        assert.equal(await historyButton.count(), 1, 'each country should expose a real history button');
        if (viewport.name === 'desktop') {
          await page.evaluate(() => {
            document.body.tabIndex = -1;
            document.body.focus();
            document.body.removeAttribute('tabindex');
          });
          if (BROWSER_UNDER_TEST === 'webkit') {
            await page.locator('.skip-link').focus();
          } else {
            await page.keyboard.press('Tab');
          }
          assert.equal(await page.locator('.skip-link').evaluate((element) => document.activeElement === element), true, 'skip link must be the first keyboard stop');
          await page.keyboard.press('Enter');
          assert.equal(await page.locator('#priceWorkspace').evaluate((element) => document.activeElement === element), true, 'skip link must move focus to the price workspace');
          await historyButton.focus();
          await page.keyboard.press('Enter');
        } else {
          await historyRow.locator('.price-cell').first().click();
        }
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
        if (expectedRecord) {
          await page.waitForFunction((count) => document.querySelectorAll('#historyRows tr').length === count, expectedRecord.events.length);
        }
        assert.equal(await page.locator('th[data-history-tier-placeholder]').count(), 0, `${viewport.name} history header placeholders must be replaced before the dialog is announced`);
        const expectedDialogName = expectedData.countries.find(({ country }) => country === historySearch)?.nameZh || historySearch;
        assert.equal(await page.getByRole('dialog', { name: expectedDialogName }).count(), 1, 'history dialog must have an accessible name');
        assert.ok(await page.locator('#historyRows tr').count() > 0);
        assert.deepEqual(
          await page.locator('#historyDialog thead th').evaluateAll((headers) => headers.slice(0, 3).map((header) => getComputedStyle(header).textAlign)),
          ['left', 'left', 'right'],
          'history dates and currency labels must align left while comparable prices align right'
        );
        assert.deepEqual(
          await page.locator('#historyDialog thead th').evaluateAll((headers) => headers.map((header) => header.getAttribute('scope'))),
          Array.from({ length: expectedData.tiers.length + 2 }, () => 'col'),
          'all generated history headers need column scope'
        );
        assert.equal(await page.locator('#historyTierControl button').count(), expectedData.tiers.length);
        if (viewport.width <= 1100) {
          const dialogTouchTargets = await page.locator('#closeHistory, #historyTierControl button').evaluateAll((targets) => targets.map((target) => ({
            width: target.getBoundingClientRect().width,
            height: target.getBoundingClientRect().height
          })));
          assert.ok(dialogTouchTargets.every(({ width, height }) => width >= 44 && height >= 44), `${viewport.name} history dialog controls must retain comfortable touch targets`);
        }
        if (viewport.width <= 640) {
          const mobileHistoryLayout = await page.locator('#historyDialog .history-table-scroll').evaluate((scroller) => ({
            clientWidth: scroller.clientWidth,
            scrollWidth: scroller.scrollWidth,
            visibleHeaders: [...scroller.querySelectorAll('thead th')].filter((header) => getComputedStyle(header).display !== 'none').length,
            visibleTierHeaders: [...scroller.querySelectorAll('thead th[data-history-tier-header]')].filter((header) => getComputedStyle(header).display !== 'none').map((header) => header.dataset.tier)
          }));
          assert.ok(mobileHistoryLayout.scrollWidth <= mobileHistoryLayout.clientWidth + 1, `${viewport.name} history table must not require horizontal scrolling`);
          assert.equal(mobileHistoryLayout.visibleHeaders, 3, `${viewport.name} history table should show date, currency, and the active tier`);
          assert.deepEqual(mobileHistoryLayout.visibleTierHeaders, [firstTier], `${viewport.name} history table should only show the selected tier`);
        }
        const tierLayout = await page.locator('#historyTierControl').evaluate((control) => ({
          declaredCount: control.style.getPropertyValue('--tier-count'),
          renderedColumns: getComputedStyle(control).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
        }));
        assert.equal(tierLayout.declaredCount, String(expectedData.tiers.length));
        assert.equal(tierLayout.renderedColumns, expectedData.tiers.length);
        const expectedCountry = expectedData.countries.find(({ country }) => country === historySearch);
        if (expectedCountry) {
          assert.match(await page.locator('#historyLocalPrice').textContent(), new RegExp(expectedCountry.plans[firstTier].formattedPrice.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        }
        if (expectedRecord) {
          const expectedRows = [...expectedRecord.events].reverse().map((event) => [
            formatUiDate(event.observedAt),
            event.currency,
            ...expectedData.tiers.map(({ id }) => Number.isFinite(event.plans[id]) ? uiNumberFormatter.format(event.plans[id]) : '--')
          ]);
          assert.deepEqual(
            await page.locator('#historyRows tr').evaluateAll((rows) => rows.map((row) => (
              [...row.cells].map((cell) => cell.textContent.trim())
            ))),
            expectedRows,
            'every history row must preserve its exact date, currency, and tier prices'
          );
        }
        if (historyCountry) {
          const chartableTier = expectedData.tiers.find(({ id }) => (
            canRenderExpectedChart(compactExpectedSeries(expectedRecord.events, id))
          ));
          assert.ok(chartableTier, `${historyCountry} must retain a chartable tier for the chart assertions`);
          if (viewport.name === 'desktop') {
            for (const [tierIndex, tier] of expectedData.tiers.entries()) {
              await page.locator(`#historyTierControl button[data-tier="${tier.id}"]`).click();
              const expectedSeries = compactExpectedSeries(expectedRecord.events, tier.id);
              const canChart = canRenderExpectedChart(expectedSeries);
              assert.equal(await page.locator('#chartWrap').isVisible(), canChart, `${tier.id} chart visibility must match its history series`);
              if (!canChart) continue;

              await page.waitForFunction((expectedLength) => {
                const chart = window.Chart?.getChart?.(document.querySelector('#historyChart'));
                return chart?.data?.datasets?.[0]?.data?.length === expectedLength;
              }, expectedSeries.length);
              const chartData = await page.locator('#historyChart').evaluate((canvas) => {
                const chart = window.Chart.getChart(canvas);
                return {
                  labels: [...chart.data.labels],
                  prices: [...chart.data.datasets[0].data]
                };
              });
              const tableRows = await page.locator('#historyRows tr').evaluateAll((rows, columnIndex) => rows.map((row) => ({
                date: row.cells[0].textContent.trim(),
                currency: row.cells[1].textContent.trim(),
                price: row.cells[columnIndex].textContent.trim()
              })), tierIndex + 2);
              const chronologicalRows = tableRows.reverse()
                .filter(({ price }) => price !== '--')
                .map((row) => ({ ...row, price: Number(row.price.replaceAll(',', '')) }));
              const tableSeries = chronologicalRows.filter((row, index) => (
                index === 0
                || row.currency !== chronologicalRows[index - 1].currency
                || row.price !== chronologicalRows[index - 1].price
              ));

              assert.deepEqual(chartData.labels, expectedSeries.map(({ observedAt }) => formatUiDate(observedAt)), `${tier.id} chart dates must match the source history`);
              assert.deepEqual(chartData.prices, expectedSeries.map((event) => event.plans[tier.id]), `${tier.id} chart prices must match the source history`);
              assert.deepEqual(chartData.labels, tableSeries.map(({ date }) => date), `${tier.id} chart dates must match the compacted table history`);
              assert.deepEqual(chartData.prices, tableSeries.map(({ price }) => price), `${tier.id} chart prices must match the compacted table history`);
            }
          }
          await page.locator(`#historyTierControl button[data-tier="${chartableTier.id}"]`).click();
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
          const chartAccessibility = await page.locator('#historyChart').evaluate((canvas) => ({
            label: canvas.getAttribute('aria-label'),
            animationDuration: window.Chart.getChart(canvas)?.options?.animation?.duration
          }));
          assert.match(chartAccessibility.label, new RegExp(expectedDialogName), `${viewport.name} chart must identify the active country`);
          assert.match(chartAccessibility.label, new RegExp(chartableTier.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${viewport.name} chart must identify the active tier`);
          if (viewport.name === 'narrow-mobile') assert.equal(chartAccessibility.animationDuration, 0, 'reduced motion must disable chart animation');
        }
        if (viewport.name === 'desktop') await page.keyboard.press('Escape');
        else await page.locator('#closeHistory').click();
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === false);
        await page.waitForFunction(() => document.activeElement?.classList?.contains('country-history-button'));
        assert.equal(await historyButton.evaluate((element) => document.activeElement === element), true, 'closing history must restore the real history button focus');

        const publishedDateAffordance = await page.locator('#publishedDateButton').evaluate((button) => ({
          cursor: getComputedStyle(button).cursor,
          iconCount: button.querySelectorAll('svg').length
        }));
        assert.equal(publishedDateAffordance.cursor, 'pointer');
        assert.equal(publishedDateAffordance.iconCount, 1, 'publication-date control should only keep the leading calendar icon');

        await page.locator('#publishedDateButton').focus();
        await page.locator('#publishedDateButton').click();
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === true);
        assert.equal(await page.getByRole('dialog', { name: 'Apple 价格页更新记录' }).count(), 1, 'publication-date dialog must have an accessible name');
        if (viewport.width <= 1100) {
          const closePublishedDateBox = await page.locator('#closePublishedDate').boundingBox();
          assert.ok(closePublishedDateBox && closePublishedDateBox.width >= 44 && closePublishedDateBox.height >= 44, `${viewport.name} publication dialog close control must retain a comfortable touch target`);
        }
        assert.equal(await page.locator('#publishedDateRows tr').count(), expectedHistory.sourcePublishedDates.length);
        assert.equal(
          (await page.locator('#publishedDateRows tr').first().locator('td').first().textContent()).trim(),
          formatUiDate(expectedHistory.sourcePublishedDates.at(-1).publishedDate)
        );
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === false);
        await page.waitForFunction(() => document.activeElement?.id === 'publishedDateButton');

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

test('excludes history events from before a tier was introduced', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the tier introduction history regression test');
  if (!browserConfig) return;

  const expectedData = await readFixture('prices.json');
  const history = await readFixture('history.json');
  const countryName = '\u0054\u00fcrkiye';
  const tierId = '200GB';
  const patchedHistory = structuredClone(history);
  const targetRecord = historyRecordForCountry(patchedHistory, expectedData, countryName);
  assert.ok(targetRecord?.events.length >= 3, 'the regression fixture needs multiple history events');
  delete targetRecord.events[0].plans[tierId];
  const expectedSeries = compactExpectedSeries(targetRecord.events, tierId);
  assert.equal(expectedSeries.length, 2, 'the fixture should produce two comparable tier events');

  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('https://**/*', (route) => {
    if (route.request().url().startsWith('https://www.googletagmanager.com/')) {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    }
    return route.abort();
  });
  await page.route('**/data/history.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(patchedHistory)
  }));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, expectedData.countries.length);
    await page.locator('#searchInput').fill(countryName);
    const historyButton = page.locator('#priceRows tr[data-market-id]').first().locator('button.country-history-button');
    await historyButton.click();
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
    await page.locator(`#historyTierControl button[data-tier="${tierId}"]`).click();
    await page.waitForFunction(() => !document.querySelector('#chartWrap')?.hidden);
    await page.waitForFunction(() => window.Chart?.getChart?.(document.querySelector('#historyChart'))?.data?.labels?.length === 2);

    const chartData = await page.locator('#historyChart').evaluate((canvas) => {
      const chart = window.Chart.getChart(canvas);
      return {
        labels: [...chart.data.labels],
        prices: [...chart.data.datasets[0].data],
        ariaLabel: canvas.getAttribute('aria-label')
      };
    });
    assert.deepEqual(chartData.labels, expectedSeries.map(({ observedAt }) => formatUiDate(observedAt)));
    assert.deepEqual(chartData.prices, expectedSeries.map((event) => event.plans[tierId]));
    assert.doesNotMatch(chartData.ariaLabel, /NaN|undefined/);

    const oldEventDate = formatUiDate(targetRecord.events[0].observedAt);
    const oldEventTierCell = await page.locator('#historyRows tr').evaluateAll((rows, date) => {
      const row = rows.find((candidate) => candidate.cells[0]?.textContent.trim() === date);
      return row?.querySelector('[data-history-tier="200GB"]')?.textContent.trim();
    }, oldEventDate);
    assert.equal(oldEventTierCell, '--', 'pre-introduction events should remain visibly unavailable in the table');
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('adapts table and history controls to a different tier count', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the dynamic-tier UI test');
  if (!browserConfig) return;
  const expectedData = await readFixture('prices.json');
  const expectedHistory = await readFixture('history.json');
  const threeTierData = structuredClone(expectedData);
  threeTierData.tiers = threeTierData.tiers.slice(0, 3);
  const retainedTierIds = new Set(threeTierData.tiers.map(({ id }) => id));
  for (const country of threeTierData.countries) {
    country.plans = Object.fromEntries(
      Object.entries(country.plans).filter(([tierId]) => retainedTierIds.has(tierId))
    );
  }
  threeTierData.run.pricePoints = threeTierData.countries.length * threeTierData.tiers.length;
  const threeTierHistory = structuredClone(expectedHistory);
  for (const record of Object.values(historyRecords(threeTierHistory))) {
    for (const event of record.events) {
      event.plans = Object.fromEntries(
        Object.entries(event.plans).filter(([tierId]) => retainedTierIds.has(tierId))
      );
    }
  }
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/data/prices.json*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(threeTierData)
    }));
    await page.route('**/data/history.json*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(threeTierHistory)
    }));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
    assert.equal(await page.locator('th[data-tier-header]').count(), 3);
    await page.locator('button.country-history-button').first().click();
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
    const layout = await page.locator('#historyTierControl').evaluate((control) => ({
      buttons: control.querySelectorAll('button').length,
      declaredCount: control.style.getPropertyValue('--tier-count'),
      renderedColumns: getComputedStyle(control).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
    }));
    assert.deepEqual(layout, { buttons: 3, declaredCount: '3', renderedColumns: 3 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
    await page.close();
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('renders every rank-one market without inventing a single winner', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the tied reference-minimum UI test');
  if (!browserConfig) return;
  const data = await readFixture('prices.json');
  const tier = data.tiers[0];
  const winners = [...data.countries]
    .sort((first, second) => first.marketId.localeCompare(second.marketId, 'en'))
    .slice(0, 4);
  for (const country of winners) country.plans[tier.id].cnyPrice = 1;
  rerankPriceFixture(data);
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data)
  }));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, data.countries.length);
    const expectedNames = winners.slice(0, 3).map((country) => country.nameZh || country.country).join('、');
    const card = page.locator(`#minimumSummary button[data-tier="${tier.id}"]`);
    assert.match(await card.locator('.minimum-country').textContent(), new RegExp(`^${expectedNames}等 4 个地区$`));
    assert.equal(await page.locator(`.price-cell[data-tier="${tier.id}"].is-minimum`).count(), 4);
  } finally {
    await page.close();
    await browser.close();
  }
});

test('shows an actionable error and recovers after a temporary price-data outage', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the UI error-state test');
  if (!browserConfig) return;
  const expectedData = await readFixture('prices.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
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
    assert.equal(await page.locator('#loadStatusText').textContent(), '暂时无法获取更新，当前显示最近一次可用价格');
    assert.equal(await page.locator('#retryButton').textContent(), '重试');
    await page.locator('#retryButton').click();
    await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, expectedData.countries.length);
    assert.equal(await page.locator('#loadStatus').isVisible(), false);
    assert.equal(await page.locator('.data-status').evaluate((element) => element.classList.contains('is-error')), false);
    assert.equal(attempts, 2);
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps current prices usable when optional history data is unavailable or malformed', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the history fallback test');
  if (!browserConfig) return;
  const expectedData = await readFixture('prices.json');
  const validHistory = await readFixture('history.json');
  const staleHistory = structuredClone(validHistory);
  staleHistory.sourcePublishedDates = staleHistory.sourcePublishedDates.slice(0, 1);
  const reversedHistory = structuredClone(validHistory);
  const reversibleRecord = Object.values(historyRecords(reversedHistory)).find((record) => record.events.length > 1);
  reversibleRecord.events.reverse();
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    const scenarios = [
      { status: 503, body: '{"error":"history temporarily unavailable"}', unavailable: true },
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
        }),
        unavailable: true
      },
      {
        status: 200,
        body: JSON.stringify(staleHistory),
        expectedPublishedDate: '2026/07/17'
      },
      {
        status: 200,
        body: JSON.stringify(reversedHistory),
        unavailable: true
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
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, expectedData.countries.length);
        assert.equal(await page.locator('#loadStatus').isVisible(), false);
        assert.equal(await page.locator('#marketCount').textContent(), `${expectedData.countries.length} 个地区`);
        assert.equal(await page.locator('#publishedDateButton').isVisible(), true);
        if (scenario.expectedPublishedDate) {
          assert.equal(await page.locator('#applePublishedDate').textContent(), scenario.expectedPublishedDate);
        }
        if (scenario.unavailable) {
          await page.locator('#priceRows tr[data-market-id]').first().click();
          await page.waitForFunction(() => document.querySelector('#historySubtitle')?.textContent.includes('暂时无法读取历史记录'));
          await page.locator('#closeHistory').click();
          await page.locator('#publishedDateButton').click();
          await page.waitForFunction(() => document.querySelector('#publishedDateRows')?.textContent.includes('暂时无法读取更新记录'));
          await page.locator('#closePublishedDate').click();
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

test('rejects malformed price payloads and recovers without a full-page refresh', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the malformed-data UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const corruptions = [
    ['duplicate country', (data) => data.countries.push(structuredClone(data.countries[0]))],
    ['missing derived CNY price', (data) => { delete data.countries[0].plans[data.tiers[0].id].cnyPrice; }],
    ['forbidden raw FX rates', (data) => { data.fx.rates = { USD: 1, CNY: 7 }; }],
    ['invalid generated timestamp', (data) => { data.generatedAt = '2026-02-30T00:00:00.000Z'; }],
    ['invalid FX timestamp', (data) => { data.fx.fetchedAt = '2026-02-30'; }],
    ['invalid Apple publication date', (data) => { data.source.publishedDate = 'February 30, 2026'; }],
    ['missing region', (data) => { data.countries[0].region = ''; }],
    ['unknown region', (data) => { data.countries[0].region = 'Unknown Region'; }],
    ['empty formatted price', (data) => { data.countries[0].plans[data.tiers[0].id].formattedPrice = '   '; }]
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
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
        assert.equal(await page.locator('#loadStatusText').textContent(), '暂时无法获取更新，当前显示最近一次可用价格', label);
        assert.equal(await page.locator('#searchInput').isDisabled(), true, label);
        serveValidData = true;
        await page.locator('#retryButton').click();
        await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
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

test('rebuilds tier headers and filters after a successful retry with changed tiers', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the changed-tier retry test');
  if (!browserConfig) return;
  const fullData = await readFixture('prices.json');
  const reducedData = structuredClone(fullData);
  const removedTier = reducedData.tiers.pop();
  for (const country of reducedData.countries) delete country.plans[removedTier.id];
  reducedData.run.pricePoints = reducedData.countries.length * reducedData.tiers.length;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  let priceCalls = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/data/prices.json*', (route) => {
      priceCalls += 1;
      const body = JSON.stringify(priceCalls === 1 ? fullData : reducedData);
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((count) => document.querySelector('#tierCount')?.textContent === `${count} 档`, fullData.tiers.length);
      await page.locator('#retryButton').dispatchEvent('click');
      await page.waitForFunction((count) => document.querySelector('#tierCount')?.textContent === `${count} 档`, reducedData.tiers.length);
      assert.equal(await page.locator('.price-table thead th').count(), reducedData.tiers.length + 2);
      assert.equal(await page.locator('#priceRows tr[data-market-id]').first().locator('td').count(), reducedData.tiers.length + 2);
      assert.deepEqual(
        await page.locator('.price-table thead button[data-sort-tier]').evaluateAll((buttons) => buttons.map((button) => button.dataset.sortTier)),
        reducedData.tiers.map(({ id }) => id)
      );
      assert.equal(await page.locator('#regionSelect option').count(), new Set(reducedData.countries.map(({ region }) => region)).size + 1);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('marks stale data clearly and falls back from an invalid tier query', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the stale-data UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const referenceNow = Date.now();
  const scenarios = [
    {
      label: 'old snapshot',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow - (48 * 60 * 60 * 1_000)).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = false;
      },
      expected: /价格暂未更新/,
      minimumDegraded: true
    },
    {
      label: 'future snapshot',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow + (4 * 60 * 1_000)).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = false;
      },
      expected: /更新于/,
      expectedStale: false
    },
    {
      label: 'maximum allowed future skew',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow + (5 * 60 * 1_000)).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = false;
      },
      expected: /更新于/,
      expectedStale: false
    },
    {
      label: 'maximum usable historical age',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow - (7 * 24 * 60 * 60 * 1_000)).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = false;
      },
      expected: /价格暂未更新/,
      minimumDegraded: true
    },
    {
      label: 'fallback rates',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = true;
        data.fx.fallbackReason = 'request-failed';
      },
      expected: /参考汇率暂未更新/,
      minimumDegraded: true
    },
    {
      label: 'old snapshot with fallback rates',
      mutate: (data) => {
        setPayloadGeneratedAt(data, new Date(referenceNow - (48 * 60 * 60 * 1_000)).toISOString());
        data.fx.fetchedAt = data.generatedAt;
        data.fx.stale = true;
        data.fx.fallbackReason = 'request-failed';
      },
      expected: /价格暂未更新/,
      minimumDegraded: true
    }
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    for (const { label, mutate, expected, expectedPublishedDate, minimumDegraded = false, expectedStale = true } of scenarios) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.addInitScript((nowMs) => { Date.now = () => nowMs; }, referenceNow);
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
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
        assert.match(await page.locator('#updatedAt').textContent(), expected, label);
        if (expectedPublishedDate) {
          assert.equal(await page.locator('#applePublishedDate').textContent(), expectedPublishedDate, label);
        }
        assert.equal(await page.locator('.data-status').evaluate((element) => element.classList.contains('is-stale')), expectedStale, label);
        assert.equal(await page.locator('.minimum-badge').count(), minimumDegraded ? 0 : validData.tiers.length, label);
        assert.equal(await page.locator('.rank-top').count(), minimumDegraded ? 0 : 3, label);
        if (minimumDegraded) {
          assert.match(
            await page.locator('#minimumSummary').textContent(),
            label.includes('snapshot') || label.includes('historical')
              ? /价格暂未更新/
              : /参考汇率暂未更新.*最近一次可用汇率/,
            label
          );
        }
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
        assert.match(await page.locator('#resultSummary').textContent(), /200GB/);
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

test('reclassifies long-lived pages across lifecycle boundaries without replacing equal snapshots', { timeout: 45_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the long-lived freshness lifecycle test');
  if (!browserConfig) return;
  const fixture = await readFixture('prices.json');
  const history = await readFixture('history.json');
  const referenceNow = Date.now();
  const original = structuredClone(fixture);
  setPayloadGeneratedAt(original, new Date(referenceNow - (35 * 60 * 60 * 1_000) - (59 * 60 * 1_000)).toISOString());
  original.fx.fetchedAt = original.generatedAt;
  original.fx.stale = false;
  const refreshed = structuredClone(fixture);
  setPayloadGeneratedAt(refreshed, new Date(Date.parse(original.generatedAt) + (7 * 24 * 60 * 60 * 1_000)).toISOString());
  refreshed.fx.fetchedAt = refreshed.generatedAt;
  refreshed.fx.stale = false;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  let serveRefreshed = false;
  let priceCalls = 0;
  let historyCalls = 0;
  await page.addInitScript((nowMs) => { Date.now = () => nowMs; }, referenceNow);
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => {
    priceCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(serveRefreshed ? refreshed : original)
    });
  });
  await page.route('**/data/history.json*', (route) => {
    historyCalls += 1;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('.minimum-badge').length === count, fixture.tiers.length);
    assert.equal(await page.locator('#overviewTitle').textContent(), '各容量全球最低价');

    await page.locator('#priceRows tr[data-market-id]').first().click();
    await page.waitForFunction(() => document.querySelector('#historySubtitle')?.textContent.includes('历史数据暂不可用') === false);
    await page.locator('#closeHistory').click();
    const historyCallsAfterLoad = historyCalls;
    assert.ok(historyCallsAfterLoad >= 1);

    await page.evaluate((nowMs) => {
      Date.now = () => nowMs;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, Date.parse(original.generatedAt) + (36 * 60 * 60 * 1_000) + 1);
    await page.waitForFunction(() => document.querySelector('#updatedAt')?.textContent.includes('价格暂未更新'));
    assert.equal(await page.locator('.minimum-card').count(), 0);
    assert.equal(await page.locator('.minimum-badge').count(), 0);
    assert.equal(await page.locator('.price-cell.is-minimum').count(), 0);
    assert.equal(await page.locator('.rank-top').count(), 0);
    assert.equal(await page.locator('#searchInput').isEnabled(), true);
    await page.locator('#retryButton').dispatchEvent('click');
    await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
    assert.equal(await page.locator('#overviewTitle').textContent(), '各容量全球最低价', 'an equal network snapshot must still use current time');
    assert.equal(await page.locator('#searchInput').isEnabled(), true);
    assert.equal(historyCalls, historyCallsAfterLoad, 'an equal snapshot freshness change must retain loaded history');

    serveRefreshed = true;
    await page.evaluate((nowMs) => {
      Date.now = () => nowMs;
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }, Date.parse(original.generatedAt) + (7 * 24 * 60 * 60 * 1_000) + 1);
    await page.waitForFunction(() => document.querySelector('#overviewTitle')?.textContent === '各容量全球最低价');
    assert.ok(priceCalls >= 3, 'crossing seven days must force a network refresh');
    assert.equal(await page.locator('#retryButton').isHidden(), true);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('normalizes transient network warnings after an equal-snapshot retry', { timeout: 45_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the equal-snapshot retry normalization test');
  if (!browserConfig) return;
  const fixture = await readFixture('prices.json');
  const history = await readFixture('history.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    const scenarios = [
      {
        label: 'fresh',
        nowMs: Date.parse(fixture.generatedAt) + (60 * 60 * 1_000),
        expectedWarning: null
      },
      {
        label: 'price-stale',
        nowMs: Date.parse(fixture.generatedAt) + (48 * 60 * 60 * 1_000),
        expectedWarning: /价格暂未更新/
      }
    ];
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      let priceCalls = 0;
      let historyCalls = 0;
      await page.addInitScript((nowMs) => { Date.now = () => nowMs; }, scenario.nowMs);
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => {
        priceCalls += 1;
        if (priceCalls === 2) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
      });
      await page.route('**/data/history.json*', (route) => {
        historyCalls += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(history) });
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, fixture.countries.length);
        await page.locator('#priceRows tr[data-market-id]').first().click();
        await page.waitForFunction(() => document.querySelectorAll('#historyRows tr').length > 0);
        await page.locator('#closeHistory').click();
        const loadedHistoryCalls = historyCalls;

        await page.locator('#retryButton').dispatchEvent('click');
        await page.waitForFunction(() => document.querySelector('.cache-warning') !== null);
        assert.equal(await page.locator('#retryButton').isVisible(), true, scenario.label);

        await page.locator('#retryButton').click();
        await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
        assert.equal(await page.locator('.cache-warning').count(), 0, scenario.label);
        assert.equal(await page.locator('#retryButton').isHidden(), true, scenario.label);
        assert.equal(await page.locator('#searchInput').isEnabled(), true, scenario.label);
        assert.equal(await page.locator('#regionSelect').isEnabled(), true, scenario.label);
        assert.equal(await page.locator('button[data-sort]').first().isEnabled(), true, scenario.label);
        assert.equal(await page.locator('#publishedDateButton').isEnabled(), true, scenario.label);
        assert.equal(
          await page.locator('.data-status').evaluate((element) => element.classList.contains('is-stale')),
          scenario.expectedWarning !== null,
          scenario.label
        );
        if (scenario.expectedWarning) {
          assert.match(await page.locator('.freshness-warning').textContent(), scenario.expectedWarning, scenario.label);
        } else {
          assert.equal(await page.locator('.freshness-warning').count(), 0, scenario.label);
        }
        await page.locator('#priceRows tr[data-market-id]').first().click();
        await page.waitForFunction(() => document.querySelectorAll('#historyRows tr').length > 0);
        assert.equal(historyCalls, loadedHistoryCalls, `${scenario.label} equal snapshot must retain loaded history`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('shows an explicit expired state when lifecycle refresh fails', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the expired lifecycle failure test');
  if (!browserConfig) return;
  const payload = await readFixture('prices.json');
  const referenceNow = Date.now();
  setPayloadGeneratedAt(payload, new Date(referenceNow - (7 * 24 * 60 * 60 * 1_000)).toISOString());
  payload.fx.fetchedAt = payload.generatedAt;
  payload.fx.stale = false;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  let failRefresh = false;
  await page.addInitScript((nowMs) => { Date.now = () => nowMs; }, referenceNow);
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => (
    failRefresh
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) })
  ));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, payload.countries.length);
    assert.equal(await page.locator('#overviewTitle').textContent(), '各容量全球最低价', 'exactly seven days remains degraded');
    await page.locator('#priceRows tr[data-market-id]').first().click();
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
    failRefresh = true;
    await page.evaluate((nowMs) => {
      Date.now = () => nowMs;
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    }, Date.parse(payload.generatedAt) + (7 * 24 * 60 * 60 * 1_000) + 1);
    await page.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await page.locator('#historyDialog').evaluate((dialog) => dialog.open), false);
    const expiredHistoryButton = page.locator('.country-history-button').first();
    assert.equal(await expiredHistoryButton.isDisabled(), true);
    await expiredHistoryButton.evaluate((button) => button.click());
    assert.equal(await page.locator('#historyDialog').evaluate((dialog) => dialog.open), false);
    assert.match(await page.locator('#loadStatusText').textContent(), /价格已经较久没有更新.*请稍后重试/);
    assert.equal(await page.locator('#searchInput').isDisabled(), true);
    assert.equal(await page.locator('.minimum-badge').count(), 0);
    assert.match(await page.locator('#minimumSummary').textContent(), /价格已经较久没有更新/);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('retries only valid but inconsistent history once without cache', { timeout: 45_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the history cache-generation recovery test');
  if (!browserConfig) return;
  const prices = await readFixture('prices.json');
  const validHistory = await readFixture('history.json');
  const inconsistentHistory = structuredClone(validHistory);
  inconsistentHistory.sourcePublishedDates = inconsistentHistory.sourcePublishedDates.slice(0, 1);
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    const scenarios = [
      { responses: [inconsistentHistory, validHistory], expectedCalls: 2, unavailable: false },
      { responses: [inconsistentHistory, inconsistentHistory], expectedCalls: 2, unavailable: true },
      { status: 503, expectedCalls: 1, unavailable: true }
    ];
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      let historyCalls = 0;
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(prices)
      }));
      await page.route('**/data/history.json*', (route) => {
        const responseIndex = historyCalls;
        historyCalls += 1;
        if (scenario.status) return route.fulfill({ status: scenario.status, body: '{}' });
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(scenario.responses[Math.min(responseIndex, scenario.responses.length - 1)])
        });
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, prices.countries.length);
        await page.locator('#publishedDateButton').click();
        await page.waitForFunction((unavailable) => {
          const text = document.querySelector('#publishedDateRows')?.textContent ?? '';
          return unavailable ? text.includes('暂时无法读取更新记录') : document.querySelectorAll('#publishedDateRows tr').length > 1;
        }, scenario.unavailable);
        assert.equal(historyCalls, scenario.expectedCalls);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('ignores stale history responses after a price retry', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the history-race UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const validHistory = await readFixture('history.json');
  const staleHistory = structuredClone(validHistory);
  const brazilHistory = historyRecordForCountry(staleHistory, validData, 'Brazil');
  brazilHistory.events = [brazilHistory.events[0]];
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  let priceCalls = 0;
  let historyCalls = 0;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => {
    priceCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(validData)
    });
  });
  await page.route('**/data/history.json*', async (route) => {
    historyCalls += 1;
    const requestNumber = historyCalls;
    await new Promise((resolve) => setTimeout(resolve, requestNumber === 1 ? 1_000 : 20));
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(requestNumber === 1 ? staleHistory : validHistory)
    });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await page.locator('#priceRows tr[data-market-id="br"]').click();
    await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
    await page.locator('#retryButton').dispatchEvent('click');
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await page.waitForTimeout(1_200);
    assert.equal(await page.locator('#historyDialog').evaluate((element) => element.open), true);
    assert.equal(await page.locator('#historyRows tr').count(), historyRecordForCountry(validHistory, validData, 'Brazil').events.length);
    assert.deepEqual(pageErrors, []);
    assert.equal(priceCalls, 2);
    assert.equal(historyCalls, 2);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps history dialog usable when Chart construction fails', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the Chart-failure UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const validHistory = await readFixture('history.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(validData)
  }));
  await page.route('**/data/history.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(validHistory)
  }));
  await page.route('**/vendor/chart.umd.min.js*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/javascript',
    body: 'window.Chart = class { constructor() { throw new Error("chart-bomb"); } };'
  }));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await page.locator('#priceRows tr[data-market-id="br"]').click();
    assert.equal(await page.locator('#historyDialog').evaluate((element) => element.open), true);
    assert.equal(await page.locator('#historyRows tr').count(), historyRecordForCountry(validHistory, validData, 'Brazil').events.length);
    await page.waitForFunction(() => (
      document.querySelector('#chartWrap')?.hidden === true
      && document.querySelector('#emptyHistory')?.hidden === false
    ));
    assert.equal(await page.locator('#chartWrap').isVisible(), false);
    assert.equal(await page.locator('#emptyHistory').isVisible(), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps the page and publication history bounded with a single-tier table on narrow screens', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the narrow mobile UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const validHistory = await readFixture('history.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 280, height: 844 } });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(validData)
  }));
  await page.route('**/data/history.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(validHistory)
  }));
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    const layout = await page.evaluate(() => {
      const table = document.querySelector('.table-scroll');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        tableWidth: table.scrollWidth,
        tableClientWidth: table.clientWidth,
        visibleTierHeaders: [...document.querySelectorAll('th[data-tier]')].filter((header) => getComputedStyle(header).display !== 'none').length,
        visibleTierCells: [...document.querySelector('#priceRows tr[data-market-id]').querySelectorAll('td[data-tier]')].filter((cell) => getComputedStyle(cell).display !== 'none').length,
        tierButtons: document.querySelectorAll('#mobileTierControl button').length
      };
    });
    assert.ok(layout.documentWidth <= layout.viewportWidth + 1);
    assert.ok(layout.tableWidth <= layout.tableClientWidth + 1);
    assert.equal(layout.visibleTierHeaders, 1);
    assert.equal(layout.visibleTierCells, 1);
    assert.equal(layout.tierButtons, validData.tiers.length);
    assert.equal(await page.locator('#tableHint').count(), 0);
    assert.equal(await page.locator('#compareDock, #compareDialog, .compare-column, .compare-cell, .row-compare-button').count(), 0);

    const minimumBadgeLayout = await page.locator('.price-cell.is-minimum.is-active-tier .minimum-badge').first().evaluate((badge) => {
      const badgeBox = badge.getBoundingClientRect();
      const cellBox = badge.closest('td').getBoundingClientRect();
      return {
        text: badge.textContent,
        badgeLeft: badgeBox.left,
        badgeRight: badgeBox.right,
        cellLeft: cellBox.left,
        cellRight: cellBox.right
      };
    });
    assert.equal(minimumBadgeLayout.text, '最低');
    assert.ok(minimumBadgeLayout.badgeLeft >= minimumBadgeLayout.cellLeft - 1, 'minimum badge must stay inside the active price cell on narrow screens');
    assert.ok(minimumBadgeLayout.badgeRight <= minimumBadgeLayout.cellRight + 1, 'minimum badge must not overflow the table on narrow screens');

    const nextTier = validData.tiers[1];
    await page.locator(`#mobileTierControl button[data-tier="${nextTier.id}"]`).click();
    assert.equal(await page.locator('th[data-tier].is-active-tier').getAttribute('data-tier'), nextTier.id);
    assert.equal(new URL(page.url()).searchParams.get('tier'), nextTier.id);

    await page.locator('#priceRows tr[data-market-id]').nth(35).scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollBy(0, 180));
    const stickyHeaders = await page.locator('.price-table th:nth-child(2), .price-table th[data-tier].is-active-tier').evaluateAll((headers) => (
      headers.map((header) => ({
        top: header.getBoundingClientRect().top,
        height: header.getBoundingClientRect().height,
        position: getComputedStyle(header).position
      }))
    ));
    assert.equal(stickyHeaders.length, 2);
    for (const header of stickyHeaders) {
      assert.equal(header.position, 'sticky');
      assert.ok(header.height > 0, 'mobile sticky header cells must remain visible');
      assert.ok(header.top >= -1 && header.top <= 1, `mobile header should remain sticky at the viewport top, got ${header.top}`);
    }

    await page.locator('#publishedDateButton').click();
    await page.waitForFunction(() => document.querySelector('#publishedDateDialog')?.open === true);
    await page.waitForFunction(() => document.querySelector('#publishedDateRows tr')?.cells.length === 2);
    const publicationLayout = await page.locator('#publishedDateDialog').evaluate((dialog) => {
      const scroller = dialog.querySelector('.history-table-scroll');
      const cells = [...dialog.querySelector('#publishedDateRows tr').cells].map((cell) => cell.getBoundingClientRect());
      return {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        stacked: cells[1].top >= cells[0].bottom - 1
      };
    });
    assert.ok(publicationLayout.scrollWidth <= publicationLayout.clientWidth + 1, 'production publication history must not scroll horizontally at 280px');
    assert.equal(publicationLayout.stacked, true, 'production publication history must stack date above details at 280px');

    await page.setViewportSize({ width: 390, height: 844 });
    const mobilePublicationLayout = await page.locator('#publishedDateDialog').evaluate((dialog) => {
      const scroller = dialog.querySelector('.history-table-scroll');
      const cells = [...dialog.querySelector('#publishedDateRows tr').cells].map((cell) => cell.getBoundingClientRect());
      return {
        clientWidth: scroller.clientWidth,
        scrollWidth: scroller.scrollWidth,
        stacked: cells[1].top >= cells[0].bottom - 1
      };
    });
    assert.ok(mobilePublicationLayout.scrollWidth <= mobilePublicationLayout.clientWidth + 1, 'production publication history must not scroll horizontally at 390px');
    assert.equal(mobilePublicationLayout.stacked, true, 'production publication history must stack date above details at 390px');
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps 100 price and publication history records inside scrollable dialogs', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the long-history UI test');
  if (!browserConfig) return;

  const data = await readFixture('prices.json');
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
      plans: Object.fromEntries(data.tiers.map(({ id }) => [id, country.plans[id].price + (99 - index) / 100]))
    };
  });
  const verboseCountries = Array.from({ length: 24 }, (_, index) => ({
    country: `SyntheticCountry${index}${'UnbrokenName'.repeat(8)}`,
    nameZh: index === 0 ? undefined : `测试地区${index}${'超长变化内容'.repeat(8)}`
  }));
  const verboseChanges = {
    addedTiers: Array.from({ length: 12 }, (_, index) => ({ id: `${100 + index}TB`, label: `${100 + index} TB` })),
    removedTiers: Array.from({ length: 12 }, (_, index) => ({ id: `${200 + index}TB`, label: `${200 + index} TB` })),
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
    schemaVersion: 4,
    updatedAt: data.generatedAt,
    markets: Object.fromEntries(data.countries.map((entry) => [entry.marketId, {
      country: entry.country,
      nameZh: entry.nameZh,
      region: entry.region,
      events: entry.country === country.country ? priceEvents : [{
        observedAt: '2026-08-01',
        currency: entry.currency,
        plans: Object.fromEntries(data.tiers.map(({ id }) => [id, entry.plans[id].price]))
      }]
    }])),
    sourcePublishedDates
  };
  assert.doesNotThrow(
    () => validatePriceHistoryConsistency(data, history),
    'long-history fixture must satisfy the same cross-file contract as production data'
  );
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);

  const assertScrollableDialog = async (page, dialogSelector, closeSelector, label) => {
    const dialog = page.locator(dialogSelector);
    await dialog.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
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
    assert.ok(
      before.scrollWidth <= before.clientWidth + 1,
      `${label} dialog must not scroll horizontally (${before.scrollWidth}/${before.clientWidth})`
    );
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
      { name: 'mobile', width: 390, height: 844 },
      { name: 'narrow-mobile', width: 320, height: 720 },
      { name: 'compact-mobile', width: 280, height: 720 }
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/history.json*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(history)
      }));
      await page.route('**/vendor/chart.umd.min.js*', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await route.continue();
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, data.countries.length);

        await page.locator('#searchInput').fill(country.country);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        await page.locator('#priceRows tr[data-market-id]').click();
        await page.waitForFunction(() => document.querySelectorAll('#historyRows tr').length === 100);
        await assertScrollableDialog(page, '#historyDialog', '#closeHistory', `${viewport.name} price history`);
        const priceTableScroller = page.locator('#historyDialog .history-table-scroll');
        if (viewport.width <= 640) {
          const mobileHistoryLayout = await priceTableScroller.evaluate((element) => ({
            clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth,
            visibleHeaders: [...element.querySelectorAll('thead th')].filter((header) => getComputedStyle(header).display !== 'none').length
          }));
          assert.ok(mobileHistoryLayout.scrollWidth <= mobileHistoryLayout.clientWidth + 1, 'mobile price history must avoid nested horizontal scrolling');
          assert.equal(mobileHistoryLayout.visibleHeaders, 3, 'mobile price history must show only date, currency, and the active tier');
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
        const publicationHeaders = await page.locator('#publishedDateDialog thead th').evaluateAll((headers) => headers.map((header) => ({
          text: header.textContent.trim(),
          clientWidth: header.clientWidth,
          scrollWidth: header.scrollWidth,
          whiteSpace: getComputedStyle(header).whiteSpace,
          overflowWrap: getComputedStyle(header).overflowWrap,
          wordBreak: getComputedStyle(header).wordBreak,
          position: getComputedStyle(header).position,
          containerPosition: getComputedStyle(header.closest('thead')).position
        })));
        assert.equal(publicationHeaders[0].text, 'Apple 页面日期');
        assert.equal(publicationHeaders[1].text, '检测到的变化');
        assert.equal(publicationHeaders.length, 2, 'internal confirmation dates must not be shown to end users');
        assert.equal(await page.locator('#publishedDateRows tr').first().locator('td').count(), 2, 'publication rows must omit the internal confirmation date');
        assert.equal(publicationHeaders[0].whiteSpace, 'normal', 'Apple publication-date header must be allowed to wrap');
        assert.equal(publicationHeaders[0].overflowWrap, 'normal', 'Apple publication-date header must not split individual date characters');
        assert.equal(publicationHeaders[0].wordBreak, 'keep-all', 'Apple publication-date header must keep the Chinese date label together');
        assert.equal(publicationHeaders[0].position, 'static', 'publication history header cells must not overlap the sticky dialog header');
        if (viewport.width <= 640) {
          assert.equal(publicationHeaders[0].containerPosition, 'absolute', 'mobile widths must visually hide the table header without removing it');
          const mobileLabels = await page.locator('#publishedDateRows tr').first().locator('td').evaluateAll((cells) => (
            cells.map((cell) => getComputedStyle(cell, '::before').content)
          ));
          assert.deepEqual(mobileLabels, ['"发布日期"', '"本次内容变化"'], 'stacked mobile records must retain visible field labels');
        } else {
          assert.equal(publicationHeaders[0].containerPosition, 'static', 'publication history header must remain visible above two-column records');
          assert.ok(publicationHeaders[0].scrollWidth <= publicationHeaders[0].clientWidth + 1, 'Apple publication-date header must not clip horizontally');
        }
        const publicationDateCell = await page.locator('#publishedDateRows tr').first().locator('td').first().evaluate((cell) => ({
          clientWidth: cell.clientWidth,
          scrollWidth: cell.scrollWidth,
          whiteSpace: getComputedStyle(cell).whiteSpace
        }));
        assert.equal(publicationDateCell.whiteSpace, 'nowrap', 'publication dates must stay on one line');
        assert.ok(publicationDateCell.scrollWidth <= publicationDateCell.clientWidth + 1, 'publication dates must fit their column without clipping');
        const tableScroller = page.locator('#publishedDateDialog .history-table-scroll');
        const verboseCell = page.locator('#publishedDateRows .published-change-cell').first();
        const verboseMetrics = await verboseCell.evaluate((element) => ({
          textLength: element.textContent.length,
          includesCurrencyUnit: element.textContent.includes('USD'),
          changeGroups: element.querySelectorAll('.published-change-group').length,
          changeBullets: element.querySelectorAll('.published-change-country').length,
          boldChangedCountries: element.querySelectorAll('.published-change-country > strong').length,
          boldAddedCountries: element.querySelectorAll('.published-change-group:not(.published-change-country-group) strong ~ strong').length,
          groupsFitCell: [...element.querySelectorAll('.published-change-group')].every((group) => (
            group.getBoundingClientRect().right <= element.getBoundingClientRect().right + 1
          )),
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight)
        }));
        assert.ok(verboseMetrics.textLength > 5_000, 'publication history must render the complete long change description');
        assert.ok(verboseMetrics.changeGroups > 1, 'publication change groups must render as separate blocks');
        assert.equal(verboseMetrics.includesCurrencyUnit, true, 'publication price changes must include currency units');
        assert.ok(verboseMetrics.changeBullets > 10, 'changed countries must have visible list markers');
        assert.equal(verboseMetrics.boldChangedCountries, verboseMetrics.changeBullets, 'each changed country name must be bold');
        assert.equal(verboseMetrics.boldAddedCountries, 0, 'added country names must remain regular weight');
        assert.equal(verboseMetrics.groupsFitCell, true, 'long change groups must stay inside their cell');
        assert.ok(verboseMetrics.height > verboseMetrics.lineHeight * 5, 'long change text must use multiple lines');
        const tableWidths = await tableScroller.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.ok(tableWidths.scrollWidth <= tableWidths.clientWidth + 1, `${viewport.name} publication table must show both columns without horizontal scrolling (${tableWidths.scrollWidth}/${tableWidths.clientWidth})`);
        assert.equal(await verboseCell.evaluate((element) => getComputedStyle(element).textAlign), 'left', 'publication details must remain easy to scan');
        assert.deepEqual(
          await page.locator('#publishedDateDialog thead th').evaluateAll((headers) => headers.map((header) => getComputedStyle(header).textAlign)),
          ['left', 'left'],
          'publication history text headers must align left'
        );
        if (viewport.width <= 640) {
          const stackedCells = await page.locator('#publishedDateRows tr').first().locator('td').evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect()));
          assert.ok(stackedCells[1].top >= stackedCells[0].bottom - 1, 'mobile publication records must stack date above details');
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

test('resets a removed region filter after a successful price retry', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the removed-region retry test');
  if (!browserConfig) return;
  const fullData = await readFixture('prices.json');
  const replacement = structuredClone(fullData);
  const removedRegion = fullData.countries[0].region;
  replacement.countries = replacement.countries.filter(({ region }) => region !== removedRegion);
  rerankPriceFixture(replacement);
  replacement.run.countries = replacement.countries.length;
  replacement.run.pricePoints = replacement.countries.length * replacement.tiers.length;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  let priceCalls = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
    });
    await page.route('https://**/*', (route) => route.abort());
    await page.route('**/data/prices.json*', (route) => {
      priceCalls += 1;
      const body = JSON.stringify(priceCalls === 1 ? fullData : replacement);
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, fullData.countries.length);
      await page.locator('#regionSelect').selectOption(removedRegion);
      assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), fullData.countries.filter(({ region }) => region === removedRegion).length);
      await page.locator('#retryButton').dispatchEvent('click');
      await page.waitForFunction((count) => document.querySelector('#marketCount')?.textContent === `${count} 个地区`, replacement.countries.length);
      await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, replacement.countries.length);
      assert.equal(await page.locator('#regionSelect').inputValue(), 'all');
      assert.equal(priceCalls, 2);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rebinds or closes an open history dialog after country replacement', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the active-country retry test');
  if (!browserConfig) return;
  const fullData = await readFixture('prices.json');
  const fullHistory = await readFixture('history.json');
  const activeCountry = fullData.countries[0];
  const changedData = structuredClone(fullData);
  const changedCountry = changedData.countries.find(({ country }) => country === activeCountry.country);
  changedCountry.nameZh = `${activeCountry.nameZh} 新版`;
  changedCountry.region = activeCountry.region === 'Americas' ? 'Asia Pacific' : 'Americas';
  changedCountry.currency = activeCountry.currency === 'USD' ? 'CNY' : 'USD';
  for (const tier of changedData.tiers) {
    const plan = changedCountry.plans[tier.id];
    plan.price += 1;
    plan.formattedPrice = `${changedCountry.currency} ${plan.price.toFixed(2)}`;
  }
  changedData.run.pricePoints = changedData.countries.length * changedData.tiers.length;
  const removedData = structuredClone(changedData);
  removedData.countries = removedData.countries.filter(({ country }) => country !== activeCountry.country);
  rerankPriceFixture(removedData);
  removedData.run.countries = removedData.countries.length;
  removedData.run.pricePoints = removedData.countries.length * removedData.tiers.length;
  const scenarios = [
    { label: 'updated country', replacement: changedData, expectedOpen: true, expectedTitle: changedCountry.nameZh },
    { label: 'removed country', replacement: removedData, expectedOpen: false, expectedTitle: activeCountry.nameZh }
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    for (const scenario of scenarios) {
      const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
      let priceCalls = 0;
      let historyCalls = 0;
      let releaseSecondHistory;
      const secondHistoryReady = new Promise((resolve) => { releaseSecondHistory = resolve; });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
      });
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => {
        priceCalls += 1;
        const body = JSON.stringify(priceCalls === 1 ? fullData : scenario.replacement);
        return route.fulfill({ status: 200, contentType: 'application/json', body });
      });
      await page.route('**/data/history.json*', async (route) => {
        historyCalls += 1;
        if (!scenario.expectedOpen && historyCalls > 1) await secondHistoryReady;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fullHistory) });
      });
      try {
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, fullData.countries.length);
        await page.locator(`#priceRows tr[data-market-id="${activeCountry.marketId}"]`).click();
        await page.waitForFunction(() => document.querySelector('#historyDialog')?.open === true);
        await page.locator('#retryButton').dispatchEvent('click');
        await page.waitForFunction((count) => document.querySelector('#marketCount')?.textContent === `${count} 个地区`, scenario.replacement.countries.length);
        if (scenario.expectedOpen) {
          await page.waitForFunction((title) => document.querySelector('#historyTitle')?.textContent === title, scenario.expectedTitle);
          await page.locator('#closeHistory').click();
          await page.waitForFunction((marketId) => document.activeElement?.closest('tr[data-market-id]')?.dataset.marketId === marketId, activeCountry.marketId);
        } else {
          assert.equal(await page.locator('#historyDialog').evaluate((dialog) => dialog.open), false, scenario.label);
          await page.waitForFunction(() => document.activeElement?.id === 'priceWorkspace');
          releaseSecondHistory();
          await page.waitForTimeout(100);
          assert.equal(await page.locator('#historyDialog').evaluate((dialog) => dialog.open), false, `${scenario.label} must stay closed after the old history response resolves`);
        }
        assert.equal(priceCalls, 2, scenario.label);
        assert.deepEqual(errors, [], scenario.label);
      } finally {
        releaseSecondHistory();
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});



test('keeps the minimum-price overview stable and the desktop table header sticky', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the stable-layout UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  let releaseRequest;
  const requestReleased = new Promise((resolve) => { releaseRequest = resolve; });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', async (route) => {
    await requestReleased;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(validData) });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#minimumSummary .minimum-card').count(), 5);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(await page.locator('h1').textContent(), 'iCloud+ \u5168\u7403\u4ef7\u683c\u5bf9\u6bd4');
    assert.equal(await page.locator('#overviewTitle').evaluate((element) => element.tagName), 'H2');
    const moduleSource = await page.locator('head script[type="module"][src^="script.js?v="][data-cfasync="false"]').getAttribute('src');
    assert.match(moduleSource, /^script\.js\?v=[0-9a-f]{8}$/);
    assert.equal(await page.locator('head link[rel="modulepreload"]').count(), 4);
    const before = await page.locator('#minimumSummary').boundingBox();
    const loadingLayout = await page.evaluate(() => ({
      footerTop: document.querySelector('.workspace-footer').getBoundingClientRect().top,
      viewportHeight: innerHeight
    }));
    assert.ok(loadingLayout.footerTop >= loadingLayout.viewportHeight, `the loading table must keep the footer below the desktop viewport; footer=${loadingLayout.footerTop}, viewport=${loadingLayout.viewportHeight}`);
    releaseRequest();
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    const afterBox = await page.locator('#minimumSummary').boundingBox();
    assert.ok(before && afterBox && Math.abs(before.height - afterBox.height) <= 2, 'minimum summary height should stay stable across loading');
    assert.equal(await page.locator('#minimumSummary .minimum-card.is-loading').count(), 0);
    const assertMinimumCardSpacing = async (viewport) => {
      const gaps = await page.locator('#minimumSummary .minimum-card').evaluateAll((cards) => cards.map((card) => {
        const tierBox = card.querySelector('.minimum-tier-label').getBoundingClientRect();
        const countryBox = card.querySelector('.minimum-country').getBoundingClientRect();
        const priceBox = card.querySelector('.minimum-price').getBoundingClientRect();
        return {
          tierToCountry: countryBox.top - tierBox.bottom,
          countryToPrice: priceBox.top - countryBox.bottom
        };
      }));
      const smallestGap = Math.min(...gaps.flatMap(({ tierToCountry, countryToPrice }) => [tierToCountry, countryToPrice]));
      const largestImbalance = Math.max(...gaps.map(({ tierToCountry, countryToPrice }) => Math.abs(tierToCountry - countryToPrice)));
      assert.ok(smallestGap >= 3, `${viewport} card labels must remain separated; smallest gap was ${smallestGap}px`);
      assert.ok(largestImbalance <= 1, `${viewport} card spacing must stay balanced; largest difference was ${largestImbalance}px`);
    };
    await page.setViewportSize({ width: 390, height: 844 });
    await assertMinimumCardSpacing('mobile');
    const mobileTableInsets = await page.locator('#priceRows tr[data-market-id]').first().evaluate((row) => {
      const tableBox = row.closest('.price-table').getBoundingClientRect();
      const countryBox = row.querySelector('.country-name').getBoundingClientRect();
      const priceBox = row.querySelector('td[data-tier].is-active-tier .price-cny').getBoundingClientRect();
      return {
        country: countryBox.left - tableBox.left,
        price: tableBox.right - priceBox.right
      };
    });
    assert.ok(mobileTableInsets.country >= 16, `mobile country names need comfortable left padding; got ${mobileTableInsets.country}px`);
    assert.ok(Math.abs(mobileTableInsets.country - mobileTableInsets.price) <= 1, `mobile table edge spacing must be balanced; country=${mobileTableInsets.country}px, price=${mobileTableInsets.price}px`);

    await page.setViewportSize({ width: 1440, height: 800 });
    await assertMinimumCardSpacing('desktop');
    await page.locator('#priceRows tr[data-market-id]').nth(35).scrollIntoViewIfNeeded();
    await page.evaluate(() => scrollBy(0, 220));
    const stickyTop = await page.locator('.price-table thead th').first().evaluate((header) => header.getBoundingClientRect().top);
    assert.ok(stickyTop >= -1 && stickyTop <= 1, `desktop header should remain sticky at the viewport top, got ${stickyTop}`);
    const tableChrome = await page.evaluate(() => {
      const header = document.querySelector('.price-table th[data-tier]');
      const lastHeader = document.querySelector('.price-table th:last-child');
      const lastCell = document.querySelector('#priceRows tr[data-market-id] td:last-child');
      const headerStyle = getComputedStyle(header);
      return {
        fontSize: Number.parseFloat(headerStyle.fontSize),
        background: headerStyle.backgroundColor,
        rowBackground: getComputedStyle(document.querySelector('#priceRows tr[data-market-id] td')).backgroundColor,
        lastHeaderPadding: Number.parseFloat(getComputedStyle(lastHeader).paddingRight),
        lastCellPadding: Number.parseFloat(getComputedStyle(lastCell).paddingRight)
      };
    });
    assert.ok(tableChrome.fontSize >= 13, 'desktop price headers should be visually prominent');
    assert.notEqual(tableChrome.background, tableChrome.rowBackground, 'price headers should remain distinct from table rows');
    assert.ok(tableChrome.lastHeaderPadding >= 25, 'the rightmost header should keep balanced space from the table edge');
    assert.ok(tableChrome.lastCellPadding >= 25, 'the rightmost price should keep balanced space from the table edge');
  } finally {
    releaseRequest();
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('restores URL state, removes the floating search bar, and supports table return plus minimum navigation', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the URL, table-return, and minimum-navigation UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const initialCountry = validData.countries.find(({ nameZh }) => nameZh) || validData.countries[0];
  const params = new URLSearchParams({
    tier: validData.tiers.at(-1).id,
    sort: 'tier',
    dir: 'asc',
    q: initialCountry.nameZh || initialCountry.country,
    region: initialCountry.region,
    compare: validData.countries.slice(0, 2).map(({ country }) => country).join(',')
  });
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1365, height: 760 } });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(validData)
  }));
  try {
    await page.goto(`http://127.0.0.1:${port}/?${params}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#marketCount')?.textContent !== '--');
    assert.equal(await page.locator('#searchInput').inputValue(), initialCountry.nameZh || initialCountry.country);
    assert.equal(await page.locator('#regionSelect').inputValue(), initialCountry.region);
    assert.equal(new URL(page.url()).searchParams.has('q'), false, 'free-text search terms must not remain in a shareable URL');
    assert.equal(new URL(page.url()).searchParams.has('compare'), false, 'legacy comparison state should be removed from the URL');
    assert.equal(await page.locator('#compareDock, #compareDialog, .compare-column, .compare-cell, .row-compare-button').count(), 0);
    assert.equal(
      await page.locator('#compactControls, #compactSearchInput, #compactSortButton').count(),
      0,
      'the floating search and sort toolbar should be removed'
    );

    const initialTier = params.get('tier');
    const initialMinimumCard = page.locator(`#minimumSummary .minimum-card[data-tier="${initialTier}"]`);
    assert.equal(await initialMinimumCard.getAttribute('aria-pressed'), 'true');
    assert.equal(await initialMinimumCard.evaluate((card) => card.classList.contains('is-active-tier')), true);

    const alternateTier = validData.tiers.find(({ id }) => id !== initialTier).id;
    const alternateMinimumCard = page.locator(`#minimumSummary .minimum-card[data-tier="${alternateTier}"]`);
    await page.locator(`th[data-tier="${alternateTier}"] button`).click();
    assert.equal(await page.locator(`th[data-tier="${alternateTier}"]`).getAttribute('aria-sort'), 'ascending');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'tier');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'asc');
    assert.equal(await alternateMinimumCard.getAttribute('aria-pressed'), 'true');
    assert.equal(await alternateMinimumCard.evaluate((card) => card.classList.contains('is-active-tier')), true);
    assert.equal(await initialMinimumCard.getAttribute('aria-pressed'), 'false');
    assert.equal(await initialMinimumCard.evaluate((card) => card.classList.contains('is-active-tier')), false);

    await page.locator(`th[data-tier="${alternateTier}"] button`).click();
    assert.equal(await page.locator(`th[data-tier="${alternateTier}"]`).getAttribute('aria-sort'), 'descending');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'desc');
    assert.equal(await alternateMinimumCard.getAttribute('aria-pressed'), 'false');
    assert.equal(await alternateMinimumCard.evaluate((card) => card.classList.contains('is-active-tier')), false);
    assert.equal(await page.locator('#minimumSummary .minimum-card[aria-pressed="true"]').count(), 0);

    await page.locator('button[data-sort="country"]').click();
    assert.equal(await page.locator('#minimumSummary .minimum-card[aria-pressed="true"]').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'country');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'asc');
    assert.equal(new URL(page.url()).searchParams.get('tier'), alternateTier, 'country sorting must retain the selected comparison tier');
    await page.locator('button[data-sort="country"]').click();
    assert.equal(await page.locator('th:has(button[data-sort="country"])').getAttribute('aria-sort'), 'descending');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'desc');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#marketCount')?.textContent !== '--');
    assert.equal(await page.locator('th:has(button[data-sort="country"])').getAttribute('aria-sort'), 'descending');
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'country');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'desc');

    await page.locator('#searchInput').fill('');
    await page.locator('#regionSelect').selectOption('all');
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);

    const backToTableButton = page.locator('#backToTableButton');
    assert.equal(await backToTableButton.count(), 1);
    assert.equal(await backToTableButton.getAttribute('aria-hidden'), 'true');
    await page.evaluate(() => {
      scrollTo(0, document.scrollingElement?.scrollHeight ?? 0);
      document.querySelector('#backToTableButton')?.focus({ preventScroll: true });
    });
    await page.waitForFunction(() => {
      const button = document.querySelector('#backToTableButton');
      return button?.classList.contains('is-visible') && button.getAttribute('aria-hidden') === 'false';
    });
    await backToTableButton.click();
    assert.equal(await page.locator('#priceWorkspace').evaluate((element) => document.activeElement === element), true, 'table return should move keyboard focus to the visible workspace');
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('.workspace-toolbar');
      if (!toolbar) return false;
      const top = toolbar.getBoundingClientRect().top;
      return top >= -1 && top <= 2;
    });

    await page.locator('#searchInput').fill(initialCountry.nameZh || initialCountry.country);
    await page.locator('#regionSelect').selectOption(initialCountry.region);
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
    const minimumCard = page.locator('#minimumSummary .minimum-card').filter({ hasText: '200 GB' });
    const minimumTier = await minimumCard.getAttribute('data-tier');
    await minimumCard.click();
    assert.equal(new URL(page.url()).searchParams.get('tier'), minimumTier);
    assert.equal(new URL(page.url()).searchParams.get('sort'), 'tier');
    assert.equal(new URL(page.url()).searchParams.get('dir'), 'asc');
    assert.equal(new URL(page.url()).searchParams.has('q'), false);
    assert.equal(new URL(page.url()).searchParams.has('region'), false);
    assert.equal(await page.locator('#searchInput').inputValue(), '');
    assert.equal(await page.locator('#regionSelect').inputValue(), 'all');
    assert.equal(await page.locator(`th[data-tier="${minimumTier}"]`).getAttribute('aria-sort'), 'ascending');
    assert.equal(await minimumCard.getAttribute('aria-pressed'), 'true');
    assert.equal(await minimumCard.evaluate((card) => card.classList.contains('is-active-tier')), true);
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr.is-highlighted').length === 1);
    const highlightedRow = page.locator('#priceRows tr.is-highlighted');
    const expectedWinner = validData.countries
      .map((country) => ({
        country,
        cny: country.plans[minimumTier].cnyPrice
      }))
      .sort((first, second) => first.cny - second.cny)[0].country.marketId;
    assert.equal(await highlightedRow.getAttribute('data-market-id'), expectedWinner);
    assert.equal(await highlightedRow.locator('.country-history-button').evaluate((element) => document.activeElement === element), true, 'minimum navigation should move focus to the located country');
    await page.waitForFunction(() => {
      const row = document.querySelector('#priceRows tr.is-highlighted');
      if (!row) return false;
      const box = row.getBoundingClientRect();
      return box.bottom > 0 && box.top < innerHeight;
    });
    const rowBox = await highlightedRow.boundingBox();
    assert.ok(rowBox && rowBox.y + rowBox.height > 0 && rowBox.y < 760, 'minimum-price winner should be positioned in the viewport');
  } finally {
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('keeps the cached table DOM when the network snapshot is unchanged', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the unchanged-cache performance test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  let releaseRequest;
  let requestSeen = false;
  const requestReleased = new Promise((resolve) => { releaseRequest = resolve; });
  await page.addInitScript(({ payload, nowMs }) => {
    Date.now = () => nowMs;
    localStorage.setItem('icloud-price-comparison:validated-prices:v2', JSON.stringify(payload));
  }, { payload: validData, nowMs: Date.parse(validData.generatedAt) + 60 * 60 * 1_000 });
  await page.route('https://**/*', (route) => route.abort());
  await page.route('**/data/prices.json*', async (route) => {
    requestSeen = true;
    await requestReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(validData)
    });
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await page.locator('#priceRows tr[data-market-id]').first().evaluate((row) => { row.dataset.renderMarker = 'cached'; });
    releaseRequest();
    await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
    assert.equal(requestSeen, true, 'the cached view must still check for a network update');
    assert.equal(await page.locator('#priceRows tr[data-render-marker="cached"]').count(), 1, 'an identical network snapshot should not rebuild the rendered table');
  } finally {
    releaseRequest?.();
    await page.close();
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rejects redirected, oversized, and malformed UTF-8 price responses before parsing', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the bounded network-data test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const cases = [
    {
      name: 'redirected',
      serverResponse: 'redirect'
    },
    {
      name: 'oversized',
      fulfill: { status: 200, contentType: 'application/json', body: ' '.repeat((1024 * 1024) + 1) }
    },
    {
      name: 'malformed UTF-8',
      fulfill: { status: 200, contentType: 'application/json', body: Buffer.from([0xff, 0xfe, 0xfd]) }
    }
  ];
  try {
    for (const testCase of cases) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      let redirectTargetRequested = false;
      page.on('request', (request) => {
        if (request.url() === `${origin}/data/history.json`) redirectTargetRequested = true;
      });
      await page.route('https://**/*', (route) => route.abort());
      if (testCase.serverResponse) {
        await page.setExtraHTTPHeaders({ 'x-icloud-test-price-response': testCase.serverResponse });
      } else {
        await page.route('**/data/prices.json*', (route) => route.fulfill(testCase.fulfill));
      }
      await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
      assert.equal(await page.locator('#searchInput').isDisabled(), true, `${testCase.name} data must not render`);
      assert.equal(redirectTargetRequested, false, 'price fetch must not follow redirects');
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('rejects network price data older than seven days or more than five minutes in the future', { timeout: 60_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the network freshness boundary test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const scenarios = [
    { label: 'expired network data', generatedAt: new Date(Date.now() - (7 * 24 * 60 * 60 * 1_000) - 60_000).toISOString() },
    { label: 'future network data', generatedAt: new Date(Date.now() + (6 * 60 * 1_000)).toISOString() }
  ];
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    for (const { label, generatedAt } of scenarios) {
      const payload = structuredClone(validData);
      setPayloadGeneratedAt(payload, generatedAt);
      payload.fx.fetchedAt = generatedAt;
      payload.fx.stale = false;
      const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
      await page.route('https://**/*', (route) => route.abort());
      await page.route('**/data/prices.json*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload)
      }));
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
      assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), validData.countries.length, label);
      assert.match(await page.locator('#updatedAt').textContent(), /更新于/ , label);
      assert.match(await page.locator('#loadStatusText').textContent(), /当前显示最近一次可用价格/, label);
      await page.close();
    }
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('enforces fresh, stale, and expired local price cache behavior', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the validated-cache UI test');
  if (!browserConfig) return;
  const validData = await readFixture('prices.json');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    const cachedPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await cachedPage.addInitScript(({ payload, nowMs }) => {
      Date.now = () => nowMs;
      localStorage.setItem('icloud-price-comparison:validated-prices:v2', JSON.stringify(payload));
    }, { payload: validData, nowMs: Date.parse(validData.generatedAt) + 36 * 60 * 60 * 1_000 });
    await cachedPage.route('https://**/*', (route) => route.abort());
    await cachedPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await cachedPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await cachedPage.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await cachedPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await cachedPage.locator('#searchInput').isEnabled(), true);
    assert.match(await cachedPage.locator('#loadStatusText').textContent(), /当前显示最近一次可用价格/);
    assert.match(await cachedPage.locator('#updatedAt').textContent(), /暂时无法获取更新/);
    assert.ok(await cachedPage.locator('.minimum-badge').count() > 0, 'a cache exactly 36 hours old keeps minimum cues');
    await cachedPage.close();

    const stalePage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await stalePage.addInitScript(({ payload, nowMs }) => {
      Date.now = () => nowMs;
      localStorage.setItem('icloud-price-comparison:validated-prices:v2', JSON.stringify(payload));
    }, { payload: validData, nowMs: Date.parse(validData.generatedAt) + (36 * 60 * 60 * 1_000) + 1 });
    await stalePage.route('https://**/*', (route) => route.abort());
    await stalePage.route('**/data/prices.json*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(validData)
    }));
    await stalePage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await stalePage.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, validData.countries.length);
    await stalePage.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);
    assert.equal(await stalePage.locator('#searchInput').isEnabled(), true);
    assert.equal(await stalePage.locator('#regionSelect').isEnabled(), true);
    assert.equal(await stalePage.locator('.minimum-badge').count(), 0);
    assert.equal(await stalePage.locator('.price-cell.is-minimum').count(), 0);
    assert.equal(await stalePage.locator('.rank-top').count(), 0);
    assert.equal(await stalePage.locator('#overviewTitle').textContent(), '各容量全球最低价');
    assert.equal(
      await stalePage.locator('#minimumSummary').textContent(),
      '价格暂未更新，当前显示最近一次获取的 Apple 标价。'
    );
    await stalePage.locator('button[data-sort-tier]:visible').first().click();
    assert.ok(await stalePage.locator('#priceRows tr[data-market-id]').count() > 0, 'stale-cache sorting remains usable');
    await stalePage.close();

    const expiredPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await expiredPage.addInitScript(({ payload, nowMs }) => {
      Date.now = () => nowMs;
      localStorage.setItem('icloud-price-comparison:validated-prices:v2', JSON.stringify(payload));
    }, { payload: validData, nowMs: Date.parse(validData.generatedAt) + (7 * 24 * 60 * 60 * 1_000) + 1 });
    await expiredPage.route('https://**/*', (route) => route.abort());
    await expiredPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await expiredPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await expiredPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await expiredPage.locator('#priceRows tr[data-market-id]').count(), validData.countries.length);
    assert.match(await expiredPage.locator('#loadStatusText').textContent(), /价格已经较久没有更新/);
    assert.equal(await expiredPage.evaluate(() => localStorage.getItem('icloud-price-comparison:validated-prices:v2')), null);
    await expiredPage.close();

    const invalidPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await invalidPage.addInitScript(() => {
      localStorage.setItem('icloud-price-comparison:validated-prices:v2', JSON.stringify({ schemaVersion: 999 }));
    });
    await invalidPage.route('https://**/*', (route) => route.abort());
    await invalidPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await invalidPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await invalidPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    const retryBox = await invalidPage.locator('#retryButton').boundingBox();
    assert.ok(
      retryBox && retryBox.height >= 43.99,
      `the retry action must retain a comfortable touch target (actual: ${retryBox?.height ?? 'missing'}px)`
    );
    assert.equal(await invalidPage.locator('#searchInput').isDisabled(), true);
    assert.equal(await invalidPage.evaluate(() => localStorage.getItem('icloud-price-comparison:validated-prices:v2')), null);
    await invalidPage.close();

    const oversizedPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await oversizedPage.addInitScript(() => {
      localStorage.setItem('icloud-price-comparison:validated-prices:v2', ' '.repeat((1024 * 1024) + 1));
    });
    await oversizedPage.route('https://**/*', (route) => route.abort());
    await oversizedPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await oversizedPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await oversizedPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await oversizedPage.locator('#searchInput').isDisabled(), true, 'oversized cache must never render');
    assert.equal(await oversizedPage.evaluate(() => localStorage.getItem('icloud-price-comparison:validated-prices:v2')), null);
    await oversizedPage.close();

    const legacyData = structuredClone(validData);
    legacyData.schemaVersion = 2;
    legacyData.fx.rates = { USD: 1, CNY: 7 };
    delete legacyData.fx.derivedCurrency;
    for (const country of legacyData.countries) {
      for (const tier of legacyData.tiers) delete country.plans[tier.id].cnyPrice;
    }
    const legacyPage = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await legacyPage.addInitScript((payload) => {
      localStorage.setItem('icloud-price-comparison:validated-prices:v1', JSON.stringify(payload));
    }, legacyData);
    await legacyPage.route('https://**/*', (route) => route.abort());
    await legacyPage.route('**/data/prices.json*', (route) => route.fulfill({ status: 503, body: '{}' }));
    await legacyPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await legacyPage.waitForFunction(() => document.querySelector('#retryButton')?.hidden === false);
    assert.equal(await legacyPage.locator('#searchInput').isDisabled(), true, 'legacy schema cache must never render');
    assert.equal(await legacyPage.evaluate(() => localStorage.getItem('icloud-price-comparison:validated-prices:v1')), null, 'legacy cache key must be removed during startup');
    assert.equal(await legacyPage.evaluate(() => localStorage.getItem('icloud-price-comparison:validated-prices:v2')), null);
    await legacyPage.close();
  } finally {
    await browser.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
