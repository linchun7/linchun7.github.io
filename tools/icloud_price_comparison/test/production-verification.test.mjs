import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { mock } from 'node:test';
import {
  readBoundedResponse, runCli, createCurrentMainReader,
  MAX_HISTORY_RESPONSE_BYTES,
  MAX_RUN_LOG_RESPONSE_BYTES,
  PRODUCTION_HISTORY_URL,
  PRODUCTION_MINIMUM_HISTORY_URL,
  PRODUCTION_INDEX_URL,
  PRODUCTION_PRICES_URL,
  PRODUCTION_RUN_LOG_URL,
  createVerificationArtifact,
  loadVerificationArtifact,
  verifyProductionDeployment
} from '../scripts/verify-production-deployment.mjs';
import { renderStaticFragments, replaceStaticFragments } from '../scripts/static-page.mjs';

import { advanceMinimumHistory } from '../scripts/minimum-history.mjs';

const dataDirectory = new URL('../data/', import.meta.url);
const indexUrl = new URL('../index.html', import.meta.url);
const RESOURCE_PATHS = {
  prices: '/prices.json', history: '/history.json', runLog: '/run-log.json', minimumHistory: '/minimum-history.json', index: '/index.html'
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
  return createVerificationArtifact({ prices, history, runLog, minimumHistory: advanceMinimumHistory(null, prices) }, 'shifted fixture');
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
  return createVerificationArtifact({ prices: artifact.prices, history, runLog: artifact.runLog, minimumHistory: artifact.minimumHistory }, 'older history fixture');
}

function olderRunLogArtifact(artifact) {
  const runLog = structuredClone(artifact.runLog);
  runLog.runs.shift();
  return createVerificationArtifact({ prices: artifact.prices, history: artifact.history, runLog, minimumHistory: artifact.minimumHistory }, 'older run-log fixture');
}

function attemptFromUrl(requestUrl) {
  const token = new URL(requestUrl, 'http://localhost').searchParams.get('verify') ?? '';
  const match = token.match(/-(\d+)$/);
  return Math.max(0, Number(match?.[1] ?? 1) - 1);
}

async function startSequenceServer(sequence) {
  const indexTemplate = await readFile(indexUrl, 'utf8');
  const observedRequests = [];
  let latestDiagnosticAttempt = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const resource = Object.entries(RESOURCE_PATHS).find(([, pathname]) => pathname === url.pathname)?.[0];
    const diagnostic = url.search.includes('verify=');
    const attempt = diagnostic ? attemptFromUrl(request.url) : latestDiagnosticAttempt;
    if (diagnostic) latestDiagnosticAttempt = attempt;
    const item = sequence[Math.min(attempt, sequence.length - 1)];
    const override = item.responses?.[resource] ?? {};
    observedRequests.push({ resource, attempt: attempt + 1, diagnostic, url: request.url, cacheControl: request.headers['cache-control'], pragma: request.headers.pragma });
    if (override.delayMs) await new Promise((resolve) => setTimeout(resolve, override.delayMs));
    if (response.destroyed) return;
    if (override.redirect) {
      response.writeHead(302, { location: override.redirect });
      response.end();
      return;
    }
    if (override.declaredLength) response.setHeader('content-length', override.declaredLength);
    if (resource === 'index') {
      const html = override.body ?? replaceStaticFragments(
        indexTemplate,
        renderStaticFragments(item.htmlPrices ?? item.artifact.prices, item.htmlHistory ?? item.artifact.history)
      );
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
      productionMinimumHistoryUrl: `${base}/minimum-history.json`,
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

// Reserve two synthetic hours ABOVE the coherent committed observation so an
// older deployment does not rewind new-market/history evidence into the future.
const committed = await loadVerificationArtifact(dataDirectory, 'committed fixture');
mock.timers.enable({ apis: ['Date'], now: new Date(Date.parse(committed.prices.generatedAt) + 3 * 60 * 60 * 1000) });
const expected = shiftedArtifact(committed, 2);

function supersessionFixtures() {
  const previous = shiftedArtifact(expected, -1);
  // Keep parsed history identical while making its raw hash distinct, so supersession proves exact current-main bytes.
  const current = withRawWhitespace(expected, 'history');

  assert.ok(
    Date.parse(current.prices.generatedAt)
      > Date.parse(previous.prices.generatedAt),
    'supersession fixture must keep current production newer than the previous expected artifact'
  );

  return {
    previous,
    current
  };
}

test('uses fixed trusted production URLs for all five resources', () => {
  assert.equal(PRODUCTION_PRICES_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json');
  assert.equal(PRODUCTION_MINIMUM_HISTORY_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/minimum-history.json');
  assert.equal(PRODUCTION_HISTORY_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/history.json');
  assert.equal(PRODUCTION_RUN_LOG_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/run-log.json');
  assert.equal(PRODUCTION_INDEX_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/');
});

test('passes only when prices, history, run-log, minimum history, and HTML all match', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(result.status, 'deployed');
  assert.deepEqual(result.resources, {
    'prices.json': 'verified', 'history.json': 'verified', 'run-log.json': 'verified', 'minimum-history.json': 'verified', 'index.html': 'verified against prices.json'
  });
});

for (const [name, firstArtifact, expectedAttempts] of [
  ['prices', shiftedArtifact(expected, -1), 2],
  ['history', olderHistoryArtifact(expected), 2],
  ['run-log', olderRunLogArtifact(expected), 2],
  ['minimum-history', withRawWhitespace(expected, 'minimumHistory'), 2]
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
  const {
    previous,
    current
  } = supersessionFixtures();

  const server = await startSequenceServer([
    {
      artifact: current
    }
  ]);

  t.after(() => server.close());

  const result = await verifyProductionDeployment(
    previous,
    fastOptions(server, {
      getCurrentMainArtifact: async () => current
    })
  );

  assert.equal(result.status, 'superseded');

  assert.equal(
    result.expectedGeneratedAt,
    previous.prices.generatedAt
  );

  assert.equal(
    result.observedGeneratedAt,
    current.prices.generatedAt
  );
});

test('does not accept supersession when production history is still expected A', () => {
  const {
    previous,
    current
  } = supersessionFixtures();

  const mixed = {
    ...current,
    raw: {
      ...current.raw,
      history: previous.raw.history
    },
    history: previous.history
  };

  return rejectsWithReason(
    previous,
    [
      {
        artifact: mixed
      }
    ],
    'history-not-deployed',
    {
      getCurrentMainArtifact: async () => current
    }
  );
});

test('does not accept supersession when production run-log is still expected A', () => {
  const {
    previous,
    current
  } = supersessionFixtures();

  const mixed = {
    ...current,
    raw: {
      ...current.raw,
      runLog: previous.raw.runLog
    },
    runLog: previous.runLog
  };

  return rejectsWithReason(
    previous,
    [
      {
        artifact: mixed
      }
    ],
    'run-log-invalid',
    {
      getCurrentMainArtifact: async () => current
    }
  );
});

test('invalid current-main data cannot prove supersession', () => {
  const previous = shiftedArtifact(
    expected,
    -1
  );

  const current = expected;

  const invalid = {
    prices: current.prices,
    history: current.history,
    minimumHistory: current.minimumHistory,
    runLog: {
      ...current.runLog,
      untrusted: true
    }
  };

  return rejectsWithReason(
    previous,
    [
      {
        artifact: current
      }
    ],
    'current-main-invalid',
    {
      getCurrentMainArtifact: async () => invalid
    }
  );
});

test('supersession fixtures never synthesize a future deployment', () => {
  const {
    previous,
    current
  } = supersessionFixtures();

  assert.ok(
    Date.parse(previous.prices.generatedAt)
      < Date.parse(current.prices.generatedAt)
  );

  assert.equal(
    current.prices.generatedAt,
    expected.prices.generatedAt
  );

  assert.equal(
    current.prices.run.finishedAtUtc,
    expected.prices.run.finishedAtUtc
  );

  assert.equal(
    current.runLog.updatedAtUtc,
    expected.runLog.updatedAtUtc
  );
});

test('uses cache-bypassed diagnostic reads but requires ordinary canonical acceptance requests', async (t) => {
  const old = shiftedArtifact(expected, -1);
  const server = await startSequenceServer([{ artifact: old }, { artifact: expected }]);
  t.after(() => server.close());
  await verifyProductionDeployment(expected, fastOptions(server));
  assert.equal(server.observedRequests.length, 15);
  const diagnosticRequests = server.observedRequests.filter(({ diagnostic }) => diagnostic);
  const acceptanceRequests = server.observedRequests.filter(({ diagnostic }) => !diagnostic);
  assert.equal(diagnosticRequests.length, 10);
  assert.equal(acceptanceRequests.length, 5);
  for (const request of diagnosticRequests) {
    assert.equal(request.cacheControl, 'no-cache');
    assert.equal(request.pragma, 'no-cache');
    assert.match(request.url, new RegExp(`\\?verify=test-run-${request.attempt}$`));
  }
  for (const request of acceptanceRequests) {
    assert.equal(request.cacheControl, undefined);
    assert.equal(request.pragma, undefined);
    assert.doesNotMatch(request.url, /[?&]verify=/);
  }
  assert.deepEqual(new Set(server.observedRequests.map(({ resource }) => resource)), new Set(['prices', 'history', 'runLog', 'minimumHistory', 'index']));
});

test('does not accept cache-bypassed diagnostics when ordinary canonical user URLs are broken', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    if (!parsedUrl.search.includes('verify=')) {
      return new Response('unavailable', { status: 503, headers: { 'content-type': 'text/plain' } });
    }
    return globalThis.fetch(url, options);
  };
  await assert.rejects(
    () => verifyProductionDeployment(expected, fastOptions(server, { fetchImpl, maxWaitMs: 1 })),
    (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
      && /canonical:.*HTTP_503/.test(error.details.lastReason)
  );
});

test('retries HTTP failure, malformed prices, and stale static HTML without weakening the contract', async () => {
  for (const responses of [
    { prices: { status: 503, body: '{}' } },
    { prices: { body: '{bad' } },
    { index: { body: '<!doctype html><title>old</title>' } }
  ]) {
    const server = await startSequenceServer([{ artifact: expected, responses }, { artifact: expected }]);
    try {
      const result = await verifyProductionDeployment(expected, fastOptions(server));
      assert.equal(result.attempts, 2);
    } finally {
      await server.close();
    }
  }
});

test('retries a request timeout deterministically without weakening the contract', async () => {
  const server = await startSequenceServer([{ artifact: expected }, { artifact: expected }]);
  let injectedTimeouts = 0;
  const historyPath = new URL(server.urls.productionHistoryUrl).pathname;
  const fetchImpl = async (url, options = {}) => {
    const parsedUrl = new URL(url, 'http://localhost');
    const diagnostic = parsedUrl.search.includes('verify=');
    if (diagnostic && attemptFromUrl(url) === 0 && parsedUrl.pathname === historyPath) {
      injectedTimeouts += 1;
      throw new DOMException('Aborted', 'AbortError');
    }
    return globalThis.fetch(url, options);
  };
  try {
    const result = await verifyProductionDeployment(expected, fastOptions(server, { fetchImpl }));
    assert.equal(injectedTimeouts, 1);
    assert.equal(result.attempts, 2);
  } finally {
    await server.close();
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
    if (parsedUrl.search.includes('verify=') && attempt === 1 && parsedUrl.pathname === new URL(server.urls.productionPricesUrl).pathname) {
      return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
    }
    if (parsedUrl.search.includes('verify=') && attempt === 1) {
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
  assert.equal(pendingSignals.length, 4);
  for (const signal of pendingSignals) assert.equal(signal.aborted, true);
});

test('rejects non-cross-checked prices and mismatched finishedAt', async () => {
  for (const mutate of [
    (prices) => { prices.source.parser = 'document-order'; },
    (prices) => { prices.run.finishedAtUtc = prices.run.startedAtUtc; }
  ]) {
    const values = { prices: structuredClone(expected.prices), history: structuredClone(expected.history), runLog: structuredClone(expected.runLog), minimumHistory: expected.minimumHistory };
    mutate(values.prices);
    const raw = {
      prices: Buffer.from(JSON.stringify(values.prices)), history: Buffer.from(JSON.stringify(values.history)), runLog: Buffer.from(JSON.stringify(values.runLog)), minimumHistory: expected.raw.minimumHistory
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
  assert.equal(server.observedRequests.length, 20);
});

for (const [description, response] of [
  ['missing', { status: 404, body: '{}' }],
  ['malformed', { body: '{bad' }],
  ['invalid', { body: '{"schemaVersion":1}' }],
  ['oversized', { declaredLength: MAX_HISTORY_RESPONSE_BYTES + 1 }],
  ['wrong content type', { contentType: 'text/html' }],
  ['redirected', { redirect: '/other-minimum-history.json' }],
  ['stale', { body: committed.raw.minimumHistory }]
]) {
  test(`rejects ${description} minimum history without accepting the rest of the site`, () =>
    rejectsWithReason(expected, [{ artifact: expected, responses: { minimumHistory: response } }], response.status ? 'minimum-history:HTTP_404' : 'minimum-history-invalid'));
}

test('canonical minimum history must match even when cache-bypassed diagnostics succeed', async (t) => {
  const server = await startSequenceServer([{ artifact: expected }]);
  t.after(() => server.close());
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    if (u.pathname === '/minimum-history.json' && !u.searchParams.has('verify')) {
      return new Response(committed.raw.minimumHistory, { headers: { 'content-type': 'application/json' } });
    }
    return fetch(url, options);
  };
  await assert.rejects(() => verifyProductionDeployment(expected, fastOptions(server, { fetchImpl, maxWaitMs: 1 })),
    error => /canonical:minimum-history-invalid/.test(error.details?.lastReason));
});

test('newer production cannot be proven with different minimum-history bytes', () => {
  const previous = shiftedArtifact(expected, -1);
  const current = withRawWhitespace(expected, 'minimumHistory');
  return rejectsWithReason(previous, [{ artifact: expected }], 'minimum-history-not-deployed', {
    getCurrentMainArtifact: async () => current
  });
});

test('bounded production reader stops unknown-length or dishonest streams at the first excess chunk', async () => {
  for (const declared of [null, '1']) {
    let pulls = 0, cancelled = 0;
    const stream = new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(4)); },
      cancel() { cancelled++; }
    }, { highWaterMark: 0 });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (declared) headers.set('content-length', declared);
    await assert.rejects(readBoundedResponse({ ok: true, headers, body: stream }, {
      label: 'fixture', maxBytes: 8, contentTypePattern: /json/
    }), /size limit/);
    assert.equal(pulls, 3);
    assert.equal(cancelled, 1);
    assert.equal(stream.locked, false);
  }
});

test('bounded production reader cancels rejected headers without reading and preserves stream errors', async () => {
  for (const [status, mime, length, reason] of [[503, 'application/json', '1', /HTTP_503/],
    [200, 'text/html', '1', /content type/], [200, 'application/json', '9', /size limit/]]) {
    let pulls = 0, cancelled = 0;
    const body = new ReadableStream({ pull() { pulls++; }, cancel() { cancelled++; throw Error('cancel error'); } }, { highWaterMark: 0 });
    await assert.rejects(readBoundedResponse({ ok: status === 200, status,
      headers: new Headers({ 'content-type': mime, 'content-length': length }), body },
      { label: 'fixture', maxBytes: 8, contentTypePattern: /json/ }), reason);
    assert.equal(pulls, 0);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  }
  const body = new ReadableStream({ pull(controller) { controller.error(Error('broken stream')); } }, { highWaterMark: 0 });
  await assert.rejects(readBoundedResponse(new Response(body, { headers: { 'content-type': 'application/json' } }),
    { label: 'fixture', maxBytes: 8, contentTypePattern: /json/ }), /broken stream/);
  assert.equal(body.locked, false);
});

test('bounded production reader preserves split UTF-8 and aborts a stalled body', async () => {
  const bytes = new TextEncoder().encode('中文');
  const parts = [bytes.slice(0, 1), bytes.slice(1)];
  const body = new ReadableStream({ pull(controller) { if (parts.length) controller.enqueue(parts.shift()); else controller.close(); } });
  assert.deepEqual(await readBoundedResponse(new Response(body, { headers: { 'content-type': 'text/html' } }),
    { label: 'fixture', maxBytes: bytes.length, contentTypePattern: /html/ }), Buffer.from(bytes));
  assert.equal(body.locked, false);
  const controller = new AbortController();
  let cancelled = 0;
  const stalled = new ReadableStream({ pull() {}, cancel() { cancelled++; } }, { highWaterMark: 0 });
  const pending = readBoundedResponse(new Response(stalled, { headers: { 'content-type': 'text/html' } }),
    { label: 'fixture', maxBytes: 8, contentTypePattern: /html/, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.equal(stalled.locked, false);
});

test('CLI refreshes main A to B and pins data/assets to the same exact revision', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40);
  let remote = a, fetched = null, fetches = 0;
  const shown = [];
  const runGit = async (_command, args) => {
    if (args[1] === '--is-shallow-repository') return { stdout: 'false' };
    if (args[0] === 'fetch') { fetched = remote; fetches++; return { stdout: '' }; }
    if (args[0] === 'rev-parse') return { stdout: fetched + '\n' };
    if (args[0] === 'merge-base') return { stdout: '' };
    assert.equal(args[0], 'show');
    const [sha, file] = args[1].split(':');
    shown.push({ sha, file });
    const relative = file.replace('tools/icloud_price_comparison/', '');
    let content = await readFile(new URL('../' + relative, import.meta.url), 'utf8');
    if (sha === b && relative === 'data/history.json') content += '\n';
    return { stdout: content };
  };
  await runCli(['--expected-data-dir', dataDirectory.pathname,
    '--current-main-data-dir', '/not-used-frozen-startup-directory'], {
    runGit,
    verify: async (_expected, options) => {
      const first = await options.getCurrentMainArtifact();
      remote = b;
      const count = shown.length;
      await options.getCurrentMainStaticAssets();
      assert.ok(shown.slice(count).every(row => row.sha === a), 'assets remain bound to data A even if remote changes');
      await assert.rejects(options.confirmCurrentMain(), /Main advanced/);
      const second = await options.getCurrentMainArtifact();
      assert.notEqual(first.hashes.history, second.hashes.history);
      const nextCount = shown.length;
      await options.getCurrentMainStaticAssets();
      assert.ok(shown.slice(nextCount).every(row => row.sha === b));
      await options.confirmCurrentMain();
      return { status: 'superseded' };
    }
  });
  assert.equal(fetches, 4);
});

test('supersession retries if final main proof advances and never silently accepts a stale proof', async t => {
  const { previous, current } = supersessionFixtures();
  const server = await startSequenceServer([{ artifact: current }]);
  t.after(() => server.close());
  let proofs = 0;
  const result = await verifyProductionDeployment(previous, fastOptions(server, {
    getCurrentMainArtifact: async () => current,
    confirmCurrentMain: async () => { if (++proofs === 1) { const error = Error('main advanced'); error.reason = 'current-main-advanced'; throw error; } }
  }));
  assert.equal(result.status, 'superseded');
  assert.equal(result.attempts, 2);
  assert.equal(proofs, 2);
});

test('live main proof fails closed on fetch errors, malformed SHA or non-descendant main', async () => {
  for (const failure of ['fetch', 'rev-parse', 'merge-base']) {
    const calls = [];
    const reader = createCurrentMainReader({ runGit: async (_command, args) => {
      calls.push(args);
      if (args[1] === '--is-shallow-repository') return { stdout: 'false' };
      if (args[0] === failure) {
        if (failure === 'rev-parse') return { stdout: 'not-a-commit' };
        throw Error(failure + ' unavailable');
      }
      if (args[0] === 'rev-parse') return { stdout: 'b'.repeat(40) };
      return { stdout: '' };
    } });
    await assert.rejects(reader.getCurrentMainArtifact(), /unavailable|Invalid refreshed/);
    await assert.rejects(reader.getCurrentMainStaticAssets(), /must be read first/);
    assert.equal(calls.some(args => args[0] === 'show'), false, 'no frozen artifact fallback');
  }
});

test('live main reader repairs real depth-one fetch boundaries before proving A to B ancestry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'icloud-main-shallow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), checkout = join(root, 'checkout');
  const exec = promisify(execFile);
  const git = (cwd, args) => exec('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  await mkdir(source);
  await git(source, ['init', '--initial-branch=main']);
  await git(source, ['config', 'user.name', 'Verifier Test']);
  await git(source, ['config', 'user.email', 'verifier@example.invalid']);
  const fixtureData = join(source, 'tools/icloud_price_comparison/data');
  await mkdir(fixtureData, { recursive: true });
  for (const name of ['prices.json', 'history.json', 'run-log.json', 'minimum-history.json']) {
    await writeFile(join(fixtureData, name), await readFile(new URL(name, dataDirectory)));
  }
  await writeFile(join(source, 'revision'), 'A');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'A']);
  const a = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(root, ['clone', '--depth=1', pathToFileURL(source).href, checkout]);
  await writeFile(join(source, 'revision'), 'B');
  await git(source, ['add', '.']);
  await git(source, ['commit', '-m', 'B']);
  const b = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  // Reproduce both workflow operations: depth-one checkout of A, then
  // depth-one fetch of B without changing HEAD.
  await git(checkout, ['fetch', 'origin', 'main', '--depth=1']);
  assert.equal((await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim(), a);
  await assert.rejects(git(checkout, ['merge-base', '--is-ancestor', 'HEAD', b]),
    error => error.code === 1);
  const calls = [];
  const reader = createCurrentMainReader({ runGit: async (command, args, options) => {
    calls.push(args);
    return exec(command, args, { ...options, cwd: checkout });
  } });
  const artifact = await reader.getCurrentMainArtifact();
  assert.equal(artifact.hashes.prices, (await loadVerificationArtifact(dataDirectory)).hashes.prices);
  assert.ok(calls.some(args => args[0] === 'fetch' && args.includes('--unshallow')));
  assert.ok(calls.filter(args => args[0] === 'show').every(args => args[1].startsWith(b + ':')));
  assert.equal((await git(checkout, ['rev-parse', '--is-shallow-repository'])).stdout.trim(), 'false');
  await git(checkout, ['merge-base', '--is-ancestor', 'HEAD', b]);
  await reader.confirmCurrentMain();
});
