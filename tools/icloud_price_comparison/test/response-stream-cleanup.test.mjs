import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
const maximumBytes = 8 * 1024 * 1024;

function functionSource(name) {
  const match = source.match(new RegExp('(?:async )?function ' + name + '\\([^]*?\\n\\}'));
  assert.ok(match, 'must exercise the production function ' + name);
  return match[0];
}

function readerWithLimits(limit = maximumBytes) {
  return runInNewContext('(' + functionSource('readBoundedJsonResponse') + ')', {
    MAX_RESPONSE_BYTES: { 'history.json': limit, 'minimum-history.json': limit },
    TextDecoder, JSON
  });
}

test('declared oversized history cancels its untouched stream immediately', async () => {
  for (const name of ['history.json', 'minimum-history.json']) {
    let cancelled = 0;
    let pulls = 0;
    const stream = new ReadableStream({
      pull() { pulls += 1; },
      cancel() { cancelled += 1; }
    }, { highWaterMark: 0 });
    const response = { headers: new Headers({ 'content-length': String(maximumBytes + 1) }), body: stream };
    await assert.rejects(readerWithLimits()(response, name), /超过允许大小/);
    assert.equal(cancelled, 1, name + ' must terminate the rejected body');
    assert.equal(pulls, 0, 'declared oversized bodies must not be consumed');
    assert.equal(stream.locked, false);
  }
});

test('declared-size cancellation errors preserve the original size rejection', async () => {
  let cancelled = 0;
  const response = {
    headers: new Headers({ 'content-length': String(maximumBytes + 1) }),
    body: {
      async cancel() { cancelled += 1; throw new Error('fixture cancellation failure'); },
      getReader() { throw new Error('oversize branch must not acquire a reader'); }
    }
  };
  await assert.rejects(readerWithLimits()(response, 'history.json'), /history\.json 超过允许大小/);
  assert.equal(cancelled, 1);
});

test('small valid UTF-8 responses release their completed reader lock', async () => {
  const bytes = new TextEncoder().encode('{"name":"中文"}');
  // Split inside the first Chinese UTF-8 sequence, not just at a JS character.
  const split = bytes.indexOf(0xe4) + 1;
  let pulls = 0;
  const parts = [bytes.slice(0, split), bytes.slice(split)];
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (parts.length) controller.enqueue(parts.shift());
      else controller.close();
    }
  }, { highWaterMark: 0 });
  const result = await readerWithLimits(bytes.length)({ headers: new Headers(), body: stream }, 'history.json');
  assert.equal(result.name, '中文');
  assert.equal(pulls, 3);
  assert.equal(stream.locked, false, 'successful reads must release their lock too');
});

test('streamed overflow cancels at the byte boundary and releases its lock', async () => {
  let pulls = 0;
  let cancelled = 0;
  const stream = new ReadableStream({
    pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(4).fill(32)); },
    cancel() { cancelled += 1; }
  }, { highWaterMark: 0 });
  await assert.rejects(readerWithLimits(8)({ headers: new Headers(), body: stream }, 'history.json'), /超过允许大小/);
  assert.equal(pulls, 3, 'only the first over-budget block may be read');
  assert.equal(cancelled, 1);
  assert.equal(stream.locked, false);
});

test('an interrupted body preserves its error and releases its reader lock', async () => {
  const stream = new ReadableStream({ pull(controller) { controller.error(new Error('fixture interrupted body')); } }, { highWaterMark: 0 });
  await assert.rejects(readerWithLimits(8)({ headers: new Headers(), body: stream }, 'history.json'), /fixture interrupted body/);
  assert.equal(stream.locked, false);
});

function requestContext(response) {
  let signal;
  let cleared = false;
  return {
    context: {
      AbortController,
      REQUEST_TIMEOUT_MS: 8000,
      setTimeout: () => 17,
      clearTimeout: (id) => { assert.equal(id, 17); cleared = true; },
      fetch: async (_url, options) => { signal = options.signal; return response; },
      readBoundedJsonResponse: readerWithLimits(),
      validatePayload: (_name, value) => value,
      validateMinimumHistoryPayload: value => value,
      MAX_PRICE_FUTURE_SKEW_MS: 300000,
      minimumHistoryUi: { data: null, promise: null, status: 'idle' },
      renderMinimumHistory: () => {},
      renderMinimumHistoryStatus: () => {},
      URL
    },
    assertClosed() {
      assert.equal(cleared, true, 'request timer must be cleared');
      assert.ok(signal, 'request must receive its abort signal');
      assert.equal(signal.aborted, true, 'early status rejection must abort the unread transport');
    }
  };
}

test('country-history HTTP rejection aborts the unread request before returning', async () => {
  const harness = requestContext({ ok: false, status: 503, statusText: 'Fixture unavailable' });
  const fetchJson = runInNewContext('(' + functionSource('fetchJson') + ')', harness.context);
  await assert.rejects(fetchJson('history.json'), /503 Fixture unavailable/);
  harness.assertClosed();
});

test('minimum-history HTTP rejection aborts the unread request before returning', async () => {
  const harness = requestContext({ ok: false, status: 503, headers: new Headers() });
  // Only module URL resolution is supplied by this isolated unit harness.
  // The production request/finally body is otherwise exercised unchanged.
  const body = functionSource('loadMinimumHistory').replace('import.meta.url', JSON.stringify('https://fixture.invalid/script.js'));
  const load = runInNewContext('(' + body + ')', harness.context);
  await load();
  assert.equal(harness.context.minimumHistoryUi.status, 'error');
  harness.assertClosed();
});
