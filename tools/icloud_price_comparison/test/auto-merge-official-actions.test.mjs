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
    run_attempt: 1,
    created_at: '2026-10-13T04:00:00Z',
    run_started_at: '2026-10-13T04:00:00Z',
    head_sha: HEAD_SHA,
    head_branch: 'dependabot/github_actions/checkout-123456',
    head_repository: { full_name: 'owner/repository' },
    event: 'pull_request',
    status: 'completed',
    conclusion: 'success',
    pull_requests: [{ number: 42 }],
    ...overrides,
  };
}

function runResponse(runs) {
  return Response.json({ total_count: runs.length, workflow_runs: runs });
}

async function validRunGit() {
  return { stdout: `${NEW_ACTION_SHA}\trefs/tags/v6.1.0\n`, stderr: '' };
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
      return runResponse([
        workflowRun(ICLOUD_WORKFLOW),
        workflowRun(STATIC_WORKFLOW, { status: 'in_progress', conclusion: null }),
      ]);
    }
    if (url.endsWith('/pulls/42/merge')) {
      mergeRequested = true;
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  const messages = [];
  await main(env(ICLOUD_WORKFLOW), fetchImpl, (message) => messages.push(message), validRunGit);
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
      return runResponse([workflowRun(ICLOUD_WORKFLOW), workflowRun(STATIC_WORKFLOW)]);
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
    if (url.includes('/actions/runs?')) return runResponse([workflowRun(ICLOUD_WORKFLOW)]);
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

  assert.equal(requests.length, 5);
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

async function actionGateProbe({
  trigger = ICLOUD_WORKFLOW,
  files = [validWorkflowChange()],
  runs = [workflowRun(ICLOUD_WORKFLOW)],
  runPayload,
  runStatus = 200,
  finalPullRequest,
} = {}) {
  const pullRequest = { ...validPullRequest(), changed_files: files.length };
  const requests = [];
  const messages = [];
  let pullRequestReads = 0;
  let tagVerified = false;
  let error;
  try {
    await main(env(trigger), async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith('/pulls/42')) {
        pullRequestReads += 1;
        return Response.json(pullRequestReads === 1 ? pullRequest : finalPullRequest ?? pullRequest);
      }
      if (url.includes('/pulls/42/files?')) return Response.json(files);
      if (url.includes('/actions/runs?')) {
        assert.equal(tagVerified, true, 'workflow gate must follow release verification');
        assert.equal(pullRequestReads, 2, 'PR identity must be refreshed before the merge gate');
        return Response.json(runPayload === undefined ? { total_count: runs.length, workflow_runs: runs } : runPayload, { status: runStatus });
      }
      if (url.endsWith('/pulls/42/update-branch')) return Response.json({ message: 'Updating branch.' }, { status: 202 });
      if (url.endsWith('/pulls/42/merge')) return Response.json({ merged: true });
      return Response.json({ message: 'unexpected request' }, { status: 404 });
    }, (message) => messages.push(message), async () => {
      tagVerified = true;
      return validRunGit();
    });
  } catch (caught) {
    error = caught;
  }
  return {
    error, requests, messages,
    merged: requests.some(({ url }) => url.endsWith('/pulls/42/merge')),
    updated: requests.find(({ url }) => url.endsWith('/pulls/42/update-branch')),
  };
}

test('rechecks the triggering Action workflow near merge and blocks every non-success state', async () => {
  for (const overrides of [
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
    ...['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', null].map((conclusion) => ({ conclusion })),
  ]) {
    const result = await actionGateProbe({ runs: [
      workflowRun(ICLOUD_WORKFLOW, { id: 99 }),
      workflowRun(ICLOUD_WORKFLOW, { id: 100, ...overrides }),
    ] });
    assert.equal(result.error, undefined);
    assert.equal(result.merged, false, JSON.stringify(overrides));
  }
  const missing = await actionGateProbe({ runs: [] });
  assert.equal(missing.merged, false);
  assert.match(missing.messages.join('\n'), /waiting for Validate iCloud/);
});

test('rechecks every required workflow including static and artifact triggers', async () => {
  const artifactName = 'Validate Action artifact roundtrip';
  const artifactFile = validWorkflowChange();
  artifactFile.patch = artifactFile.patch.replaceAll('actions/checkout', 'actions/upload-artifact');
  for (const { files, trigger, required } of [
    { files: [validWorkflowChange('.github/workflows/validate-static-tools.yml')], trigger: STATIC_WORKFLOW, required: [ICLOUD_WORKFLOW, STATIC_WORKFLOW] },
    { files: [artifactFile], trigger: artifactName, required: [ICLOUD_WORKFLOW, artifactName] },
  ]) {
    for (const failedName of required) {
      const result = await actionGateProbe({ files, trigger, runs: required.map((name) => workflowRun(name, { conclusion: name === failedName ? 'failure' : 'success' })) });
      assert.equal(result.error, undefined);
      assert.equal(result.merged, false, failedName);
    }
    const ready = await actionGateProbe({ files, trigger, runs: required.map((name) => workflowRun(name)) });
    assert.equal(ready.error, undefined);
    assert.equal(ready.merged, true);
  }
});

test('orders terminal reruns by attempt start time and permits a genuinely fresh success', () => {
  const laterCreatedSuccess = workflowRun(ICLOUD_WORKFLOW, {
    id: 101, run_started_at: '2026-10-13T05:00:00Z',
  });
  const earlierRunRerun = workflowRun(ICLOUD_WORKFLOW, {
    id: 100, run_attempt: 2, run_started_at: '2026-10-13T06:00:00Z', conclusion: 'failure',
  });
  assert.equal(latestRequiredWorkflowState([laterCreatedSuccess, earlierRunRerun], ICLOUD_WORKFLOW).ready, false);
  const freshSuccess = workflowRun(ICLOUD_WORKFLOW, { id: 102, run_started_at: '2026-10-13T07:00:00Z' });
  assert.equal(latestRequiredWorkflowState([laterCreatedSuccess, earlierRunRerun, freshSuccess], ICLOUD_WORKFLOW).ready, true);
  // Log or metadata updates do not make an older failed attempt the latest.
  assert.equal(latestRequiredWorkflowState([
    { ...earlierRunRerun, updated_at: '2026-10-13T08:00:00Z' }, freshSuccess,
  ], ICLOUD_WORKFLOW).ready, true);
  assert.equal(latestRequiredWorkflowState([
    { ...earlierRunRerun, run_attempt: 3, conclusion: 'success' },
    { ...earlierRunRerun, run_attempt: 2 },
  ], ICLOUD_WORKFLOW).ready, true);
});

test('waits for queued reruns even when their start time still belongs to the old attempt', () => {
  const freshSuccess = workflowRun(ICLOUD_WORKFLOW, { id: 101, run_started_at: '2026-10-13T05:00:00Z' });
  const rerun = workflowRun(ICLOUD_WORKFLOW, { id: 100, run_attempt: 2, status: 'queued', conclusion: null });
  assert.equal(latestRequiredWorkflowState([freshSuccess, rerun], ICLOUD_WORKFLOW).ready, false);
  assert.equal(latestRequiredWorkflowState([freshSuccess, { ...rerun, status: 'completed', conclusion: 'failure', run_started_at: '2026-10-13T06:00:00Z' }], ICLOUD_WORKFLOW).ready, false);
  assert.equal(latestRequiredWorkflowState([freshSuccess, { ...rerun, status: 'completed', conclusion: 'success', run_started_at: '2026-10-13T06:00:00Z' }], ICLOUD_WORKFLOW).ready, true);
});

test('requires explicit same-repository run identity before using empty PR associations', async () => {
  const ownFailure = workflowRun(ICLOUD_WORKFLOW, { id: 99, conclusion: 'failure' });
  for (const overrides of [
    { pull_requests: [], head_repository: { full_name: 'foreign/fork' } },
    { pull_requests: [{ number: 42 }], head_repository: { full_name: 'foreign/fork' } },
    { pull_requests: [], head_repository: undefined },
    { pull_requests: [{ number: 43 }] },
    { pull_requests: [], head_branch: 'different-branch' },
    { head_sha: 'e'.repeat(40) },
    { event: 'push' },
  ]) {
    const result = await actionGateProbe({ runs: [ownFailure, workflowRun(ICLOUD_WORKFLOW, overrides)] });
    assert.equal(result.error, undefined);
    assert.equal(result.merged, false, JSON.stringify(overrides));
  }
  const legitimateFallback = await actionGateProbe({ runs: [workflowRun(ICLOUD_WORKFLOW, { pull_requests: [] })] });
  assert.equal(legitimateFallback.error, undefined);
  assert.equal(legitimateFallback.merged, true);
});

test('fails closed when the run listing is malformed, rate-limited, or explicitly incomplete', async () => {
  for (const { runPayload, runStatus } of [
    { runPayload: {} },
    { runPayload: { total_count: 1, workflow_runs: {} } },
    { runPayload: { workflow_runs: [workflowRun(ICLOUD_WORKFLOW)] } },
    { runPayload: { total_count: 2, workflow_runs: [workflowRun(ICLOUD_WORKFLOW)] } },
    { runPayload: { total_count: 101, workflow_runs: Array.from({ length: 100 }, () => workflowRun(ICLOUD_WORKFLOW)) } },
    ...[undefined, {}].map((pull_requests) => ({ runPayload: { total_count: 2, workflow_runs: [
      workflowRun(ICLOUD_WORKFLOW, { id: 99 }),
      workflowRun(ICLOUD_WORKFLOW, { conclusion: 'failure', pull_requests }),
    ] } })),
    { runPayload: { message: 'rate limit exceeded' }, runStatus: 403 },
  ]) {
    const result = await actionGateProbe({ runPayload, runStatus });
    assert.ok(result.error);
    assert.equal(result.merged, false);
  }
  for (const overrides of [{ id: undefined }, { run_attempt: undefined }, { run_started_at: 'invalid' }]) {
    const result = await actionGateProbe({ runs: [workflowRun(ICLOUD_WORKFLOW, overrides)] });
    assert.equal(result.merged, false);
    assert.match(result.messages.join('\n'), /invalid run metadata/);
  }
});

test('refreshes PR identity after release verification and never merges changed heads or readiness', async () => {
  for (const overrides of [
    { state: 'closed' },
    { head: { ...validPullRequest().head, sha: 'e'.repeat(40) } },
    { draft: true },
    { base: { ref: 'release', sha: BASE_SHA } },
    { head: { ...validPullRequest().head, repo: { full_name: 'foreign/fork' } } },
    { head: { ...validPullRequest().head, ref: 'different-branch' } },
  ]) {
    const result = await actionGateProbe({ finalPullRequest: { ...validPullRequest(), changed_files: 1, ...overrides } });
    assert.equal(result.merged, false, JSON.stringify(overrides));
    assert.equal(result.updated, undefined);
  }
});

test('updates a base that moves during release verification and waits for fresh validation', async () => {
  const result = await actionGateProbe({ finalPullRequest: { ...validPullRequest(), changed_files: 1, base: { ref: 'main', sha: 'e'.repeat(40) } } });
  assert.equal(result.error, undefined);
  assert.equal(result.merged, false);
  assert.equal(result.updated.options.method, 'PUT');
  assert.deepEqual(JSON.parse(result.updated.options.body), { expected_head_sha: HEAD_SHA });
  assert.match(result.messages.join('\n'), /waiting for fresh validation/);
});

test('blocks ambiguous terminal results at the latest second regardless of run ID or list order', () => {
  const name = 'Validate Action artifact roundtrip';
  const success = workflowRun(name, { id: 101, run_started_at: '2026-10-13T06:00:00Z' });
  const states = [];
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', null]) {
    const rerun = workflowRun(name, { id: 100, run_attempt: 2, run_started_at: success.run_started_at, conclusion });
    for (const runs of [[success, rerun], [rerun, success]]) {
      states.push(latestRequiredWorkflowState(runs, name).ready);
    }
  }
  assert.deepEqual(states, Array(states.length).fill(false));
});

test('allows all-success timestamp ties and recovery after an earlier terminal failure', () => {
  const name = 'Validate Action artifact roundtrip';
  const failed = workflowRun(name, { id: 100, run_attempt: 2, run_started_at: '2026-10-13T06:00:00Z', conclusion: 'failure' });
  const success = workflowRun(name, { id: 101, run_started_at: failed.run_started_at });
  const fresh = workflowRun(name, { id: 99, run_started_at: '2026-10-13T07:00:00Z' });
  for (const runs of [
    [success, { ...failed, conclusion: 'success' }],
    [{ ...failed, run_started_at: '2026-10-13T05:00:00Z' }, success, { ...success, id: 102 }],
    [failed, success, fresh],
    [failed, { ...failed, run_attempt: 3, conclusion: 'success' }, success],
  ]) {
    for (const order of [runs, [...runs].reverse()]) {
      assert.equal(latestRequiredWorkflowState(order, name).ready, true);
    }
  }
});

test('rejects contradictory latest-attempt metadata instead of choosing a duplicate by list order', () => {
  const name = 'Validate Action artifact roundtrip';
  const success = workflowRun(name, { id: 101, run_started_at: '2026-10-13T06:00:00Z' });
  const rerun = workflowRun(name, { id: 100, run_attempt: 2, run_started_at: success.run_started_at });
  const results = [];
  for (const duplicates of [
    [rerun, { ...rerun, conclusion: 'failure' }],
    [rerun, { ...rerun, run_started_at: '2026-10-13T07:00:00Z' }],
    [{ ...rerun, run_attempt: 1 }, { ...rerun, run_started_at: '2026-10-13T05:00:00Z', conclusion: 'failure' }],
  ]) {
    const runs = [success, ...duplicates];
    for (const order of [runs, [...runs].reverse()]) {
      results.push(latestRequiredWorkflowState(order, name).ready);
    }
  }
  assert.deepEqual(results, Array(results.length).fill(false));
});

test('full artifact merge gate blocks tied failures and inconsistent attempts, then permits recovery', async () => {
  const name = 'Validate Action artifact roundtrip';
  const file = validWorkflowChange();
  file.patch = file.patch.replaceAll('actions/checkout', 'actions/upload-artifact');
  const success = workflowRun(name, { id: 101, run_started_at: '2026-10-13T06:00:00Z' });
  const failed = workflowRun(name, { id: 100, run_attempt: 2, run_started_at: success.run_started_at, conclusion: 'failure' });
  const scenarios = [
    { runs: [success, failed], merged: false },
    { runs: [success, { ...failed, conclusion: 'cancelled' }], merged: false },
    { runs: [success, { ...failed, conclusion: null }], merged: false },
    { runs: [success, failed, { ...failed, conclusion: 'success' }], merged: false },
    { runs: [success, { ...failed, conclusion: 'success' }], merged: true },
    { runs: [success, { ...failed, run_started_at: '2026-10-13T05:00:00Z' }], merged: true },
    { runs: [success, failed, workflowRun(name, { id: 99, run_started_at: '2026-10-13T07:00:00Z' })], merged: true },
    { runs: [success, failed, { ...failed, run_attempt: 3, conclusion: 'success' }], merged: true },
  ];
  const actual = [];
  const expected = [];
  for (const trigger of [ICLOUD_WORKFLOW, name]) {
    for (const scenario of scenarios) {
      for (const order of [scenario.runs, [...scenario.runs].reverse()]) {
        const result = await actionGateProbe({ files: [file], trigger, runs: [workflowRun(ICLOUD_WORKFLOW, { id: 200 }), ...order] });
        assert.equal(result.error, undefined);
        actual.push(result.merged);
        expected.push(scenario.merged);
      }
    }
  }
  assert.deepEqual(actual, expected);
});

test('accepts pin-only YAML list shorthand without allowing step-structure changes or commands', () => {
  const short = validWorkflowChange();
  short.patch = short.patch.replaceAll('        uses:', '      - uses:');
  assert.equal(validateChangedFiles([short]), 1);
  for (const changed of [
    short.patch.replace('+      - uses:', '+        uses:'),
    validWorkflowChange().patch.replace('+        uses:', '+      - uses:'),
    short.patch + '\n+      - run: echo injected',
    short.patch.replace('+      - uses:', '+      - run:'),
  ]) {
    assert.throws(() => validateChangedFiles([{ ...short, patch: changed, changes: changed.includes('echo injected') ? 3 : 2 }]));
  }
});
