#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PRICES_URL = 'https://www.linchun.com.cn/tools/chatgpt_price_comparison/data/prices.json';
export const INDEX_URL = 'https://www.linchun.com.cn/tools/chatgpt_price_comparison/';
const MAX_JSON = 2_000_000;
const MAX_HTML = 4_000_000;

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
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 12_000,
  attempt = 1
} = {}) {
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
    if (!html.includes(expected.revision)) throw new Error('production HTML does not reference expected revision');
    return actual.revision;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWithRetry(expected, {
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
      const revision = await verifyOnce(expected, { fetchImpl, requestTimeoutMs, attempt });
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
  const index = process.argv.indexOf('--expected');
  if (index < 0 || !process.argv[index + 1]) throw new Error('usage: verify-production.mjs --expected <prices.json>');
  const expected = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
  await verifyWithRetry(expected);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
