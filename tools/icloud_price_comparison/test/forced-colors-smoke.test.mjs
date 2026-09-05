import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};
const BROWSER_UNDER_TEST = process.env.PLAYWRIGHT_BROWSER || 'chromium';

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

async function resolveChromium(context) {
  try {
    await access(chromium.executablePath());
    return { headless: true, timeout: 10_000 };
  } catch {
    // The daily job intentionally relies on the runner's installed Chrome.
  }
  const executablePath = await findChrome();
  if (executablePath) return { executablePath, headless: true, timeout: 10_000 };
  if (process.env.CI) assert.fail('Chrome or Chromium is required for the forced-colors accessibility regression test');
  context.skip('Chrome or Chromium is not installed');
  return null;
}

async function createServer() {
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
      response.writeHead(200, {
        'content-type': CONTENT_TYPES[path.extname(requestedPath)] ?? 'application/octet-stream'
      });
      response.end(await readFile(requestedPath));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runStep(context, label, operation, timeoutMs = 5_000) {
  context.diagnostic(`forced-colors stage: ${label}`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
  } catch (error) {
    throw new Error(`forced-colors ${label} failed: ${error?.message ?? error}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

test('preserves forced-colors sorting and minimum-price cues with bounded browser steps', { timeout: 30_000 }, async (context) => {
  if (BROWSER_UNDER_TEST !== 'chromium') {
    context.skip('forced-colors emulation is covered in Chromium');
    return;
  }

  const launchOptions = await resolveChromium(context);
  if (!launchOptions) return;

  const server = await createServer();
  const { port } = server.address();
  let browser;
  let primaryError = null;

  try {
    browser = await runStep(context, 'browser launch', () => chromium.launch(launchOptions), 10_000);
    const page = await runStep(
      context,
      'page creation',
      () => browser.newPage({ viewport: { width: 1365, height: 900 }, forcedColors: 'active' }),
      5_000
    );
    page.setDefaultTimeout(5_000);
    page.setDefaultNavigationTimeout(10_000);

    await runStep(context, 'external route guard', () => page.route('https://**/*', (route) => {
      if (route.request().url().startsWith('https://www.googletagmanager.com/')) {
        return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      }
      return route.abort();
    }));

    await runStep(
      context,
      'initial navigation',
      () => page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 10_000 }),
      10_000
    );
    await runStep(
      context,
      'price table readiness',
      () => page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 0),
      5_000
    );

    const state = await runStep(context, 'forced-colors cue inspection', () => page.evaluate(() => {
      const sorted = document.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]');
      const minimum = document.querySelector('.price-cell.is-minimum');
      return {
        forcedColors: matchMedia('(forced-colors: active)').matches,
        sortedCount: document.querySelectorAll('th[aria-sort="ascending"], th[aria-sort="descending"]').length,
        activeMinimumCardCount: document.querySelectorAll('.minimum-card.is-active-tier').length,
        pressedMinimumCardCount: document.querySelectorAll('.minimum-card[aria-pressed]').length,
        minimumCount: document.querySelectorAll('.price-cell.is-minimum').length,
        sortedBorder: sorted ? getComputedStyle(sorted).borderBottomStyle : null,
        sortedBorderWidth: sorted ? getComputedStyle(sorted).borderBottomWidth : null,
        minimumOutline: minimum ? getComputedStyle(minimum).outlineStyle : null,
        minimumOutlineWidth: minimum ? getComputedStyle(minimum).outlineWidth : null
      };
    }));

    assert.equal(state.forcedColors, true);
    assert.ok(state.sortedCount >= 1, 'the active sort must remain exposed semantically');
    assert.equal(state.activeMinimumCardCount, 0, 'minimum cards must remain neutral action buttons');
    assert.equal(state.pressedMinimumCardCount, 0, 'minimum cards must not expose a pressed state');
    assert.ok(state.minimumCount >= 1, 'the minimum-price cell must be present');
    assert.deepEqual({
      sortedBorder: state.sortedBorder,
      sortedBorderWidth: state.sortedBorderWidth,
      minimumOutline: state.minimumOutline,
      minimumOutlineWidth: state.minimumOutlineWidth
    }, {
      sortedBorder: 'solid',
      sortedBorderWidth: '3px',
      minimumOutline: 'solid',
      minimumOutlineWidth: '1px'
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (browser) {
      try {
        await runStep(context, 'browser cleanup', () => browser.close(), 5_000);
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        context.diagnostic(`forced-colors cleanup after primary failure: ${cleanupError.message}`);
      }
    }
    try {
      await runStep(context, 'server cleanup', () => closeServer(server), 3_000);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      context.diagnostic(`forced-colors server cleanup after primary failure: ${cleanupError.message}`);
    }
  }
});
