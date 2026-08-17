import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
  resolveActionTagCommit,
  validateChangedFiles,
  validatePullRequest,
  verifyActionReferences,
} from '../scripts/auto-merge-dependabot.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const OLD_ACTION_SHA = 'c'.repeat(40);
const NEW_ACTION_SHA = 'd'.repeat(40);

function validPullRequest() {
  return {
    state: 'open',
    draft: false,
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: BASE_SHA },
    head: {
      ref: 'dependabot/github_actions/official-github-actions-123456',
      sha: HEAD_SHA,
      repo: { full_name: 'owner/repository' },
    },
  };
}

function validWorkflowChange() {
  return {
    filename: '.github/workflows/validate.yml',
    status: 'modified',
    changes: 2,
    patch: [
      '@@ -1 +1 @@',
      '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v5.0.0',
      '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6.0.0',
    ].join('\n'),
  };
}

test('accepts only the tested Dependabot GitHub Actions pull request', () => {
  const expected = {
    repository: 'owner/repository',
    defaultBranch: 'main',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
  assert.doesNotThrow(() => validatePullRequest(validPullRequest(), expected));

  for (const mutate of [
    (pr) => { pr.user.login = 'someone'; },
    (pr) => { pr.base.sha = NEW_ACTION_SHA; },
    (pr) => { pr.head.sha = OLD_ACTION_SHA; },
    (pr) => { pr.head.ref = 'dependabot/npm_and_yarn/example'; },
    (pr) => { pr.head.repo.full_name = 'fork/repository'; },
    (pr) => { pr.draft = true; },
  ]) {
    const pullRequest = validPullRequest();
    mutate(pullRequest);
    assert.throws(() => validatePullRequest(pullRequest, expected));
  }
});

test('accepts one-for-one full-SHA actions/* replacements and rejects every broader diff', () => {
  assert.equal(validateChangedFiles([validWorkflowChange()]), 1);
  assert.throws(
    () => validateChangedFiles(Array.from({ length: 21 }, validWorkflowChange)),
    /Changed-file count is invalid/
  );
  const excessiveReferences = validWorkflowChange();
  excessiveReferences.patch = [
    '@@ -1,101 +1,101 @@',
    ...Array.from({ length: 101 }, () => '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v5.0.0'),
    ...Array.from({ length: 101 }, () => '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6.0.0')
  ].join('\n');
  excessiveReferences.changes = 202;
  assert.throws(() => validateChangedFiles([excessiveReferences]), /Action reference count is invalid/);

  const invalidChanges = [
    (file) => { file.filename = 'tools/icloud_price_comparison/script.js'; },
    (file) => { file.status = 'added'; },
    (file) => { delete file.patch; },
    (file) => { file.patch = file.patch.replace('actions/checkout', 'third-party/action'); },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, 'v6'.padEnd(40, 'x')); },
    (file) => { file.patch = file.patch.replace('v6.0.0', 'v6'); },
    (file) => { file.patch += '\n+      timeout-minutes: 30'; file.changes += 1; },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, OLD_ACTION_SHA); },
  ];

  for (const mutate of invalidChanges) {
    const file = validWorkflowChange();
    mutate(file);
    assert.throws(() => validateChangedFiles([file]));
  }
});

test('rejects an oversized pull request before requesting its changed-file pages', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url.endsWith('/pulls/42')) {
      return Response.json({ ...validPullRequest(), changed_files: 21 });
    }
    return Response.json({ message: 'unexpected request' }, { status: 500 });
  };

  await assert.rejects(
    main({
      DEFAULT_BRANCH: 'main',
      GITHUB_TOKEN: 'test-token',
      PR_NUMBER: '42',
      REPOSITORY: 'owner/repository',
      RUN_BASE_SHA: BASE_SHA,
      RUN_HEAD_SHA: HEAD_SHA,
    }, fetchImpl, () => {}),
    /Pull request changed-file count is invalid/
  );
  assert.equal(requests.length, 1);
});

test('merges through the GitHub API only with the exact tested head SHA', async () => {
  const pullRequest = { ...validPullRequest(), changed_files: 1 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json([validWorkflowChange()]);
    if (url.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'PUT');
      assert.equal(body.sha, HEAD_SHA);
      assert.equal(body.merge_method, 'squash');
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main({
    DEFAULT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    PR_NUMBER: '42',
    REPOSITORY: 'owner/repository',
    RUN_BASE_SHA: BASE_SHA,
    RUN_HEAD_SHA: HEAD_SHA,
  }, fetchImpl, () => {}, async () => ({
    stdout: `${NEW_ACTION_SHA}\trefs/tags/v6.0.0\n`,
    stderr: ''
  }));

  assert.equal(requests.length, 3);
  assert.match(requests[1].url, /\/files\?per_page=20&page=1$/);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-token'));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
});

test('rejects a pinned Action SHA that does not match its exact release tag', async () => {
  const requests = [];
  const runGit = async (command, arguments_, options) => {
    requests.push({ command, arguments_, options });
    return { stdout: `${OLD_ACTION_SHA}\trefs/tags/v6.0.0\n`, stderr: '' };
  };
  await assert.rejects(
    verifyActionReferences([
      { action: 'actions/checkout', sha: NEW_ACTION_SHA, version: 'v6.0.0' },
    ], runGit),
    /Pinned SHA does not match actions\/checkout@v6\.0\.0/
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command, 'git');
  assert.deepEqual(requests[0].arguments_.slice(0, 2), ['ls-remote', '--exit-code']);
  assert.equal(requests[0].options.timeout, 30_000);
});

test('peels annotated official Action tags before comparing the pinned commit', async () => {
  const tagObjectSha = 'e'.repeat(40);
  const runGit = async () => ({
    stdout: [
      `${tagObjectSha}\trefs/tags/v6.0.0`,
      `${NEW_ACTION_SHA}\trefs/tags/v6.0.0^{}`,
      ''
    ].join('\n'),
    stderr: ''
  });
  await assert.doesNotReject(verifyActionReferences([
    { action: 'actions/checkout', sha: NEW_ACTION_SHA, version: 'v6.0.0' },
  ], runGit));
  assert.equal(
    await resolveActionTagCommit({ action: 'actions/checkout', version: 'v6.0.0' }, runGit),
    NEW_ACTION_SHA
  );
});
