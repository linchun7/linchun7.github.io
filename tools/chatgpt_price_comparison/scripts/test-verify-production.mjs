#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { revisionOf, validateSnapshot, verifyOnce } from './verify-production.mjs';

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
assert.match(data.revision, /^[a-f0-9]{64}$/);
assert.equal(validateSnapshot(data), data.revision);

const goodFetch = async url => new Response(
  String(url).includes('/data/prices.json') ? JSON.stringify(data) : '<html>' + data.revision + '</html>',
  { status: 200, headers: { 'content-type': 'text/plain' } }
);
assert.equal(await verifyOnce(data, { fetchImpl: goodFetch, requestTimeoutMs: 1000 }), data.revision);

const bad = structuredClone(data);
bad.generated_at = '2026-09-24T00:00:01Z';
assert.throws(() => validateSnapshot(bad), /revision/);

await assert.rejects(
  verifyOnce(data, { fetchImpl: async () => new Response('blocked', { status: 403 }), requestTimeoutMs: 1000 }),
  /HTTP_403/
);

const other = fixture();
other.generated_at = '2026-09-24T00:00:02Z';
other.revision = revisionOf(other);
await assert.rejects(
  verifyOnce(data, {
    fetchImpl: async url => new Response(
      String(url).includes('/data/prices.json') ? JSON.stringify(other) : '<html>' + other.revision + '</html>',
      { status: 200 }
    ),
    requestTimeoutMs: 1000
  }),
  /expected revision/
);

console.log('verify-production tests passed');
