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


test('a verified private reviewed checkpoint overrides the initial static checkpoint', async () => {
  const mock = mockGithub({ sha: nextSha });
  const result = await runMonitor(options(mock, { baselineSha: nextSha }));
  assert.equal(result.status, 'up-to-date');
  assert.equal(writes(mock).length, 0);
});

test('private reviewed baseline is reflected in public issue without private code', async () => {
  const mock = mockGithub({ sha: nextSha });
  const result = await runMonitor(options(mock, { baselineSha: newerSha }));
  assert.equal(result.status, 'update-available');
  const issueBody = writes(mock)[0].payload.body;
  assert.ok(issueBody.includes('/compare/' + newerSha + '...' + nextSha));
  assert.ok(!issueBody.includes('/compare/' + INITIAL_REVIEW_CHECKPOINT + '...' + nextSha));
});

test('malformed private baseline fails closed before any upstream or issue requests', async () => {
  const mock = mockGithub({ sha: nextSha });
  await assert.rejects(
    () => runMonitor(options(mock, { baselineSha: 'not-a-sha' })),
    /Invalid reviewed upstream baseline/
  );
  assert.equal(mock.calls.length, 0);
});
