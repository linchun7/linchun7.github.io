import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIVATE_BASELINE_URL,
  extractReviewedCactusSha,
  readPrivateBaseline
} from './cactus-private-baseline.mjs';
import {
  INITIAL_REVIEW_CHECKPOINT,
  UPSTREAM_REPOSITORY
} from './monitor-cactus-upstream.mjs';

const SHA = INITIAL_REVIEW_CHECKPOINT;
function metadata(options = {}) {
  const pkg = {
    name: 'private-theme-metadata-test-fixture',
    upstream: {
      repository: 'https://github.com/' + UPSTREAM_REPOSITORY,
      baseline: SHA
    },
    ...options
  };
  const raw = Buffer.from(JSON.stringify(pkg), 'utf8');
  return {
    type: 'file',
    path: 'themes/cactus/package.json',
    size: raw.length,
    encoding: 'base64',
    content: raw.toString('base64')
  };
}
function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('reads exactly the reviewed public upstream SHA from a private file payload', () => {
  assert.equal(extractReviewedCactusSha(metadata()), SHA);
});

test('rejects unexpected upstream identity and missing reviewed baseline', () => {
  assert.throws(() => extractReviewedCactusSha(metadata({
    upstream: { repository: 'https://github.com/attacker/theme', baseline: SHA }
  })), /Unrecognized/);
  assert.throws(() => extractReviewedCactusSha(metadata({
    upstream: { repository: 'https://github.com/' + UPSTREAM_REPOSITORY, baseline: '' }
  })), /Unrecognized/);
});

test('rejects non-file, wrong path, unusual encoding and oversized files', () => {
  for (const patch of [
    { type: 'symlink' },
    { path: 'other-file' },
    { encoding: 'utf-8' },
    { size: 16_385 }
  ]) {
    assert.throws(() => extractReviewedCactusSha({ ...metadata(), ...patch }));
  }
});

test('rejects altered or non-canonical base64 content', () => {
  const d = metadata();
  assert.throws(() => extractReviewedCactusSha({ ...d, content: d.content + '====' }));
  assert.throws(() => extractReviewedCactusSha({ ...d, size: d.size + 1 }));
});

test('a missing token blocks synchronization; never falls back to static SHA', async () => {
  let calls = 0;
  await assert.rejects(() => readPrivateBaseline({
    token: '',
    fetcher: async () => { calls++; return ok(metadata()); },
    writeOutput: null, log: () => {}
  }), /Private read token/);
  assert.equal(calls, 0);
});

test('the client only reads the exact private package.json and never logs its contents or token', async () => {
  const calls = [], messages = [];
  const secret = 'fake-sensitive-testing-token';
  const sha = await readPrivateBaseline({
    token: secret, writeOutput: null,
    log: value => messages.push(value),
    fetcher: async (url, args) => {
      calls.push({ url, args });
      return ok(metadata());
    }
  });
  assert.equal(sha, SHA);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, PRIVATE_BASELINE_URL);
  assert.equal(calls[0].args.method, 'GET');
  assert.equal(calls[0].args.body, undefined);
  assert.equal(calls[0].args.headers.Authorization, 'Bearer ' + secret);
  assert.ok(messages.every(s => !s.includes(secret) && !s.includes('private-theme-metadata-test-fixture')));
});

test('denied private access is a failure, never a stale-baseline success', async () => {
  await assert.rejects(() => readPrivateBaseline({
    token: 'fake-token', writeOutput: null, log: () => {},
    fetcher: async () => ({ ok: false, status: 403 })
  }), /HTTP 403/);
});
