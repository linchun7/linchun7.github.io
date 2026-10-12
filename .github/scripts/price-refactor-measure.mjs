// Run only in GitHub Actions. A controlled lab comparison, never a production-speed gate.
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const [baselineArg, candidateArg, outArg] = process.argv.slice(2);
const roots = { baseline: resolve(baselineArg), candidate: resolve(candidateArg) };
const out = resolve(outArg);
await mkdir(out, { recursive: true });
const require = createRequire(resolve(roots.candidate, 'tools/chatgpt_price_comparison/package.json'));
const { chromium } = require('playwright');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const baselineSha = execFileSync('git', ['-C', roots.baseline, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const candidateSha = execFileSync('git', ['-C', roots.candidate, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const report = {
  baselineSha, candidateSha, candidateGenerated: true, chromium: null,
  method: 'Five interleaved cold contexts per project and revision; localhost gzip level 9, cache disabled, no throttling. Startup window ends 500 ms after UI-ready. Only loopback requests allowed. Byte totals are response bodies, exclude headers/TLS. Timing is diagnostic, not Lighthouse TTI or production speed.',
  samples: [], errors: []
};
report.dataComparability = [];
for (const project of ['icloud_price_comparison', 'chatgpt_price_comparison']) {
  for (const file of ['prices.json', 'minimum-history.json', ...(project.startsWith('icloud') ? ['history.json'] : [])]) {
    const hashes = {};
    for (const label of ['baseline', 'candidate']) hashes[label] = createHash('sha256').update(await readFile(resolve(roots[label], 'tools', project, 'data', file))).digest('hex');
    report.dataComparability.push({ project, file, ...hashes, identical: hashes.baseline === hashes.candidate });
  }
}
if (report.dataComparability.some(row => !row.identical)) report.errors.push({ error: 'Baseline and candidate data differ; no isolated implementation-speed conclusion is valid.' });
let browser;
const delay = ms => new Promise(r => setTimeout(r, ms));
async function sample(label, project, repetition) {
  const root = roots[label];
  const served = [];
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      let file = resolve(root, '.' + pathname);
      if (!file.startsWith(root + sep)) throw new Error('out of root');
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const raw = await readFile(file);
      const gz = gzipSync(raw, { level: 9 });
      const useGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      const body = useGzip ? gz : raw;
      const record = { path: pathname, status: 200, rawBytes: raw.length, gzip9Bytes: gz.length, servedBodyBytes: body.length, encoding: useGzip ? 'gzip' : 'identity' };
      served.push(record);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Vary': 'Accept-Encoding', ...(useGzip ? { 'Content-Encoding': 'gzip' } : {}) });
      res.end(body);
    } catch {
      served.push({ path: req.url, status: 404, rawBytes: 0, gzip9Bytes: 0, servedBodyBytes: 0 });
      res.writeHead(404); res.end();
    }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  const blocked = [], errors = [], started = [];
  try {
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      blocked.push(route.request().url());
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    page.on('pageerror', error => errors.push(String(error)));
    page.on('request', request => started.push({ url: request.url(), type: request.resourceType() }));
    await page.addInitScript(() => {
      const ready = () => {
        const input = document.querySelector('#searchInput');
        const workspace = document.querySelector('.price-ui-ready');
        if (!workspace || !input || input.disabled) return;
        if (window.__priceDiagnosticReady === undefined) window.__priceDiagnosticReady = performance.now();
        observer.disconnect();
      };
      const observer = new MutationObserver(ready);
      observer.observe(document, { childList: true, subtree: true, attributes: true });
      ready();
    });
    await page.goto(`${origin}/tools/${project}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__priceDiagnosticReady !== undefined, { }, { timeout: 15000 });
    await delay(500);
    const startupServed = served.map(x => ({ ...x }));
    const startupStarted = started.slice();
    const startupBlocked = blocked.slice();
    const timings = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return { uiReadyMs: window.__priceDiagnosticReady, domContentLoadedMs: n.domContentLoadedEventEnd, loadMs: n.loadEventEnd, paints: performance.getEntriesByType('paint').map(p => ({ name: p.name, ms: p.startTime })) };
    });
    const rows = page.locator('#priceRows tr[data-market-id]');
    const originalRows = await rows.count();
    if (!originalRows) throw new Error('No initial market rows');
    await page.locator('#searchInput').fill('zzzz_price_perf_no_match_zzzz');
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 0);
    const provenSearchResponsiveMs = await page.evaluate(() => performance.now());
    await page.locator('#searchInput').fill('');
    await page.waitForFunction(n => document.querySelectorAll('#priceRows tr[data-market-id]').length === n, originalRows);
    const totals = startupServed.reduce((a, r) => {
      for (const key of ['rawBytes', 'gzip9Bytes', 'servedBodyBytes']) a[key] += r[key];
      return a;
    }, { rawBytes: 0, gzip9Bytes: 0, servedBodyBytes: 0 });
    report.samples.push({ label, project, repetition, ...timings, provenSearchResponsiveMs,
      startupRequestCount: startupStarted.filter(r => r.url.startsWith(origin + '/')).length,
      startupResponseCount: startupServed.length, ...totals,
      startupResources: startupServed, blockedExternalRequests: startupBlocked, pageErrors: errors,
      searchRoundTripPassed: true });
  } catch (error) {
    report.errors.push({ label, project, repetition, error: String(error), served, blocked, pageErrors: errors });
  } finally {
    await context.close();
    await new Promise(r => server.close(r));
  }
}
try {
  browser = await chromium.launch({ headless: true });
  report.chromium = browser.version();
  for (const project of ['icloud_price_comparison', 'chatgpt_price_comparison']) {
    for (let i = 0; i < 5; i++) {
      for (const label of i % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await sample(label, project, i);
    }
  }
} catch (error) {
  report.errors.push({ error: String(error) });
} finally {
  if (browser) await browser.close();
  const metrics = ['startupRequestCount', 'rawBytes', 'gzip9Bytes', 'servedBodyBytes', 'uiReadyMs', 'provenSearchResponsiveMs'];
  report.summary = [];
  for (const project of ['icloud_price_comparison', 'chatgpt_price_comparison']) {
    for (const label of ['baseline', 'candidate']) {
      const rows = report.samples.filter(s => s.project === project && s.label === label);
      const summary = { project, label, successfulSamples: rows.length };
      for (const metric of metrics) {
        const values = rows.map(r => r[metric]).sort((a,b) => a-b);
        summary[metric] = values.length ? { min: values[0], median: values[Math.floor(values.length / 2)], max: values.at(-1) } : null;
      }
      report.summary.push(summary);
    }
  }
  await writeFile(resolve(out, 'measurements.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ baselineSha, candidateSha, summary: report.summary, errors: report.errors }, null, 2));
}
// Missing samples are conspicuous but this workflow never sets a speed threshold.
if (report.errors.length) process.exitCode = 1;
