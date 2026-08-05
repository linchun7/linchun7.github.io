import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
  validateChangedFiles,
  validatePullRequest,
} from '../scripts/auto-merge-official-actions.mjs';

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
      '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v5',
      '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6',
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

  const invalidChanges = [
    (file) => { file.filename = 'tools/icloud_price_comparison/script.js'; },
    (file) => { file.status = 'added'; },
    (file) => { delete file.patch; },
    (file) => { file.patch = file.patch.replace('actions/checkout', 'third-party/action'); },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, 'v6'.padEnd(40, 'x')); },
    (file) => { file.patch += '\n+      timeout-minutes: 30'; file.changes += 1; },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, OLD_ACTION_SHA); },
  ];

  for (const mutate of invalidChanges) {
    const file = validWorkflowChange();
    mutate(file);
    assert.throws(() => validateChangedFiles([file]));
  }
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
  }, fetchImpl, () => {});

  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-token'));
});
