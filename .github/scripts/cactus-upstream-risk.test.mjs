import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessUpstreamComparison,
  inspectPublicUpstream
} from './cactus-upstream-risk.mjs';
import {
  INITIAL_REVIEW_CHECKPOINT,
  UPSTREAM_REPOSITORY
} from './monitor-cactus-upstream.mjs';

const BASE = INITIAL_REVIEW_CHECKPOINT;
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const upstreamApi = 'https://api.github.com/repos/' + UPSTREAM_REPOSITORY;

const file = (filename, overrides = {}) => ({
  filename, status: 'modified', additions: 4, deletions: 2, changes: 6,
  ...overrides
});

function comparison(files = [file('README.md')], overrides = {}) {
  return {
    status: 'ahead',
    ahead_by: 1,
    behind_by: 0,
    total_commits: 1,
    base_commit: { sha: BASE },
    merge_base_commit: { sha: BASE },
    commits: [{ sha: HEAD }],
    files,
    ...overrides
  };
}

function classify(files, overrides = {}) {
  return assessUpstreamComparison({
    baselineSha: BASE,
    remoteSha: HEAD,
    comparison: comparison(files, overrides)
  });
}

test('current upstream requires no private access or GitHub comparison', () => {
  const result = assessUpstreamComparison({ baselineSha: BASE, remoteSha: BASE });
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(result.requiresPrivateValidation, false);
});

test('documentation-only change is a candidate, NOT permission to auto merge', () => {
  const result = classify([file('README.md')]);
  assert.equal(result.status, 'documentation-candidate');
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(result.requiresPrivateValidation, true);
  assert.deepEqual(result.changedPaths, ['README.md']);
});

test('extra documentation locale remains only a candidate', () => {
  const result = classify([file('README_zh.md')]);
  assert.equal(result.status, 'documentation-candidate');
  assert.equal(result.autoMergeAllowed, false);
});

test('template change is never approved', () => {
  const result = classify([file('layout/_partial/head.ejs')]);
  assert.equal(result.status, 'manual-review-required');
  assert.equal(result.autoMergeAllowed, false);
});

test('styles, JavaScript, translated runtime strings and dependencies require private review', () => {
  for (const path of [
    'source/css/style.styl',
    'source/js/main.js',
    'languages/zh-CN.yml',
    'package.json',
    'scripts/cdn.js',
    'LICENSE',
    '.github/workflows/deploy.yml'
  ]) {
    assert.equal(classify([file(path)]).status, 'manual-review-required', path);
  }
});

test('renamed, added, removed, and excessive-size documentation changes cannot be candidates', () => {
  const cases = [
    file('README.md', { status: 'renamed', previous_filename: 'README-old.md' }),
    file('README.md', { status: 'added' }),
    file('README.md', { status: 'removed' }),
    file('README.md', { changes: 201 }),
    file('README.md', { changes: null })
  ];
  for (const item of cases) {
    assert.equal(classify([item]).status, 'manual-review-required', JSON.stringify(item));
  }
});

test('mixed documentation and runtime changes cannot be candidates', () => {
  const result = classify([file('README.md'), file('source/js/main.js')]);
  assert.equal(result.status, 'manual-review-required');
  assert.deepEqual(result.changedPaths, ['README.md', 'source/js/main.js']);
});

test('unexpected ancestor, divergence, or rollback fails closed', () => {
  for (const patch of [
    { status: 'diverged' },
    { status: 'behind' },
    { merge_base_commit: { sha: OTHER } },
    { base_commit: { sha: OTHER } },
    { behind_by: 1 },
    { ahead_by: 0 }
  ]) {
    assert.equal(classify([file('README.md')], patch).status, 'blocked');
  }
});

test('incomplete commit evidence is blocked', () => {
  for (const patch of [
    { total_commits: 251 },
    { total_commits: 2, commits: [{ sha: HEAD }] },
    { commits: [{ sha: OTHER }] },
    { commits: null },
    { total_commits: null }
  ]) {
    assert.equal(classify([file('README.md')], patch).status, 'blocked');
  }
});

test('ambiguous or 300-file comparison is blocked rather than treated as complete', () => {
  assert.equal(classify([]).status, 'blocked');
  const tooMany = Array.from({ length: 300 }, (_, i) => file('README_' + i + '.md'));
  assert.equal(classify(tooMany).status, 'blocked');
  assert.equal(classify([file('README.md'), file('README.md')]).status, 'blocked');
});

test('invalid or traversal paths are blocked', () => {
  for (const path of ['../README.md', '/README.md', './README.md', 'foo/../README.md', 'bad name.md']) {
    assert.equal(classify([file(path)]).status, 'blocked', path);
  }
});

test('missing comparison or invalid SHAs are not silently accepted', () => {
  assert.equal(assessUpstreamComparison({
    baselineSha: BASE, remoteSha: HEAD
  }).status, 'blocked');
  assert.throws(() => assessUpstreamComparison({
    baselineSha: 'bad', remoteSha: HEAD
  }), /Invalid/);
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('live preflight only reads public upstream and never writes to any repository', async () => {
  const requests = [];
  const fetcher = async (url, args) => {
    requests.push({ url, args });
    if (url === upstreamApi + '/commits/master') {
      return response({ sha: HEAD });
    }
    if (url === upstreamApi + '/compare/' + BASE + '...' + HEAD) {
      return response(comparison([file('source/js/main.js')]));
    }
    throw Error('Unexpected endpoint: ' + url);
  };
  const logs = [];
  const result = await inspectPublicUpstream({
    fetcher, token: 'test-not-a-real-secret',
    summaryFile: null, log: item => logs.push(item)
  });
  assert.equal(result.status, 'manual-review-required');
  assert.equal(result.autoMergeAllowed, false);
  assert.equal(logs.length, 1);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item =>
    item.url.startsWith(upstreamApi + '/') &&
    item.args.method === undefined &&
    item.args.body === undefined
  ));
});

test('unchanged live upstream avoids unnecessary compare API call', async () => {
  const requests = [];
  const fetcher = async url => {
    requests.push(url);
    return response({ sha: BASE });
  };
  const result = await inspectPublicUpstream({
    fetcher, summaryFile: null, log: () => {}
  });
  assert.equal(result.status, 'up-to-date');
  assert.deepEqual(requests, [upstreamApi + '/commits/master']);
});

test('an API failure cannot be reported as a safe comparison', async () => {
  const fetcher = async () => response({ message: 'rate-limited' }, 403);
  await assert.rejects(() =>
    inspectPublicUpstream({ fetcher, summaryFile: null, log: () => {} }),
    /HTTP 403/
  );
});


test('a verified private baseline may advance without retaining obsolete public checkpoint', async () => {
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    return response({ sha: HEAD });
  };
  const result = await inspectPublicUpstream({
    baselineSha: HEAD, fetcher, summaryFile: null, log: () => {}
  });
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.baselineSha, HEAD);
  assert.deepEqual(calls, [upstreamApi + '/commits/master']);
});
