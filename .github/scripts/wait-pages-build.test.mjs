import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { githubJson, waitForPages } from './wait-pages-build.mjs';
const target = 'a'.repeat(40), other = 'b'.repeat(40);
const build = (status, commit = target, error = null) => ({ commit, status, error });
function harness(lists, comparison = 'behind') {
  let n = 0, time = 0, compares = 0;
  return { options: { repository: 'fixture/repo', targetSha: target, maxPolls: 3, intervalMs: 5,
    now: () => time, sleep: async ms => { time += ms; }, log: () => {},
    request: async url => url.includes('/compare/') ? (compares++, { status: comparison }) : lists[Math.min(n++, lists.length - 1)] },
    counts: () => ({ polls: n, compares }) };
}
test('hidden exact target is found behind unrelated latest entry', async () => {
  const h = harness([[build('built', other), build('built')]]);
  assert.deepEqual(await waitForPages(h.options), { built_sha: target, build_relation: 'identical' });
});
test('verified successor accepted; unrelated and malformed comparison rejected', async () => {
  const h = harness([[build('built', other)]], 'ahead');
  assert.equal((await waitForPages(h.options)).build_relation, 'successor');
  for (const relation of ['behind', 'diverged', 'identical']) {
    const h = harness([[build('built', other)]], relation);
    await assert.rejects(waitForPages(h.options), /TIMEOUT/);
    assert.equal(h.counts().compares, 1);
  }
  await assert.rejects(waitForPages(harness([[build('built', other)]], 'invalid').options), /INVALID_COMPARISON/);
});
test('newest pending cannot use an older success; newest error fails immediately', async () => {
  const pending = harness([[build('building'), build('built')]]);
  await assert.rejects(waitForPages(pending.options), /TIMEOUT/);
  assert.equal(pending.counts().polls, 3);
  for (const b of [build('errored'), build('built', target, { message: 'failure' })]) {
    const h = harness([[b, build('built')]]);
    await assert.rejects(waitForPages(h.options), /BUILD_FAILED/);
    assert.equal(h.counts().polls, 1);
  }
});
test('empty history, malformed schema, unknown state and wrong target fail closed', async () => {
  await assert.rejects(waitForPages(harness([[]]).options), /TIMEOUT/);
  for (const list of [{}, [null], [build('built', 'bad')], [build('unknown')]]) {
    await assert.rejects(waitForPages(harness([list]).options), /INVALID/);
  }
  await assert.rejects(waitForPages({ ...harness([[build('built')]]).options, targetSha: 'bad' }), /INVALID_TARGET/);
});
test('pending transitions pass and time/poll budgets are finite', async () => {
  assert.equal((await waitForPages(harness([[build('queued')], [build('built')]]).options)).built_sha, target);
  const h = harness([[build('building')]]);
  await assert.rejects(waitForPages({ ...h.options, maxWaitMs: 4 }), /TIMEOUT/);
  assert.equal(h.counts().polls, 1);
});
const response = (status, data = {}, headers = {}) => ({
  status, ok: status >= 200 && status < 300, headers: new Headers(headers),
  body: { cancel: async () => {} }, json: async () => data
});
function api(sequence, extra = {}) {
  let calls = 0, time = 0; const delays = [];
  const options = { token: 'test', now: () => time, deadline: 100000,
    sleep: async ms => { time += ms; delays.push(ms); },
    fetchImpl: async (_url, opts) => {
      assert.equal(opts.method, 'GET'); assert.equal(opts.redirect, 'error');
      const value = sequence[Math.min(calls++, sequence.length - 1)];
      if (value instanceof Error) throw value;
      return value;
    }, ...extra };
  return { run: () => githubJson('https://api.github.com/repos/fixture/repo/pages/builds', options),
    counts: () => ({ calls, delays }) };
}
test('network, timeout, 429 and transient 5xx recover with bounded backoff', async () => {
  for (const error of [new TypeError('network'), Object.assign(new Error('timeout'), {name:'TimeoutError'}),
    response(429), response(500), response(502), response(503), response(504),
    response(403, {}, {'x-ratelimit-remaining':'0'})]) {
    const h = api([error, response(200, {good:true})]);
    assert.deepEqual(await h.run(), {good:true}); assert.equal(h.counts().calls, 2);
  }
});
test('body transport timeout retries; malformed JSON does not', async () => {
  const broken = response(200); broken.body.cancel = async () => {throw new TypeError('errored stream');}; broken.json = async () => {throw new TypeError('terminated');};
  const h = api([broken, response(200, [])]); assert.deepEqual(await h.run(), []);
  const invalid = response(200); invalid.json = async () => {throw new SyntaxError('bad json');};
  const bad = api([invalid]); await assert.rejects(bad.run(), SyntaxError); assert.equal(bad.counts().calls, 1);
});
test('permanent status and exhausted transient failures never succeed', async () => {
  for (const status of [400, 401, 403, 404, 422, 501]) {
    const h = api([response(status)]); await assert.rejects(h.run(), /HTTP_/); assert.equal(h.counts().calls, 1);
  }
  const h = api([response(503)]);
  await assert.rejects(h.run(), /RETRIES_EXHAUSTED/);
  assert.deepEqual(h.counts(), { calls: 3, delays: [1000, 2000] });
});
test('Retry-After is honored but cannot exceed local or overall budget', async () => {
  const h = api([response(429, {}, {'retry-after':'3'}), response(200)]);
  await h.run(); assert.deepEqual(h.counts().delays, [3000]);
  for (const options of [{}, {deadline:2000}]) {
    const h = api([response(429, {}, {'retry-after':'61'})], options);
    await assert.rejects(h.run(), /RETRY_BUDGET/); assert.equal(h.counts().calls, 1);
  }
});
test('transient compare requests retry, permanent comparison failures propagate', async () => {
  let calls = 0;
  const fetchImpl = async url => {
    if (url.includes('/pages/builds')) return response(200, [build('built', other)]);
    return ++calls === 1 ? response(503) : response(200, {status:'ahead'});
  };
  const h = harness([[]]);
  const result = await waitForPages({...h.options,
    request: (url, options) => githubJson(url, {...options, fetchImpl}) });
  assert.equal(result.build_relation, 'successor'); assert.equal(calls, 2);
  await assert.rejects(waitForPages({...h.options,
    request: (url, options) => githubJson(url, {...options, fetchImpl: async u =>
      u.includes('/pages/builds') ? response(200, [build('built', other)]) : response(403)})}), /HTTP_403/);
});
test('all three callers use shared waiter and both CI path filters test shared changes', async () => {
  for (const file of ['update-icloud-prices.yml', 'update-chatgpt-prices.yml', 'validate-chatgpt-prices.yml']) {
    const text = await readFile(new URL('../workflows/' + file, import.meta.url), 'utf8');
    assert.match(text, /node \.github\/scripts\/wait-pages-build\.mjs/);
    assert.doesNotMatch(text, /pages\/builds\/latest/);
  }
  for (const file of ['validate-icloud-price-comparison.yml', 'validate-chatgpt-prices.yml']) {
    const text = await readFile(new URL('../workflows/' + file, import.meta.url), 'utf8');
    assert.match(text, /wait-pages-build\*/);
    assert.match(text, /node --test \.github\/scripts\/wait-pages-build\.test\.mjs/);
  }
});
