#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assetVersionsOf, pageRevisionOf, revisionOf, validateSnapshot, verifyOnce } from './verify-production.mjs';

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
assert.equal(pageRevisionOf(expectedHtml), pageRevision);
assert.deepEqual(assetVersionsOf(expectedHtml), expectedAssets);

function responseFor(url, { html = expectedHtml, app = assetBodies.app, style = assetBodies.style, lucide = assetBodies.lucide } = {}) {
  const pathname = new URL(String(url)).pathname;
  let body;
  if (pathname.endsWith('/data/prices.json')) body = JSON.stringify(data);
  else if (pathname.endsWith('/app.js')) body = app;
  else if (pathname.endsWith('/style.css')) body = style;
  else if (pathname.endsWith('/vendor/lucide-subset.js')) body = lucide;
  else body = html;
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

const goodFetch = async url => responseFor(url);
assert.equal(
  await verifyOnce(data, {
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: goodFetch,
    requestTimeoutMs: 1000
  }),
  data.revision
);

await assert.rejects(
  verifyOnce(data, {
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
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => responseFor(url, { html: expectedHtml.replace(pageRevision, 'c'.repeat(64)) }),
    requestTimeoutMs: 1000
  }),
  /page revision does not match/
);

await assert.rejects(
  verifyOnce(data, {
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

await assert.rejects(
  verifyOnce(data, {
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
await assert.rejects(
  verifyOnce(data, {
    expectedPageRevision: pageRevision,
    expectedAssets,
    fetchImpl: async url => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith('/data/prices.json')) return new Response(JSON.stringify(other), { status: 200 });
      return responseFor(url);
    },
    requestTimeoutMs: 1000
  }),
  /expected revision/
);

console.log('verify-production tests passed');
