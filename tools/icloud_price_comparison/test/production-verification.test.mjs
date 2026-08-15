import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  PRODUCTION_PRICES_URL,
  verifyProductionDeployment
} from '../scripts/verify-production-deployment.mjs';

const pricesUrl = new URL('../data/prices.json', import.meta.url);

function shiftedPayload(payload, hours) {
  const shifted = structuredClone(payload);
  const shift = (value) => new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
  shifted.generatedAt = shift(shifted.generatedAt);
  shifted.run.startedAtUtc = shift(shifted.run.startedAtUtc);
  shifted.run.finishedAtUtc = shift(shifted.run.finishedAtUtc);
  shifted.run.observedAtUtc = shifted.run.finishedAtUtc;
  shifted.run.observedAtBeijing = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(shifted.run.finishedAtUtc));
  shifted.fx.fetchedAt = shift(shifted.fx.fetchedAt);
  return shifted;
}

async function startSequenceServer(sequence) {
  let requests = 0;
  const observedRequests = [];
  const server = createServer(async (request, response) => {
    const item = sequence[Math.min(requests, sequence.length - 1)];
    requests += 1;
    observedRequests.push({ url: request.url, cacheControl: request.headers['cache-control'], pragma: request.headers.pragma });
    if (item.delayMs) await new Promise((resolve) => setTimeout(resolve, item.delayMs));
    response.writeHead(item.status ?? 200, { 'content-type': item.contentType ?? 'application/json' });
    response.end(item.body ?? JSON.stringify(item.payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/prices.json`,
    get requests() { return requests; },
    observedRequests,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  };
}

function fastOptions(server, overrides = {}) {
  let nowMs = 0;
  return {
    productionUrl: server.url,
    runId: 'test-run',
    maxWaitMs: 4,
    intervalMs: 1,
    requestTimeoutMs: 1_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
    log: () => {},
    ...overrides
  };
}

test('production verifier uses the fixed trusted production URL by default', () => {
  assert.equal(PRODUCTION_PRICES_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json');
});

test('production verifier passes immediately with cache bypass headers and a unique query', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const server = await startSequenceServer([{ payload: expected }]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(result.status, 'deployed');
  assert.equal(server.requests, 1);
  assert.match(server.observedRequests[0].url, /\?verify=test-run-1$/);
  assert.equal(server.observedRequests[0].cacheControl, 'no-cache');
  assert.equal(server.observedRequests[0].pragma, 'no-cache');
});

test('production verifier retries old data until the expected deployment appears', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const old = shiftedPayload(expected, -1);
  const server = await startSequenceServer([{ payload: old }, { payload: old }, { payload: old }, { payload: expected }]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(result.status, 'deployed');
  assert.equal(server.requests, 4);
});

test('production verifier fails with PUBLISH_PRODUCTION_NOT_UPDATED when data stays old', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const server = await startSequenceServer([{ payload: shiftedPayload(expected, -1) }]);
  t.after(() => server.close());
  await assert.rejects(
    () => verifyProductionDeployment(expected, fastOptions(server, { maxWaitMs: 2 })),
    (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED' && error.details.lastReason === 'not-deployed-yet'
  );
});

test('production verifier retries 5xx, request timeout, and malformed JSON', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  for (const { first, requestTimeoutMs = 1_000 } of [
    { first: { status: 503, body: '{}' } },
    { first: { delayMs: 1_500, payload: expected }, requestTimeoutMs: 500 },
    { first: { body: '{invalid' } }
  ]) {
    const server = await startSequenceServer([first, { payload: expected }]);
    try {
      const result = await verifyProductionDeployment(expected, fastOptions(server, { requestTimeoutMs }));
      assert.equal(result.status, 'deployed');
      assert.equal(server.requests, 2);
    } finally {
      await server.close();
    }
  }
});

test('production verifier never accepts matching generatedAt with a different finishedAt', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const wrong = structuredClone(expected);
  wrong.run.startedAtUtc = new Date(Date.parse(expected.run.startedAtUtc) - 1_000).toISOString();
  wrong.run.finishedAtUtc = wrong.run.startedAtUtc;
  wrong.run.observedAtUtc = wrong.run.finishedAtUtc;
  wrong.generatedAt = wrong.run.finishedAtUtc;
  const server = await startSequenceServer([{ payload: wrong }]);
  t.after(() => server.close());
  await assert.rejects(
    () => verifyProductionDeployment(expected, fastOptions(server, { maxWaitMs: 1 })),
    (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
  );
});

test('production verifier rejects non-cross-checked and contract-invalid payloads', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const degraded = structuredClone(expected);
  degraded.source.parser = 'document-order';
  const invalid = structuredClone(expected);
  invalid.untrusted = true;
  for (const payload of [degraded, invalid]) {
    const server = await startSequenceServer([{ payload }]);
    try {
      await assert.rejects(
        () => verifyProductionDeployment(expected, fastOptions(server, { maxWaitMs: 1 })),
        (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
      );
    } finally {
      await server.close();
    }
  }
});

test('production verifier accepts a newer payload only when it matches current main', async (t) => {
  const expected = JSON.parse(await readFile(pricesUrl, 'utf8'));
  const newer = shiftedPayload(expected, 1);
  const provenServer = await startSequenceServer([{ payload: newer }]);
  try {
    const result = await verifyProductionDeployment(expected, fastOptions(provenServer, {
      getCurrentMainPayload: async () => newer
    }));
    assert.equal(result.status, 'superseded');
  } finally {
    await provenServer.close();
  }

  const unprovenServer = await startSequenceServer([{ payload: newer }]);
  t.after(() => unprovenServer.close());
  await assert.rejects(
    () => verifyProductionDeployment(expected, fastOptions(unprovenServer, {
      maxWaitMs: 1,
      getCurrentMainPayload: async () => expected
    })),
    (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED' && error.details.lastReason === 'newer-version-unproven'
  );
});
