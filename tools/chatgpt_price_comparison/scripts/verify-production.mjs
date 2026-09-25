#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PRICES_URL = 'https://www.linchun.com.cn/tools/chatgpt_price_comparison/data/prices.json';
export const INDEX_URL = 'https://www.linchun.com.cn/tools/chatgpt_price_comparison/';
const MAX_JSON = 2_000_000;
const MAX_HTML = 4_000_000;
const MAX_ASSET = 1_000_000;
const ASSET_PATHS = {
  app: 'app.js',
  style: 'style.css',
  lucide: 'vendor/lucide-subset.js'
};

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function revisionOf(data) {
  const { revision, ...payload } = data;
  return createHash('sha256').update(canonical(payload)).digest('hex');
}

export function validateSnapshot(data) {
  if (!data || data.schema !== 1 || data.channel !== 'ios-app-store' ||
      !/^[a-f0-9]{64}$/.test(data.revision || '') || revisionOf(data) !== data.revision) {
    throw new Error('production JSON failed revision validation');
  }
  return data.revision;
}

export function pageRevisionOf(html) {
  const matches = [...String(html).matchAll(/<meta name="chatgpt-page-revision" content="([a-f0-9]{64})">/g)];
  if (matches.length !== 1) throw new Error('production HTML page revision meta is missing or duplicated');
  return matches[0][1];
}

export function assetVersionsOf(html) {
  const text = String(html);
  const patterns = {
    app: /src="app\.js\?v=([a-f0-9]{12})"/g,
    style: /href="style\.css\?v=([a-f0-9]{12})"/g,
    lucide: /href="vendor\/lucide-subset\.js\?v=([a-f0-9]{12})"/g
  };
  const result = {};
  for (const [name, pattern] of Object.entries(patterns)) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1) throw new Error('production HTML asset version is missing or duplicated: ' + name);
    result[name] = matches[0][1];
  }
  return result;
}

function validateAssetVersions(versions) {
  const keys = Object.keys(ASSET_PATHS);
  if (!versions || keys.some(key => !/^[a-f0-9]{12}$/.test(versions[key] || '')) ||
      Object.keys(versions).length !== keys.length) {
    throw new Error('expected asset versions are invalid');
  }
}

function assetUrl(name, version) {
  const url = new URL(ASSET_PATHS[name], INDEX_URL);
  url.searchParams.set('v', version);
  return url.href;
}

async function limitedText(response, limit) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('production response exceeds size limit');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) throw new Error('production response exceeds size limit');
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks.map(x => Buffer.from(x))));
}

function verificationUrl(base, attempt) {
  const url = new URL(base);
  url.searchParams.set('verify', String(attempt) + '-' + Date.now());
  return url;
}

async function getText(fetchImpl, base, maxBytes, signal, attempt) {
  const requestUrl = verificationUrl(base, attempt);
  const response = await fetchImpl(requestUrl, {
    signal,
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'user-agent': 'ChatGPTPriceVerifier/1.0'
    }
  });
  if (!response.ok) throw new Error('HTTP_' + response.status);
  if (response.url) {
    const actual = new URL(response.url);
    if (actual.origin !== requestUrl.origin || actual.pathname !== requestUrl.pathname) {
      throw new Error('unexpected production redirect');
    }
  }
  return limitedText(response, maxBytes);
}

export async function verifyOnce(expected, {
  expectedPageRevision,
  expectedAssets,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 12_000,
  attempt = 1
} = {}) {
  if (!/^[a-f0-9]{64}$/.test(expectedPageRevision || '')) {
    throw new Error('expected page revision is invalid');
  }
  validateAssetVersions(expectedAssets);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const [jsonText, html] = await Promise.all([
      getText(fetchImpl, PRICES_URL, MAX_JSON, controller.signal, attempt),
      getText(fetchImpl, INDEX_URL, MAX_HTML, controller.signal, attempt)
    ]);
    const actual = JSON.parse(jsonText);
    validateSnapshot(actual);
    if (actual.revision !== expected.revision) throw new Error('production revision is not expected revision');
    const revisionMeta = `<meta name="chatgpt-data-revision" content="${expected.revision}">`;
    if (!html.includes(revisionMeta)) throw new Error('production HTML data revision meta does not match expected revision');
    if (pageRevisionOf(html) !== expectedPageRevision) {
      throw new Error('production HTML page revision does not match expected build');
    }
    const liveAssets = assetVersionsOf(html);
    if (canonical(liveAssets) !== canonical(expectedAssets)) {
      throw new Error('production HTML asset versions do not match expected build');
    }
    const assetEntries = Object.entries(expectedAssets);
    const assetTexts = await Promise.all(assetEntries.map(([name, version]) =>
      getText(fetchImpl, assetUrl(name, version), MAX_ASSET, controller.signal, attempt)
    ));
    for (let i = 0; i < assetEntries.length; i += 1) {
      const [name, version] = assetEntries[i];
      const actualVersion = createHash('sha256').update(assetTexts[i]).digest('hex').slice(0, 12);
      if (actualVersion !== version) {
        throw new Error('production asset content does not match version: ' + name);
      }
    }
    return actual.revision;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWithRetry(expected, {
  expectedPageRevision,
  expectedAssets,
  maxWaitMs = 5 * 60_000,
  intervalMs = 10_000,
  requestTimeoutMs = 12_000,
  fetchImpl = globalThis.fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now()
} = {}) {
  validateSnapshot(expected);
  const start = now();
  let attempt = 0;
  let lastReason = 'not-attempted';
  while (now() - start <= maxWaitMs) {
    attempt += 1;
    try {
      const revision = await verifyOnce(expected, { expectedPageRevision, expectedAssets, fetchImpl, requestTimeoutMs, attempt });
      console.log('Verified live JSON and HTML revision:', revision, 'attempt:', attempt);
      return { revision, attempt };
    } catch (error) {
      lastReason = error?.name === 'AbortError' ? 'request-timeout' : String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(0, 160);
      console.log('Production verification retry:', attempt, lastReason);
    }
    const remaining = maxWaitMs - (now() - start);
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error('production deployment not verified: ' + lastReason);
}

async function main() {
  const dataIndex = process.argv.indexOf('--expected');
  const pageIndex = process.argv.indexOf('--expected-index');
  if (dataIndex < 0 || !process.argv[dataIndex + 1] || pageIndex < 0 || !process.argv[pageIndex + 1]) {
    throw new Error('usage: verify-production.mjs --expected <prices.json> --expected-index <index.html>');
  }
  const expected = JSON.parse(await readFile(process.argv[dataIndex + 1], 'utf8'));
  const expectedHtml = await readFile(process.argv[pageIndex + 1], 'utf8');
  await verifyWithRetry(expected, {
    expectedPageRevision: pageRevisionOf(expectedHtml),
    expectedAssets: assetVersionsOf(expectedHtml)
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
