#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetVersionsOf, pageRevisionOf, revisionOf, validateMinimumHistory, validateSnapshot, verifyOnce } from './verify-production.mjs';

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

function responseFor(url, { html = expectedHtml, app = assetBodies.app, style = assetBodies.style, lucide = assetBodies.lucide } = {}) {
  const pathname = new URL(String(url)).pathname;
  let body;
  if (pathname.endsWith('/data/prices.json')) body = JSON.stringify(data);
  else if (pathname.endsWith('/data/minimum-history.json')) body = JSON.stringify(minimumHistory);
  else if (pathname.endsWith('/app.js')) body = app;
  else if (pathname.endsWith('/style.css')) body = style;
  else if (pathname.endsWith('/vendor/lucide-subset.js')) body = lucide;
  else body = html;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

const goodFetch = async url => responseFor(url);
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
other.generated_at = '2026-09-24T00:00:02Z';
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


for (const failurePhase of ['documents', 'assets']) {
  let pendingRequests = 0;
  let abortedRequests = 0;
  const hangingFetch = async (url, { signal }) => {
    const pathname = new URL(String(url)).pathname;
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
  assert.equal(pendingRequests, 2, failurePhase + ': two sibling requests were in flight');
  assert.equal(abortedRequests, 2, failurePhase + ': failure cancels all in-flight siblings before returning');
}

console.log('verify-production tests passed');
