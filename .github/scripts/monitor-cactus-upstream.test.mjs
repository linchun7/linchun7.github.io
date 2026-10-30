import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_REVIEW_CHECKPOINT,
  PUBLIC_REPOSITORY,
  UPSTREAM_REPOSITORY,
  ISSUE_TITLE,
  ISSUE_MARKER,
  extractTrackedSha,
  isManagedIssue,
  renderIssueBody,
  runMonitor
} from './monitor-cactus-upstream.mjs';

const nextSha = 'a'.repeat(40);
const newerSha = 'b'.repeat(40);
const date = '2026-10-30T01:00:00Z';
const issueRoot = 'https://api.github.com/repos/' + PUBLIC_REPOSITORY + '/issues';

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function managedIssue({ sha = nextSha, state = 'open', number = 42 } = {}) {
  return {
    number,
    title: ISSUE_TITLE,
    body: renderIssueBody(sha, date),
    state,
    user: { login: 'github-actions[bot]' }
  };
}

function mockGithub({ sha = INITIAL_REVIEW_CHECKPOINT, issues = [], failIssues = false } = {}) {
  const calls = [];
  async function fetcher(url, options = {}) {
    const method = options.method || 'GET';
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, method, payload });
    if (url === 'https://api.github.com/repos/' + UPSTREAM_REPOSITORY + '/commits/master') {
      return response({ sha, commit: { committer: { date } } });
    }
    if (url.startsWith(issueRoot + '?')) {
      return failIssues
        ? response({ message: 'Test access denied' }, 403)
        : response(issues);
    }
    if (url === issueRoot && method === 'POST') return response({ number: 217 }, 201);
    if (url.startsWith(issueRoot + '/') && method === 'PATCH') {
      return response({ number: Number(url.split('/').at(-1)) });
    }
    return response({ message: 'Unexpected test endpoint: ' + url }, 404);
  }
  return { fetcher, calls };
}

function options(mock, extra = {}) {
  return {
    repository: PUBLIC_REPOSITORY,
    token: 'test-token-not-a-secret',
    fetcher: mock.fetcher,
    log: () => {},
    ...extra
  };
}

function writes(mock) {
  return mock.calls.filter((call) => call.method !== 'GET');
}

test('dry run fetches only the public upstream and never reads or writes issues', async () => {
  const mock = mockGithub();
  const result = await runMonitor(options(mock, { dryRun: true, token: undefined }));
  assert.equal(result.status, 'up-to-date');
  assert.equal(mock.calls.length, 1);
  assert.equal(writes(mock).length, 0);
});

test('same reviewed upstream SHA leaves no issue and performs no writes', async () => {
  const mock = mockGithub();
  const result = await runMonitor(options(mock));
  assert.equal(result.status, 'up-to-date');
  assert.equal(writes(mock).length, 0);
});

test('new upstream commit creates one public issue and does not expose private repo paths', async () => {
  const mock = mockGithub({ sha: nextSha });
  const result = await runMonitor(options(mock));
  assert.equal(result.createdIssue, 217);
  const written = writes(mock);
  assert.equal(written.length, 1);
  assert.equal(written[0].method, 'POST');
  assert.equal(written[0].url, issueRoot);
  assert.equal(written[0].payload.title, ISSUE_TITLE);
  assert.match(written[0].payload.body, /cactus-upstream-public-monitor/);
  assert.ok(written[0].payload.body.includes(INITIAL_REVIEW_CHECKPOINT));
  assert.ok(written[0].payload.body.includes(nextSha));
  assert.ok(!written[0].payload.body.includes('linchun.github.io'));
  assert.ok(mock.calls.every((call) => !call.url.includes('linchun7/linchun.github.io')));
});

test('repeat run for the same open issue is idempotent', async () => {
  const mock = mockGithub({ sha: nextSha, issues: [managedIssue()] });
  const result = await runMonitor(options(mock));
  assert.equal(result.status, 'unchanged');
  assert.equal(result.issue, 42);
  assert.equal(writes(mock).length, 0);
});

test('a later upstream commit updates the same issue rather than opening duplicates', async () => {
  const mock = mockGithub({ sha: newerSha, issues: [managedIssue()] });
  const result = await runMonitor(options(mock));
  assert.equal(result.updatedIssue, 42);
  assert.deepEqual(writes(mock).map((call) => call.method), ['PATCH']);
  assert.equal(writes(mock)[0].url, issueRoot + '/42');
  assert.equal(extractTrackedSha(writes(mock)[0].payload.body), newerSha);
});

test('return to the review checkpoint closes the managed open issue', async () => {
  const mock = mockGithub({ issues: [managedIssue()] });
  const result = await runMonitor(options(mock));
  assert.equal(result.closedIssue, 42);
  assert.deepEqual(writes(mock)[0].payload, {
    state: 'closed',
    state_reason: 'completed'
  });
});

test('already acknowledged commit is not reopened every week', async () => {
  const mock = mockGithub({ sha: nextSha, issues: [managedIssue({ state: 'closed' })] });
  const result = await runMonitor(options(mock));
  assert.equal(result.status, 'already-acknowledged');
  assert.equal(writes(mock).length, 0);
});

test('a genuinely newer upstream commit automatically reopens the managed issue', async () => {
  const mock = mockGithub({
    sha: newerSha,
    issues: [managedIssue({ state: 'closed' })]
  });
  const result = await runMonitor(options(mock));
  assert.equal(result.updatedIssue, 42);
  assert.equal(writes(mock).length, 1);
  assert.equal(writes(mock)[0].payload.state, 'open');
  assert.equal(extractTrackedSha(writes(mock)[0].payload.body), newerSha);
});

test('human issue with matching title cannot be edited as a managed bot issue', async () => {
  const humanIssue = { ...managedIssue(), user: { login: 'somebody-else' } };
  const mock = mockGithub({ sha: nextSha, issues: [humanIssue] });
  const result = await runMonitor(options(mock));
  assert.equal(isManagedIssue(humanIssue), false);
  assert.equal(result.createdIssue, 217);
  assert.equal(writes(mock)[0].method, 'POST');
});

test('missing token or unexpected repository fails closed before any GitHub calls', async () => {
  const mock = mockGithub({ sha: newerSha });
  await assert.rejects(() => runMonitor(options(mock, { token: '' })), /Missing GITHUB_TOKEN/);
  await assert.rejects(
    () => runMonitor(options(mock, { repository: 'linchun7/linchun.github.io' })),
    /Live monitoring may only write/
  );
  assert.equal(mock.calls.length, 0);
});

test('GitHub API failure is reported, not converted into a false success', async () => {
  const mock = mockGithub({ sha: nextSha, failIssues: true });
  await assert.rejects(() => runMonitor(options(mock)), /GitHub API 403/);
  assert.equal(writes(mock).length, 0);
});

test('marker and baseline are stable public-only values', () => {
  assert.match(INITIAL_REVIEW_CHECKPOINT, /^[0-9a-f]{40}$/);
  assert.equal(ISSUE_MARKER, '<!-- cactus-upstream-public-monitor:v1 -->');
  assert.ok(renderIssueBody(nextSha).includes('/compare/' + INITIAL_REVIEW_CHECKPOINT + '...' + nextSha));
});


test('managed-issue discovery filters the repository issue list by bot creator', async () => {
  const mock = mockGithub({ sha: nextSha, issues: [managedIssue()] });
  const result = await runMonitor(options(mock));
  assert.equal(result.status, 'unchanged');
  const listing = mock.calls.find(call => call.url.startsWith(issueRoot + '?'));
  assert.ok(listing, 'the bot issue search must run');
  assert.ok(listing.url.includes('creator=github-actions%5Bbot%5D'));
  assert.ok(listing.url.includes('state=all'));
  assert.equal(writes(mock).length, 0);
});

test('a human annotation in an open monitored issue is not overwritten for the same SHA', async () => {
  const issue = managedIssue();
  issue.body += '\n\nHuman review note: do not deploy automatically.';
  const mock = mockGithub({ sha: nextSha, issues: [issue] });
  const result = await runMonitor(options(mock));
  assert.equal(result.status, 'unchanged');
  assert.equal(writes(mock).length, 0, 'no PATCH may discard unchanged-head annotations');
});

test('a changed SHA updates the existing issue despite annotations', async () => {
  const issue = managedIssue();
  issue.body += '\n\nExisting note (prefer Issue comments for persistent notes).';
  const mock = mockGithub({ sha: newerSha, issues: [issue] });
  const result = await runMonitor(options(mock));
  assert.equal(result.updatedIssue, issue.number);
  assert.equal(writes(mock).length, 1);
  assert.equal(writes(mock)[0].method, 'PATCH');
  assert.equal(extractTrackedSha(writes(mock)[0].payload.body), newerSha);
});

test('unexpected managed-issue state fails closed without issue mutations', async () => {
  const mock = mockGithub({ sha: nextSha, issues: [managedIssue({ state: 'unknown' })] });
  await assert.rejects(() => runMonitor(options(mock)), /Unexpected state/);
  assert.equal(writes(mock).length, 0);
});

test('invalid managed-issue number fails closed without issue mutations', async () => {
  const mock = mockGithub({ sha: nextSha, issues: [managedIssue({ number: 0 })] });
  await assert.rejects(() => runMonitor(options(mock)), /no valid issue number/);
  assert.equal(writes(mock).length, 0);
});

test('bot-created issue on a later page is reused rather than duplicated', async () => {
  const prior = Array.from({ length: 100 }, (_, i) => ({
    number: i + 1000,
    state: 'closed',
    title: 'Unrelated bot issue #' + i,
    body: 'unrelated',
    user: { login: 'github-actions[bot]' }
  }));
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    if (url.endsWith('/commits/master')) {
      return response({ sha: nextSha, commit: { committer: { date } } });
    }
    if (/[?&]page=1(?:&|$)/.test(url)) return response(prior);
    if (/[?&]page=2(?:&|$)/.test(url)) return response([managedIssue()]);
    throw new Error('Unexpected test URL: ' + url);
  };
  const result = await runMonitor({
    repository: PUBLIC_REPOSITORY,
    token: 'mock-only',
    fetcher,
    log: () => {}
  });
  assert.equal(result.status, 'unchanged');
  assert.equal(result.issue, 42);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(x => x.method !== 'GET').length, 0);
});
