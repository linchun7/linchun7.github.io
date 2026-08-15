import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MAX_HISTORY_RESPONSE_BYTES,
  MAX_RUN_LOG_RESPONSE_BYTES,
  PRODUCTION_HISTORY_URL,
  PRODUCTION_INDEX_URL,
  PRODUCTION_PRICES_URL,
  PRODUCTION_RUN_LOG_URL,
  createVerificationArtifact,
  loadVerificationArtifact,
  verifyProductionDeployment
} from '../scripts/verify-production-deployment.mjs';
import { renderStaticFragments, replaceStaticFragments } from '../scripts/static-page.mjs';

const dataDirectory = new URL('../data/', import.meta.url);
const indexUrl = new URL('../index.html', import.meta.url);
const RESOURCE_PATHS = {
  prices: '/prices.json', history: '/history.json', runLog: '/run-log.json', index: '/index.html'
};

function shiftedArtifact(artifact, hours) {
  const prices = structuredClone(artifact.prices);
  const history = structuredClone(artifact.history);
  const runLog = structuredClone(artifact.runLog);
  const shift = (value) => new Date(Date.parse(value) + hours * 60 * 60 * 1_000).toISOString();
  prices.generatedAt = shift(prices.generatedAt);
  prices.run.startedAtUtc = shift(prices.run.startedAtUtc);
  prices.run.finishedAtUtc = shift(prices.run.finishedAtUtc);
  prices.run.observedAtUtc = prices.run.finishedAtUtc;
  prices.run.observedAtBeijing = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(prices.run.finishedAtUtc));
  prices.fx.fetchedAt = shift(prices.fx.fetchedAt);
  const latest = runLog.runs.at(-1);
  latest.id = prices.run.finishedAtUtc;
  latest.startedAtUtc = prices.run.startedAtUtc;
  latest.finishedAtUtc = prices.run.finishedAtUtc;
  latest.durationMs = Date.parse(latest.finishedAtUtc) - Date.parse(latest.startedAtUtc);
  latest.observedAtBeijing = prices.run.observedAtBeijing;
  if (latest.automaticRunDateBeijing) latest.automaticRunDateBeijing = prices.run.observedAtBeijing;
  latest.source.exchangeRatesFetchedAtUtc = prices.fx.fetchedAt;
  runLog.updatedAtUtc = latest.finishedAtUtc;
  return createVerificationArtifact({ prices, history, runLog }, 'shifted fixture');
}

function withRawWhitespace(artifact, resource) {
  return {
    ...artifact,
    raw: { ...artifact.raw, [resource]: Buffer.concat([Buffer.from(artifact.raw[resource]), Buffer.from('\n')]) }
  };
}

function olderHistoryArtifact(artifact) {
  const history = structuredClone(artifact.history);
  history.sourcePublishedDates.shift();
  return createVerificationArtifact({ prices: artifact.prices, history, runLog: artifact.runLog }, 'older history fixture');
}

function olderRunLogArtifact(artifact) {
  const runLog = structuredClone(artifact.runLog);
  runLog.runs.shift();
  return createVerificationArtifact({ prices: artifact.prices, history: artifact.history, runLog }, 'older run-log fixture');
}

function attemptFromUrl(requestUrl) {
  const token = new URL(requestUrl, 'http://localhost').searchParams.get('verify') ?? '';
  const match = token.match(/-(\d+)$/);
  return Math.max(0, Number(match?.[1] ?? 1) - 1);
}

async function startSequenceServer(sequence) {
  const indexTemplate = await readFile(indexUrl, 'utf8');
  const observedRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const resource = Object.entries(RESOURCE_PATHS).find(([, pathname]) => pathname === url.pathname)?.[0];
    const attempt = attemptFromUrl(request.url);
    const item = sequence[Math.min(attempt, sequence.length - 1)];
    const override = item.responses?.[resource] ?? {};
    observedRequests.push({ resource, attempt: attempt + 1, url: request.url, cacheControl: request.headers['cache-control'], pragma: request.headers.pragma });
    if (override.delayMs) await new Promise((resolve) => setTimeout(resolve, override.delayMs));
    if (response.destroyed) return;
    if (override.redirect) {
      response.writeHead(302, { location: override.redirect });
      response.end();
      return;
    }
    if (override.declaredLength) response.setHeader('content-length', override.declaredLength);
    if (resource === 'index') {
      const html = override.body ?? replaceStaticFragments(indexTemplate, renderStaticFragments(item.htmlPrices ?? item.artifact.prices));
      response.writeHead(override.status ?? 200, { 'content-type': override.contentType ?? 'text/html; charset=utf-8' });
      response.end(html);
      return;
    }
    const body = override.body ?? item.artifact.raw[resource];
    response.writeHead(override.status ?? 200, { 'content-type': override.contentType ?? 'application/json' });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    urls: {
      productionPricesUrl: `${base}/prices.json`, productionHistoryUrl: `${base}/history.json`,
      productionRunLogUrl: `${base}/run-log.json`, productionIndexUrl: `${base}/index.html`
    },
    observedRequests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

function fastOptions(server, overrides = {}) {
  let nowMs = 0;
  return {
    ...server.urls, runId: 'test-run', maxWaitMs: 4, intervalMs: 1, requestTimeoutMs: 1_000,
    now: () => nowMs, sleep: async (milliseconds) => { nowMs += milliseconds; }, log: () => {}, ...overrides
  };
}

async function rejectsWithReason(expected, sequence, reason, options = {}) {
  const server = await startSequenceServer(sequence);
  try {
    await assert.rejects(
      () => verifyProductionDeployment(expected, fastOptions(server, { maxWaitMs: 1, ...options })),
      (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED' && new RegExp(reason).test(error.details.lastReason)
    );
  } finally {
    await server.close();
  }
}

const expected = await loadVerificationArtifact(dataDirectory, 'committed fixture');

test('uses fixed trusted production URLs for all four resources', () => {
  assert.equal(PRODUCTION_PRICES_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json');
  assert.equal(PRODUCTION_HISTORY_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/history.json');
  assert.equal(PRODUCTION_RUN_LOG_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/run-log.json');
  assert.equal(PRODUCTION_INDEX_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/');
});

test('passes only when prices, history, run-log, and HTML all match', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.resources, {
    'prices.json': 'verified', 'history.json': 'verified', 'run-log.json': 'verified', 'index.html': 'verified against prices.json'
  });
});

for (const [name, firstArtifact, expectedAttempts] of [
  ['prices', shiftedArtifact(expected, -1), 2],
  ['history', olderHistoryArtifact(expected), 2],
  ['run-log', olderRunLogArtifact(expected), 2]
]) {
  test(`retries when ${name} has not deployed`, async (t) => {
    const server = await startSequenceServer([{ artifact: firstArtifact }, { artifact: expected }]);
    t.after(() => server.close());
    const result = await verifyProductionDeployment(expected, fastOptions(server));
    assert.equal(result.status, 'deployed');
    assert.equal(result.attempts, expectedAttempts);
  });
}

test('retries when HTML is from an older prices snapshot', async (t) => {
  const server = await startSequenceServer([
    { artifact: expected, htmlPrices: shiftedArtifact(expected, -1).prices },
    { artifact: expected }
  ]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(result.attempts, 2);
});

test('rejects malformed history', () => rejectsWithReason(expected, [{ artifact: expected, responses: { history: { body: '{bad' } } }], 'history-invalid'));
test('rejects malformed run-log', () => rejectsWithReason(expected, [{ artifact: expected, responses: { runLog: { body: '{bad' } } }], 'run-log-invalid'));
test('rejects oversized history', () => rejectsWithReason(expected, [{ artifact: expected, responses: { history: { declaredLength: MAX_HISTORY_RESPONSE_BYTES + 1 } } }], 'history-invalid'));
test('rejects oversized run-log', () => rejectsWithReason(expected, [{ artifact: expected, responses: { runLog: { declaredLength: MAX_RUN_LOG_RESPONSE_BYTES + 1 } } }], 'run-log-invalid'));
test('rejects wrong history content type', () => rejectsWithReason(expected, [{ artifact: expected, responses: { history: { contentType: 'text/html' } } }], 'history-invalid'));
test('rejects wrong run-log content type', () => rejectsWithReason(expected, [{ artifact: expected, responses: { runLog: { contentType: 'text/plain' } } }], 'run-log-invalid'));
test('rejects redirected history', () => rejectsWithReason(expected, [{ artifact: expected, responses: { history: { redirect: '/other-history.json' } } }], 'history-invalid'));
test('rejects redirected run-log', () => rejectsWithReason(expected, [{ artifact: expected, responses: { runLog: { redirect: '/other-log.json' } } }], 'run-log-invalid'));
test('rejects duplicate JSON keys and malformed UTF-8 before contract validation', async () => {
  await rejectsWithReason(expected, [{ artifact: expected, responses: { history: { body: '{"schemaVersion":4,"schemaVersion":4}' } } }], 'history-invalid');
  await rejectsWithReason(expected, [{ artifact: expected, responses: { runLog: { body: Buffer.from([0xc3, 0x28]) } } }], 'run-log-invalid');
});

test('accepts an exactly matching history whose updatedAt predates prices.generatedAt', async (t) => {
  assert.ok(Date.parse(expected.history.updatedAt) < Date.parse(expected.prices.generatedAt));
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  assert.equal((await verifyProductionDeployment(expected, fastOptions(server))).status, 'deployed');
});

test('accepts a newer deployment only when current main proves the full artifact', async (t) => {
  const newer = withRawWhitespace(shiftedArtifact(expected, 1), 'history');
  const server = await startSequenceServer([{ artifact: newer }]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server, { getCurrentMainArtifact: async () => newer }));
  assert.equal(result.status, 'superseded');
});

test('does not accept supersession when production history is still expected A', () => {
  const newer = withRawWhitespace(shiftedArtifact(expected, 1), 'history');
  const mixed = { ...newer, raw: { ...newer.raw, history: expected.raw.history }, history: expected.history };
  return rejectsWithReason(expected, [{ artifact: mixed }], 'history-not-deployed', { getCurrentMainArtifact: async () => newer });
});

test('does not accept supersession when production run-log is still expected A', () => {
  const newer = withRawWhitespace(shiftedArtifact(expected, 1), 'history');
  const mixed = { ...newer, raw: { ...newer.raw, runLog: expected.raw.runLog }, runLog: expected.runLog };
  return rejectsWithReason(expected, [{ artifact: mixed }], 'run-log-invalid', { getCurrentMainArtifact: async () => newer });
});

test('invalid current-main data cannot prove supersession', () => {
  const newer = shiftedArtifact(expected, 1);
  const invalid = { prices: newer.prices, history: newer.history, runLog: { ...newer.runLog, untrusted: true } };
  return rejectsWithReason(expected, [{ artifact: newer }], 'current-main-invalid', { getCurrentMainArtifact: async () => invalid });
});

test('applies cache bypass headers and a unique query to every resource and attempt', async (t) => {
  const old = shiftedArtifact(expected, -1);
  const server = await startSequenceServer([{ artifact: old }, { artifact: expected }]);
  t.after(() => server.close());
  await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(server.observedRequests.length, 8);
  for (const request of server.observedRequests) {
    assert.equal(request.cacheControl, 'no-cache');
    assert.equal(request.pragma, 'no-cache');
    assert.match(request.url, new RegExp(`\\?verify=test-run-${request.attempt}$`));
  }
  assert.deepEqual(new Set(server.observedRequests.map(({ resource }) => resource)), new Set(['prices', 'history', 'runLog', 'index']));
});

test('retries HTTP failure, timeout, malformed prices, and stale static HTML without weakening the contract', async () => {
  for (const [responses, requestTimeoutMs = 1_000] of [
    [{ prices: { status: 503, body: '{}' } }],
    [{ history: { delayMs: 400 } }, 150],
    [{ prices: { body: '{bad' } }],
    [{ index: { body: '<!doctype html><title>old</title>' } }]
  ]) {
    const server = await startSequenceServer([{ artifact: expected, responses }, { artifact: expected }]);
    try {
      const result = await verifyProductionDeployment(expected, fastOptions(server, { requestTimeoutMs }));
      assert.equal(result.attempts, 2);
    } finally {
      await server.close();
    }
  }
});

test('aborts pending sibling requests when one resource fails fast before retry', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const pendingSignals = [];

  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const token = parsedUrl.searchParams.get('verify') ?? '';
    const attempt = Number(token.match(/-(\d+)$/)?.[1] ?? 1);
    if (attempt === 1 && parsedUrl.pathname === new URL(server.urls.productionPricesUrl).pathname) {
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    if (attempt === 1) {
      pendingSignals.push(options.signal);
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener('abort', abort, { once: true });
      });
    }
    return globalThis.fetch(url, options);
  };

  const result = await verifyProductionDeployment(expected, fastOptions(server, { fetchImpl }));
  assert.equal(result.status, 'deployed');
  assert.equal(result.attempts, 2);
  assert.equal(pendingSignals.length, 3);
  for (const signal of pendingSignals) assert.equal(signal.aborted, true);
});

test('rejects non-cross-checked prices and mismatched finishedAt', async () => {
  for (const mutate of [
    (prices) => { prices.source.parser = 'document-order'; },
    (prices) => { prices.run.finishedAtUtc = prices.run.startedAtUtc; }
  ]) {
    const values = { prices: structuredClone(expected.prices), history: structuredClone(expected.history), runLog: structuredClone(expected.runLog) };
    mutate(values.prices);
    const raw = {
      prices: Buffer.from(JSON.stringify(values.prices)), history: Buffer.from(JSON.stringify(values.history)), runLog: Buffer.from(JSON.stringify(values.runLog))
    };
    await rejectsWithReason(expected, [{ artifact: { ...values, raw }, htmlPrices: expected.prices }], 'prices-invalid|run-log-invalid');
  }
});

test('the existing-production idempotent path uses the same complete verifier contract', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const first = await verifyProductionDeployment(expected, fastOptions(server, { runId: 'existing-1' }));
  const second = await verifyProductionDeployment(expected, fastOptions(server, { runId: 'existing-2' }));
  assert.equal(first.status, 'deployed');
  assert.equal(second.status, 'deployed');
  assert.equal(server.observedRequests.length, 8);
});
