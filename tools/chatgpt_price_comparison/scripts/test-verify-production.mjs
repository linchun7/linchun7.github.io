#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pageRevisionOf, revisionOf, validateSnapshot, verifyOnce } from './verify-production.mjs';

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
const expectedHtml =
  '<html><head>'
  + '<meta name="chatgpt-data-revision" content="' + data.revision + '">'
  + '<meta name="chatgpt-page-revision" content="' + pageRevision + '">'
  + '</head></html>';

assert.match(data.revision, /^[a-f0-9]{64}$/);
assert.equal(validateSnapshot(data), data.revision);
assert.equal(pageRevisionOf(expectedHtml), pageRevision);

const goodFetch = async url => new Response(
  String(url).includes('/data/prices.json') ? JSON.stringify(data) : expectedHtml,
  { status: 200, headers: { 'content-type': 'text/plain' } }
);
assert.equal(
  await verifyOnce(data, { expectedPageRevision: pageRevision, fetchImpl: goodFetch, requestTimeoutMs: 1000 }),
  data.revision
);

await assert.rejects(
  verifyOnce(data, {
    expectedPageRevision: pageRevision,
    fetchImpl: async url => new Response(
      String(url).includes('/data/prices.json')
        ? JSON.stringify(data)
        : '<html><head><meta name="chatgpt-data-revision" content="' + data.revision + '"></head></html>',
      { status: 200, headers: { 'content-type': 'text/plain' } }
    ),
    requestTimeoutMs: 1000
  }),
  /page revision meta/
);

await assert.rejects(
  verifyOnce(data, {
    expectedPageRevision: pageRevision,
    fetchImpl: async url => new Response(
      String(url).includes('/data/prices.json')
        ? JSON.stringify(data)
        : expectedHtml.replace(pageRevision, 'c'.repeat(64)),
      { status: 200, headers: { 'content-type': 'text/plain' } }
    ),
    requestTimeoutMs: 1000
  }),
  /page revision does not match/
);

const bad = structuredClone(data);
bad.generated_at = '2026-09-24T00:00:01Z';
assert.throws(() => validateSnapshot(bad), /revision/);

await assert.rejects(
  verifyOnce(data, {
    expectedPageRevision: pageRevision,
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
    fetchImpl: async url => new Response(
      String(url).includes('/data/prices.json') ? JSON.stringify(other) : expectedHtml,
      { status: 200 }
    ),
    requestTimeoutMs: 1000
  }),
  /expected revision/
);

console.log('verify-production tests passed');
