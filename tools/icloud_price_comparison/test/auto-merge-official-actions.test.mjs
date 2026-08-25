import assert from 'node:assert/strict';
import test from 'node:test';

import {
  latestRequiredWorkflowState,
  main,
  requiredActionValidationWorkflows,
  resolveActionTagCommit,
  validateChangedFiles,
  validatePullRequest,
  verifyActionReferences,
} from '../scripts/auto-merge-official-actions.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const OLD_ACTION_SHA = 'c'.repeat(40);
const NEW_ACTION_SHA = 'd'.repeat(40);
const ICLOUD_WORKFLOW = 'Validate iCloud price comparison';
const STATIC_WORKFLOW = 'Validate static tools';

function validPullRequest() {
  return {
    state: 'open',
    draft: false,
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: BASE_SHA },
    head: {
      ref: 'dependabot/github_actions/checkout-123456',
      sha: HEAD_SHA,
      repo: { full_name: 'owner/repository' },
    },
  };
}

function validWorkflowChange(filename = '.github/workflows/update-icloud-prices.yml') {
  return {
    filename,
    status: 'modified',
    changes: 2,
    patch: [
      '@@ -1 +1 @@',
      '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v6.0.0',
      '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6.1.0',
    ].join('\n'),
  };
}

function env(validationWorkflow = ICLOUD_WORKFLOW) {
  return {
    DEFAULT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    PR_NUMBER: '42',
    REPOSITORY: 'owner/repository',
    RUN_BASE_SHA: BASE_SHA,
    RUN_HEAD_SHA: HEAD_SHA,
    VALIDATION_WORKFLOW: validationWorkflow,
  };
}

function workflowRun(name, overrides = {}) {
  return {
    id: 100,
    name,
    head_sha: HEAD_SHA,
    head_branch: 'dependabot/github_actions/checkout-123456',
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{ number: 42 }],
    ...overrides,
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

test('accepts one-for-one full-SHA updates for exactly one official Action and rejects broader diffs', () => {
  assert.equal(validateChangedFiles([validWorkflowChange()]), 1);
  assert.throws(
    () => validateChangedFiles(Array.from({ length: 21 }, () => validWorkflowChange())),
    /Changed-file count is invalid/
  );

  const excessiveReferences = validWorkflowChange();
  excessiveReferences.patch = [
    '@@ -1,101 +1,101 @@',
    ...Array.from({ length: 101 }, () => '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v6.0.0'),
    ...Array.from({ length: 101 }, () => '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6.1.0')
  ].join('\n');
  excessiveReferences.changes = 202;
  assert.throws(() => validateChangedFiles([excessiveReferences]), /Action reference count is invalid/);

  const groupedActions = validWorkflowChange();
  groupedActions.patch = [
    '@@ -1,2 +1,2 @@',
    '-        uses: actions/checkout@' + OLD_ACTION_SHA + ' # v6.0.0',
    '+        uses: actions/checkout@' + NEW_ACTION_SHA + ' # v6.1.0',
    '-        uses: actions/setup-node@' + OLD_ACTION_SHA + ' # v6.0.0',
    '+        uses: actions/setup-node@' + NEW_ACTION_SHA + ' # v6.1.0',
  ].join('\n');
  groupedActions.changes = 4;
  assert.throws(() => validateChangedFiles([groupedActions]), /must update exactly one Action/);

  const invalidChanges = [
    (file) => { file.filename = 'tools/icloud_price_comparison/script.js'; },
    (file) => { file.status = 'added'; },
    (file) => { delete file.patch; },
    (file) => { file.patch = file.patch.replace('actions/checkout', 'third-party/action'); },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, 'v6'.padEnd(40, 'x')); },
    (file) => { file.patch = file.patch.replace('v6.1.0', 'v6'); },
    (file) => { file.patch += '\n+      timeout-minutes: 30'; file.changes += 1; },
    (file) => { file.patch = file.patch.replace(NEW_ACTION_SHA, OLD_ACTION_SHA); },
  ];

  for (const mutate of invalidChanges) {
    const file = validWorkflowChange();
    mutate(file);
    assert.throws(() => validateChangedFiles([file]));
  }
});

test('keeps GitHub Actions majors manual because production-only Action behavior is not fully exercised', () => {
  const major = validWorkflowChange();
  major.patch = major.patch.replace('# v6.1.0', '# v7.0.0');
  assert.throws(() => validateChangedFiles([major]), /major update requires manual review/);

  const rollback = validWorkflowChange();
  rollback.patch = rollback.patch.replace('# v6.0.0', '# v6.2.0').replace('# v6.1.0', '# v6.1.0');
  assert.throws(() => validateChangedFiles([rollback]), /update must move forward/);

  const prerelease = validWorkflowChange();
  prerelease.patch = prerelease.patch.replace('# v6.1.0', '# v6.1.0-beta.1');
  assert.throws(() => validateChangedFiles([prerelease]), /exact stable vX\.Y\.Z release tag/);
});

test('requires static validation only when an Action PR actually changes the static validation workflow', () => {
  assert.deepEqual(requiredActionValidationWorkflows([validWorkflowChange()]), [ICLOUD_WORKFLOW]);
  assert.deepEqual(
    requiredActionValidationWorkflows([
      validWorkflowChange(),
      validWorkflowChange('.github/workflows/validate-static-tools.yml'),
    ]),
    [ICLOUD_WORKFLOW, STATIC_WORKFLOW]
  );
});

test('uses the latest exact-head workflow run and never lets an older success mask a newer failure', () => {
  const runs = [
    workflowRun(STATIC_WORKFLOW, { id: 100, conclusion: 'success' }),
    workflowRun(STATIC_WORKFLOW, { id: 101, conclusion: 'failure' }),
  ];
  assert.deepEqual(latestRequiredWorkflowState(runs, STATIC_WORKFLOW), {
    ready: false,
    reason: `${STATIC_WORKFLOW} concluded failure`,
  });
});

test('quietly ignores duplicate or superseded workflow_run events after the PR moved on', async () => {
  for (const pullRequest of [
    { ...validPullRequest(), state: 'closed' },
    {
      ...validPullRequest(),
      head: { ...validPullRequest().head, sha: 'e'.repeat(40) },
    },
  ]) {
    const requests = [];
    const messages = [];
    const fetchImpl = async (url) => {
      requests.push(url);
      if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
      return Response.json({ message: 'unexpected request' }, { status: 500 });
    };
    await main(env(), fetchImpl, (message) => messages.push(message));
    assert.equal(requests.length, 1);
    assert.ok(messages.length > 0);
  }
});

test('updates a stale Dependabot branch instead of merging a result tested against an old base', async () => {
  const staleBaseSha = 'e'.repeat(40);
  const pullRequest = {
    ...validPullRequest(),
    base: { ref: 'main', sha: staleBaseSha },
    changed_files: 1,
  };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.endsWith('/pulls/42/update-branch')) {
      assert.equal(options.method, 'PUT');
      assert.deepEqual(JSON.parse(options.body), { expected_head_sha: HEAD_SHA });
      return Response.json({ message: 'Updating pull request branch.' }, { status: 202 });
    }
    return Response.json({ message: 'unexpected request' }, { status: 500 });
  };

  const messages = [];
  await main(env(), fetchImpl, (message) => messages.push(message));
  assert.equal(requests.length, 2);
  assert.match(messages.join('\n'), /waiting for fresh validation/);
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
    main(env(), fetchImpl, () => {}),
    /Pull request changed-file count is invalid/
  );
  assert.equal(requests.length, 1);
});

test('waits for the other required validation before merging a cross-workflow Action update', async () => {
  const files = [
    validWorkflowChange(),
    validWorkflowChange('.github/workflows/validate-static-tools.yml'),
  ];
  const pullRequest = { ...validPullRequest(), changed_files: files.length };
  let mergeRequested = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(files);
    if (url.includes('/actions/runs?')) {
      return Response.json({
        workflow_runs: [workflowRun(STATIC_WORKFLOW, { status: 'in_progress', conclusion: null })],
      });
    }
    if (url.endsWith('/pulls/42/merge')) {
      mergeRequested = true;
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  const messages = [];
  await main(env(ICLOUD_WORKFLOW), fetchImpl, (message) => messages.push(message));
  assert.equal(mergeRequested, false);
  assert.match(messages.join('\n'), /Validate static tools is in_progress/);
});

test('merges a cross-workflow Action update only after the other exact-head validation passed', async () => {
  const files = [
    validWorkflowChange(),
    validWorkflowChange('.github/workflows/validate-static-tools.yml'),
  ];
  const pullRequest = { ...validPullRequest(), changed_files: files.length };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(files);
    if (url.includes('/actions/runs?')) {
      return Response.json({ workflow_runs: [workflowRun(ICLOUD_WORKFLOW)] });
    }
    if (url.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, HEAD_SHA);
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(STATIC_WORKFLOW), fetchImpl, () => {}, async () => ({
    stdout: `${NEW_ACTION_SHA}\trefs/tags/v6.1.0\n`,
    stderr: ''
  }));
  assert.equal(requests.filter(({ url }) => url.endsWith('/pulls/42/merge')).length, 1);
});

test('merges a same-major official Action update only at the exact tested head SHA', async () => {
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
      assert.equal(body.commit_title, 'chore: update official GitHub Action (#42)');
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(), fetchImpl, () => {}, async () => ({
    stdout: `${NEW_ACTION_SHA}\trefs/tags/v6.1.0\n`,
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
    return { stdout: `${OLD_ACTION_SHA}\trefs/tags/v6.1.0\n`, stderr: '' };
  };
  await assert.rejects(
    verifyActionReferences([
      { action: 'actions/checkout', sha: NEW_ACTION_SHA, version: 'v6.1.0' },
    ], runGit),
    /Pinned SHA does not match actions\/checkout@v6\.1\.0/
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
      `${tagObjectSha}\trefs/tags/v6.1.0`,
      `${NEW_ACTION_SHA}\trefs/tags/v6.1.0^{}`,
      ''
    ].join('\n'),
    stderr: ''
  });
  await assert.doesNotReject(verifyActionReferences([
    { action: 'actions/checkout', sha: NEW_ACTION_SHA, version: 'v6.1.0' },
  ], runGit));
  assert.equal(
    await resolveActionTagCommit({ action: 'actions/checkout', version: 'v6.1.0' }, runGit),
    NEW_ACTION_SHA
  );
});
