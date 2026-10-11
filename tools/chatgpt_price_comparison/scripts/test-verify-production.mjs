#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetVersionsOf, pageRevisionOf, revisionOf, validateMinimumHistory, validateSnapshot, verifyOnce, verifyWithRetry } from './verify-production.mjs';

function fixture() {
  const data = {
    schema: 1,
    channel: 'ios-app-store',
    billing_period: 'not_disclosed',
    purchase_eligibility: 'not_verified',
    generated_at: '2026-09-24T00:00:00Z',
    markets: [],
    fx: null,
    changes: []
  };
  data.revision = revisionOf(data);
  return data;
}

const data = fixture();
const minimumHistory = {
  schema: 1, project_since: '2026-09-24', first_observed_at: null,
  checked_at: data.generated_at, observations: 0, excluded_versions: 1,
  pending_gap: true, gaps: [], events: [], checkpoint: null
};
const pageRevision = 'b'.repeat(64);
const assetBodies = {
  app: 'console.log("app");\n',
  style: 'body { display: block; }\n',
  lucide: 'export const icons = {};\n'
};
const expectedAssets = Object.fromEntries(
  Object.entries(assetBodies).map(([name, body]) => [
    name,
    createHash('sha256').update(body).digest('hex').slice(0, 12)
  ])
);
const expectedHtml =
  '<html><head>'
  + '<meta name="chatgpt-data-revision" content="' + data.revision + '">'
  + '<meta name="chatgpt-page-revision" content="' + pageRevision + '">'
  + '<link rel="modulepreload" href="vendor/lucide-subset.js?v=' + expectedAssets.lucide + '">'
  + '<link rel="stylesheet" href="style.css?v=' + expectedAssets.style + '">'
  + '<script src="app.js?v=' + expectedAssets.app + '"></script>'
  + '</head></html>';

assert.match(data.revision, /^[a-f0-9]{64}$/);
assert.equal(validateSnapshot(data), data.revision);
assert.equal(validateMinimumHistory(minimumHistory, data), minimumHistory);
assert.equal(pageRevisionOf(expectedHtml), pageRevision);
assert.deepEqual(assetVersionsOf(expectedHtml), expectedAssets);

function responseFor(url, {
  html = expectedHtml, prices = data, history = minimumHistory,
  app = assetBodies.app, style = assetBodies.style, lucide = assetBodies.lucide
} = {}) {
  const pathname = new URL(String(url)).pathname;
  let body;
  if (pathname.endsWith('/data/prices.json')) body = JSON.stringify(prices);
  else if (pathname.endsWith('/data/minimum-history.json')) body = JSON.stringify(history);
  else if (pathname.endsWith('/app.js')) body = app;
  else if (pathname.endsWith('/style.css')) body = style;
  else if (pathname.endsWith('/vendor/lucide-subset.js')) body = lucide;
  else body = html;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

const requests = [];
const goodFetch = async (url, options) => {
  requests.push({ url: new URL(String(url)), options });
  return responseFor(url);
};
assert.equal(
  await verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: goodFetch,
    requestTimeoutMs: 1000
  }),
  data.revision
);

assert.equal(requests.length, 12, 'success requires both diagnostic and canonical checks');
const versionsByPath = {
  '/app.js': expectedAssets.app, '/style.css': expectedAssets.style,
  '/vendor/lucide-subset.js': expectedAssets.lucide
};
for (const [index, { url, options }] of requests.entries()) {
  const diagnostic = index < 6;
  const assetPath = Object.keys(versionsByPath).find(path => url.pathname.endsWith(path));
  assert.equal(url.searchParams.has('verify'), diagnostic);
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal, requests[0].options.signal, 'both phases share the attempt timeout');
  if (diagnostic) {
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['cache-control'], 'no-cache');
    assert.equal(options.headers.pragma, 'no-cache');
  } else {
    assert.equal(options.cache, undefined, 'canonical acceptance uses normal cache behavior');
    assert.equal(options.headers['cache-control'], undefined);
    assert.equal(options.headers.pragma, undefined);
    assert.deepEqual([...url.searchParams.keys()], assetPath ? ['v'] : []);
  }
  if (assetPath) assert.equal(url.searchParams.get('v'), versionsByPath[assetPath]);
}

await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => responseFor(url, {
      html: '<html><head><meta name="chatgpt-data-revision" content="' + data.revision + '"></head></html>'
    }),
    requestTimeoutMs: 1000
  }),
  /page revision meta/
);

await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => responseFor(url, { html: expectedHtml.replace(pageRevision, 'c'.repeat(64)) }),
    requestTimeoutMs: 1000
  }),
  /page revision does not match/
);

await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => responseFor(url, {
      html: expectedHtml.replace(expectedAssets.app, 'd'.repeat(12))
    }),
    requestTimeoutMs: 1000
  }),
  /asset versions do not match/
);

await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => responseFor(url, { app: 'console.log("different");\n' }),
    requestTimeoutMs: 1000
  }),
  /asset content does not match version: app/
);

const bad = structuredClone(data);
bad.generated_at = '2026-09-24T00:00:01Z';
assert.throws(() => validateSnapshot(bad), /revision/);

const wrongHistory = structuredClone(minimumHistory);
wrongHistory.checked_at = '2026-09-24T00:00:01Z';
await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: wrongHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: goodFetch,
    requestTimeoutMs: 1000
  }),
  /minimum history/
);

await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async () => new Response('blocked', { status: 403 }),
    requestTimeoutMs: 1000
  }),
  /HTTP_403/
);

const other = fixture();
other.generated_at = '2026-09-23T23:59:58Z';
other.revision = revisionOf(other);
const otherMinimumHistory = structuredClone(minimumHistory);
otherMinimumHistory.checked_at = other.generated_at;
await assert.rejects(
  verifyOnce(data, {
    expectedMinimumHistory: minimumHistory,
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/data/prices.json')) return new Response(JSON.stringify(other), { status: 200 });
      if (pathname.endsWith('/data/minimum-history.json')) return new Response(JSON.stringify(otherMinimumHistory), { status: 200 });
      return responseFor(url);
    },
    requestTimeoutMs: 1000
  }),
  /expected revision/
);


const verificationOptions = {
  expectedMinimumHistory: minimumHistory, expectedPageRevision: pageRevision,
  expectedAssets, requestTimeoutMs: 1000
};
// A fresh cache-bypassing response must not hide stale ordinary URLs.
for (const { name, overrides, reason } of [
  { name: 'prices', overrides: { prices: other, history: otherMinimumHistory }, reason: /expected revision/ },
  { name: 'minimum history', overrides: { history: { ...minimumHistory, pending_gap: false } }, reason: /minimum history is not expected/ },
  { name: 'HTML', overrides: { html: expectedHtml.replace(pageRevision, 'c'.repeat(64)) }, reason: /page revision does not match/ },
  { name: 'app', overrides: { app: 'console.log("older app");\n' }, reason: /asset content does not match version: app/ },
  { name: 'style', overrides: { style: 'body { display: none; }\n' }, reason: /asset content does not match version: style/ },
  { name: 'lucide', overrides: { lucide: 'export const oldIcons = {};\n' }, reason: /asset content does not match version: lucide/ }
]) {
  let diagnosticRequests = 0;
  await assert.rejects(verifyOnce(data, {
    ...verificationOptions,
    fetchImpl: async url => {
      const diagnostic = new URL(String(url)).searchParams.has('verify');
      if (diagnostic) diagnosticRequests += 1;
      return responseFor(url, diagnostic ? {} : overrides);
    }
  }), reason, name + ': canonical mismatch must fail');
  assert.equal(diagnosticRequests, 6, name + ': diagnostic passed before canonical rejection');
}

for (const path of ['/data/prices.json', '/data/minimum-history.json', '/', '/app.js', '/style.css', '/vendor/lucide-subset.js']) {
  await assert.rejects(verifyOnce(data, {
    ...verificationOptions,
    fetchImpl: async url => {
      const request = new URL(String(url));
      if (!request.searchParams.has('verify') && request.pathname.endsWith(path)) {
        return new Response('unavailable', { status: 503 });
      }
      return responseFor(url);
    }
  }), /HTTP_503/, path + ': canonical availability is required');
}

let elapsed = 0;
let retryAttempts = 0;
assert.deepEqual(await verifyWithRetry(data, {
  ...verificationOptions, maxWaitMs: 10, intervalMs: 10,
  now: () => elapsed, sleep: async ms => { elapsed += ms; },
  fetchImpl: async url => {
    const request = new URL(String(url));
    if (request.searchParams.has('verify') && request.pathname.endsWith('/data/prices.json')) retryAttempts += 1;
    return responseFor(url, !request.searchParams.has('verify') && retryAttempts === 1
      ? { html: expectedHtml.replace(pageRevision, 'c'.repeat(64)) } : {});
  }
}), { revision: data.revision, attempt: 2 });
assert.equal(retryAttempts, 2, 'canonical lag retries inside the original budget');

elapsed = 0;
retryAttempts = 0;
await assert.rejects(verifyWithRetry(data, {
  ...verificationOptions, maxWaitMs: 20, intervalMs: 10,
  now: () => elapsed, sleep: async ms => { elapsed += ms; },
  fetchImpl: async url => {
    const request = new URL(String(url));
    if (request.pathname.endsWith('/data/prices.json')) {
      if (request.searchParams.has('verify')) retryAttempts += 1;
      else return new Response('unavailable', { status: 503 });
    }
    return responseFor(url);
  }
}), /production deployment not verified: HTTP_503/);
assert.equal(retryAttempts, 3, 'diagnostic success never bypasses the retry deadline');

for (const failureMode of ['diagnostic', 'canonical']) {
  for (const failurePhase of ['documents', 'assets']) {
    let pendingRequests = 0;
    let abortedRequests = 0;
    const hangingFetch = async (url, { signal }) => {
      const request = new URL(String(url));
      const diagnostic = request.searchParams.has('verify');
      if ((failureMode === 'diagnostic') !== diagnostic) return responseFor(url);
      const pathname = request.pathname;
      const isDocument = pathname.endsWith('/data/prices.json')
        || pathname.endsWith('/data/minimum-history.json') || pathname.endsWith('/');
      if (failurePhase === 'assets' && isDocument) return responseFor(url);
      const failHere = failurePhase === 'documents'
        ? pathname.endsWith('/data/prices.json')
        : pathname.endsWith('/app.js');
      if (failHere) return new Response('unavailable', { status: 503 });
      pendingRequests += 1;
      return new Promise((resolve, reject) => {
        const abort = () => { abortedRequests += 1; reject(new DOMException('Cancelled sibling request', 'AbortError')); };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    };
    await assert.rejects(
      verifyOnce(data, {
        expectedMinimumHistory: minimumHistory,
        expectedPageRevision: pageRevision,
        expectedAssets,
        fetchImpl: hangingFetch,
        requestTimeoutMs: 1000
      }),
      /HTTP_503/
    );
    assert.equal(pendingRequests, 2, failureMode + ' ' + failurePhase + ': two sibling requests were in flight');
    assert.equal(abortedRequests, 2, failureMode + ' ' + failurePhase + ': failure cancels all in-flight siblings before returning');
  }
}


let timedOutRequests = 0;
let cancelledRequests = 0;
await assert.rejects(verifyOnce(data, {
  ...verificationOptions, requestTimeoutMs: 100,
  fetchImpl: async (url, { signal }) => {
    if (new URL(String(url)).searchParams.has('verify')) return responseFor(url);
    timedOutRequests += 1;
    return new Promise((resolve, reject) => {
      const abort = () => {
        cancelledRequests += 1;
        reject(new DOMException('Canonical request timeout', 'AbortError'));
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  }
}), { name: 'AbortError' });
assert.equal(timedOutRequests, 3, 'canonical documents were checked after diagnostic success');
assert.equal(cancelledRequests, 3, 'canonical timeout aborts every in-flight request');

console.log('verify-production tests passed');
