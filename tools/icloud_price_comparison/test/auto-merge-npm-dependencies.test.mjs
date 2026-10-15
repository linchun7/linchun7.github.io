import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
  validateChatgptNpmChangedFiles,
  validateChatgptNpmPullRequest,
  validateNpmChangedFiles,
  validateNpmPullRequest,
  validateRoutineNpmPackageUpdate,
  validateStaticBrowserNpmChangedFiles,
  validateStaticBrowserNpmPullRequest,
} from '../scripts/auto-merge-official-actions.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const ICLOUD_PACKAGE_PATH = 'tools/icloud_price_comparison/package.json';
const ICLOUD_LOCK_PATH = 'tools/icloud_price_comparison/pnpm-lock.yaml';
const STATIC_PACKAGE_PATH = 'tools/browser-tests/package.json';
const ICLOUD_WORKFLOW = 'Validate iCloud price comparison';
const STATIC_WORKFLOW = 'Validate static tools';

function expectedPullRequest() {
  return {
    repository: 'owner/repository',
    defaultBranch: 'main',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
}

function validIcloudPullRequest() {
  return {
    state: 'open',
    draft: false,
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: BASE_SHA },
    head: {
      ref: 'dependabot/npm_and_yarn/tools/icloud_price_comparison/cheerio-2.0.0',
      sha: HEAD_SHA,
      repo: { full_name: 'owner/repository' },
    },
  };
}

function validStaticPullRequest() {
  return {
    state: 'open',
    draft: false,
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: BASE_SHA },
    head: {
      ref: 'dependabot/npm_and_yarn/tools/browser-tests/playwright-2.0.0',
      sha: HEAD_SHA,
      repo: { full_name: 'owner/repository' },
    },
  };
}

function baseIcloudPackage() {
  return {
    name: 'icloud-price-comparison',
    version: '2.0.0',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    packageManager: 'pnpm@10.14.0+sha512.example',
    scripts: { test: 'node --test' },
    dependencies: { cheerio: '1.2.0' },
    devDependencies: { lucide: '1.33.0', playwright: '1.62.1' },
  };
}

function singleIcloudUpdate(version = '2.0.0') {
  const value = structuredClone(baseIcloudPackage());
  value.dependencies.cheerio = version;
  return value;
}

function groupedIcloudUpdate() {
  const value = singleIcloudUpdate('2.0.0');
  value.devDependencies.lucide = '2.0.0';
  return value;
}

function unapprovedIcloudDependencyUpdate() {
  const base = baseIcloudPackage();
  base.devDependencies['future-tool'] = '1.0.0';
  const head = structuredClone(base);
  head.devDependencies['future-tool'] = '2.0.0';
  return { base, head };
}

function baseStaticPackage() {
  return {
    name: 'linchun-static-tools-browser-tests',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    devDependencies: { playwright: '1.62.1' },
  };
}

function staticPlaywrightUpdate() {
  const value = structuredClone(baseStaticPackage());
  value.devDependencies.playwright = '2.0.0';
  return value;
}

function icloudDirectChangedFiles() {
  return [
    { filename: ICLOUD_PACKAGE_PATH, status: 'modified' },
    { filename: ICLOUD_LOCK_PATH, status: 'modified' },
  ];
}

function icloudLockOnlyChangedFiles() {
  return [{ filename: ICLOUD_LOCK_PATH, status: 'modified' }];
}

function staticChangedFiles() {
  return [{ filename: STATIC_PACKAGE_PATH, status: 'modified' }];
}

function asContent(value) {
  return {
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

function env(validationWorkflow) {
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

function runResponse(pullRequest, name, overrides = {}) {
  return Response.json({
    total_count: 1,
    workflow_runs: [{
      id: 100,
      name,
      run_attempt: 1,
      created_at: '2026-10-13T04:00:00Z',
      run_started_at: '2026-10-13T04:00:00Z',
      head_sha: HEAD_SHA,
      head_branch: pullRequest.head.ref,
      head_repository: { full_name: 'owner/repository' },
      event: 'pull_request',
      status: 'completed',
      conclusion: 'success',
      pull_requests: [{ number: 42 }],
      ...overrides,
    }],
  });
}

test('accepts only the matching iCloud and static-browser Dependabot npm scopes', () => {
  assert.doesNotThrow(() => validateNpmPullRequest(validIcloudPullRequest(), expectedPullRequest()));
  assert.doesNotThrow(() => validateStaticBrowserNpmPullRequest(validStaticPullRequest(), expectedPullRequest()));
  assert.throws(() => validateNpmPullRequest(validStaticPullRequest(), expectedPullRequest()));
  assert.throws(() => validateStaticBrowserNpmPullRequest(validIcloudPullRequest(), expectedPullRequest()));

  for (const mutate of [
    (pr) => { pr.user.login = 'someone'; },
    (pr) => { pr.base.sha = 'c'.repeat(40); },
    (pr) => { pr.head.sha = 'd'.repeat(40); },
    (pr) => { pr.head.repo.full_name = 'fork/repository'; },
    (pr) => { pr.draft = true; },
  ]) {
    const pullRequest = validIcloudPullRequest();
    mutate(pullRequest);
    assert.throws(() => validateNpmPullRequest(pullRequest, expectedPullRequest()));
  }
});

test('keeps each npm scope inside its reviewed manifest and lockfile boundary', () => {
  assert.equal(validateNpmChangedFiles(icloudDirectChangedFiles()), true);
  assert.equal(validateNpmChangedFiles(icloudLockOnlyChangedFiles()), false);
  assert.equal(validateStaticBrowserNpmChangedFiles(staticChangedFiles()), true);

  assert.throws(() => validateNpmChangedFiles([{ filename: ICLOUD_PACKAGE_PATH, status: 'modified' }]));
  assert.throws(() => validateStaticBrowserNpmChangedFiles([
    ...staticChangedFiles(),
    { filename: 'tools/browser-tests/package-lock.json', status: 'added' },
  ]));

  const renamed = staticChangedFiles();
  renamed[0] = { ...renamed[0], previous_filename: 'old-package.json' };
  assert.throws(() => validateStaticBrowserNpmChangedFiles(renamed));
});

test('accepts stable forward npm pins across major versions and rejects broader manifest edits', () => {
  assert.deepEqual(validateRoutineNpmPackageUpdate(baseIcloudPackage(), singleIcloudUpdate('2.0.0')), [
    { packageName: 'cheerio', before: '1.2.0', after: '2.0.0' },
  ]);
  assert.deepEqual(validateRoutineNpmPackageUpdate(baseIcloudPackage(), baseIcloudPackage()), []);

  const invalidPackages = [
    (value) => { value.dependencies.cheerio = '^2.0.0'; },
    (value) => { value.dependencies.cheerio = '1.1.9'; },
    (value) => { value.dependencies.newPackage = '1.0.0'; },
    (value) => { delete value.devDependencies.playwright; },
    (value) => { value.scripts.test = 'echo changed'; value.dependencies.cheerio = '2.0.0'; },
    (value) => { value.packageManager = 'pnpm@11.0.0'; value.dependencies.cheerio = '2.0.0'; },
  ];

  for (const mutate of invalidPackages) {
    const value = structuredClone(baseIcloudPackage());
    mutate(value);
    assert.throws(() => validateRoutineNpmPackageUpdate(baseIcloudPackage(), value));
  }
});

test('auto-merges one fully validated iCloud major dependency update at the exact tested head SHA', async () => {
  const pullRequest = { ...validIcloudPullRequest(), changed_files: 2 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/actions/runs?')) return runResponse(pullRequest, ICLOUD_WORKFLOW);
    if (url.includes('/pulls/42/files?')) return Response.json(icloudDirectChangedFiles());
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(singleIcloudUpdate('2.0.0')));
    if (url.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'PUT');
      assert.equal(body.sha, HEAD_SHA);
      assert.equal(body.merge_method, 'squash');
      assert.equal(body.commit_title, 'chore: update iCloud dependency (#42)');
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(ICLOUD_WORKFLOW), fetchImpl, () => {});
  assert.equal(requests.length, 7);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-token'));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
});

test('still accepts a fully validated iCloud lockfile-only transitive update', async () => {
  const pullRequest = { ...validIcloudPullRequest(), changed_files: 1 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/actions/runs?')) return runResponse(pullRequest, ICLOUD_WORKFLOW);
    if (url.includes('/pulls/42/files?')) return Response.json(icloudLockOnlyChangedFiles());
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.endsWith('/pulls/42/merge')) return Response.json({ merged: true });
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(ICLOUD_WORKFLOW), fetchImpl, () => {});
  assert.equal(requests.length, 7);
});

test('refuses a grouped iCloud PR so one broken dependency cannot block or ride with another', async () => {
  const pullRequest = { ...validIcloudPullRequest(), changed_files: 2 };
  let mergeRequested = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(icloudDirectChangedFiles());
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(groupedIcloudUpdate()));
    if (url.endsWith('/pulls/42/merge')) {
      mergeRequested = true;
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await assert.rejects(
    main(env(ICLOUD_WORKFLOW), fetchImpl, () => {}),
    /must update exactly one direct dependency/
  );
  assert.equal(mergeRequested, false);
});

test('requires explicit review before a future iCloud dependency enters automatic major upgrades', async () => {
  const pullRequest = { ...validIcloudPullRequest(), changed_files: 2 };
  const { base, head } = unapprovedIcloudDependencyUpdate();
  let mergeRequested = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(icloudDirectChangedFiles());
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(base));
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(head));
    if (url.endsWith('/pulls/42/merge')) {
      mergeRequested = true;
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await assert.rejects(
    main(env(ICLOUD_WORKFLOW), fetchImpl, () => {}),
    /dependency is outside the approved auto-update scope/
  );
  assert.equal(mergeRequested, false);
});

test('auto-merges a Playwright major only after the static three-browser validation workflow', async () => {
  const pullRequest = { ...validStaticPullRequest(), changed_files: 1 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/actions/runs?')) return runResponse(pullRequest, STATIC_WORKFLOW);
    if (url.includes('/pulls/42/files?')) return Response.json(staticChangedFiles());
    if (url.includes('/contents/' + STATIC_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseStaticPackage()));
    if (url.includes('/contents/' + STATIC_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(staticPlaywrightUpdate()));
    if (url.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(options.body);
      assert.equal(body.sha, HEAD_SHA);
      assert.equal(body.commit_title, 'chore: update static browser test dependency (#42)');
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(STATIC_WORKFLOW), fetchImpl, () => {});
  assert.equal(requests.length, 7);

  const wrongWorkflowFetch = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    return Response.json({ message: 'must not read further' }, { status: 500 });
  };
  await assert.rejects(
    main(env(ICLOUD_WORKFLOW), wrongWorkflowFetch, () => {}),
    /cannot be handled by Validate iCloud price comparison/
  );
});

test('rechecks the latest exact-head npm validation for both approved profiles before merging', async () => {
  for (const { pullRequest, workflow, files, packagePath, base, head } of [
    { pullRequest: validIcloudPullRequest(), workflow: ICLOUD_WORKFLOW, files: icloudDirectChangedFiles(), packagePath: ICLOUD_PACKAGE_PATH, base: baseIcloudPackage(), head: singleIcloudUpdate() },
    { pullRequest: validStaticPullRequest(), workflow: STATIC_WORKFLOW, files: staticChangedFiles(), packagePath: STATIC_PACKAGE_PATH, base: baseStaticPackage(), head: staticPlaywrightUpdate() },
  ]) {
    for (const overrides of [
      { status: 'queued', conclusion: null },
      { status: 'in_progress', conclusion: null },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { head_sha: 'e'.repeat(40) },
      { event: 'push' },
      { pull_requests: [{ number: 43 }] },
      { pull_requests: [], head_repository: { full_name: 'foreign/fork' } },
    ]) {
      let merged = false;
      let headRead = false;
      const messages = [];
      await main(env(workflow), async (url) => {
        if (url.endsWith('/pulls/42')) return Response.json({ ...pullRequest, changed_files: files.length });
        if (url.includes('/pulls/42/files?')) return Response.json(files);
        if (url.includes('/contents/' + packagePath + '?ref=' + BASE_SHA)) return Response.json(asContent(base));
        if (url.includes('/contents/' + packagePath + '?ref=' + HEAD_SHA)) {
          headRead = true;
          return Response.json(asContent(head));
        }
        if (url.includes('/actions/runs?')) {
          assert.equal(headRead, true, 'npm gate must follow manifest validation');
          return runResponse(pullRequest, workflow, overrides);
        }
        if (url.endsWith('/pulls/42/merge')) { merged = true; return Response.json({ merged: true }); }
        return Response.json({ message: 'unexpected request' }, { status: 404 });
      }, (message) => messages.push(message));
      assert.equal(merged, false, workflow + JSON.stringify(overrides));
      assert.match(messages.join('\n'), /not merged/);
    }
  }
});

const CHATGPT_PACKAGE_PATH = 'tools/chatgpt_price_comparison/package.json';
const CHATGPT_LOCK_PATH = 'tools/chatgpt_price_comparison/pnpm-lock.yaml';
const CHATGPT_WORKFLOW = 'Validate ChatGPT price comparison';

function baseChatgptPackage() {
  return {
    name: 'chatgpt-price-comparison', private: true, type: 'module',
    packageManager: 'pnpm@10.14.0+sha512.' + 'a'.repeat(128),
    scripts: { 'test:browser-matrix': 'node scripts/browser-matrix.mjs' },
    devDependencies: { playwright: '1.63.0' },
  };
}

function validChatgptPullRequest() {
  const pr = validStaticPullRequest();
  pr.user.type = 'Bot';
  pr.head.ref = 'dependabot/npm_and_yarn/tools/chatgpt_price_comparison/playwright-1.64.0';
  return pr;
}

function chatgptChangedFiles() {
  return [CHATGPT_PACKAGE_PATH, CHATGPT_LOCK_PATH].map(filename => ({ filename, status: 'modified' }));
}

async function chatgptGate({
  pr = validChatgptPullRequest(),
  head = { ...baseChatgptPackage(), devDependencies: { playwright: '1.64.0' } },
  files = chatgptChangedFiles(),
  lock = 'official lock\n',
  regenerate = async () => 'official lock\n',
  workflow = CHATGPT_WORKFLOW,
  runOverrides = {},
} = {}) {
  let merged = false;
  let refreshed = false;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/pulls/42')) return Response.json({ ...pr, changed_files: files.length });
    if (url.includes('/pulls/42/files?')) return Response.json(files);
    if (url.includes('/contents/' + CHATGPT_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseChatgptPackage()));
    if (url.includes('/contents/' + CHATGPT_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(head));
    if (url.includes('/contents/' + CHATGPT_LOCK_PATH + '?ref=' + HEAD_SHA)) {
      return Response.json({ encoding: 'base64', content: Buffer.from(lock).toString('base64') });
    }
    if (url.includes('/actions/runs?')) return runResponse(pr, CHATGPT_WORKFLOW, runOverrides);
    if (url.endsWith('/pulls/42/update-branch')) { refreshed = true; return Response.json({}); }
    if (url.endsWith('/pulls/42/merge')) {
      assert.equal(JSON.parse(options.body).sha, HEAD_SHA);
      assert.equal(JSON.parse(options.body).commit_title, 'chore: update ChatGPT browser test dependency (#42)');
      merged = true; return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };
  await main(env(workflow), fetchImpl, () => {}, undefined, regenerate);
  return { merged, refreshed };
}

test('ChatGPT has an independent exact manifest+lock boundary and validation workflow', async () => {
  assert.doesNotThrow(() => validateChatgptNpmPullRequest(validChatgptPullRequest(), expectedPullRequest()));
  assert.throws(() => validateChatgptNpmPullRequest(validStaticPullRequest(), expectedPullRequest()));
  assert.equal(validateChatgptNpmChangedFiles(chatgptChangedFiles()), true);
  assert.throws(() => validateChatgptNpmChangedFiles([{ filename: CHATGPT_LOCK_PATH, status: 'modified' }]));
  assert.throws(() => validateChatgptNpmChangedFiles([...chatgptChangedFiles(), { filename: '.npmrc', status: 'modified' }]));
  assert.deepEqual(await chatgptGate(), { merged: true, refreshed: false });
  await assert.rejects(chatgptGate({ workflow: STATIC_WORKFLOW }), /cannot be handled/);
});

test('ChatGPT majors, manifest scripts, extra dependencies and forged complete locks never auto-merge', async () => {
  for (const mutate of [
    p => { p.devDependencies.playwright = '2.0.0'; },
    p => { p.scripts['test:browser-matrix'] = 'echo bypass'; },
    p => { p.devDependencies.extra = '1.0.0'; },
    p => { p.packageManager = 'pnpm@11.0.0'; },
  ]) {
    const head = { ...baseChatgptPackage(), scripts: { ...baseChatgptPackage().scripts }, devDependencies: { playwright: '1.64.0' } };
    mutate(head);
    await assert.rejects(chatgptGate({ head }));
  }
  for (const addition of ['extra-package', 'scripts: evil', 'registry: evil', 'integrity: forged']) {
    await assert.rejects(chatgptGate({ lock: 'official lock\n' + addition }), /does not match/);
  }
  await assert.rejects(chatgptGate({ regenerate: async () => { throw new Error('registry down'); } }), /registry down/);
  await assert.rejects(chatgptGate({ files: [{ filename: CHATGPT_LOCK_PATH, status: 'modified' }] }), /outside/);
});

test('ChatGPT author identity, exact head/base and latest non-success CI remain fail-closed', async () => {
  for (const mutate of [
    pr => { pr.user.login = 'dependabot'; },
    pr => { pr.user.type = 'User'; },
    pr => { pr.head.repo.full_name = 'fork/repository'; },
  ]) {
    const pr = validChatgptPullRequest(); mutate(pr);
    await assert.rejects(chatgptGate({ pr }));
  }
  const moved = validChatgptPullRequest(); moved.head.sha = 'e'.repeat(40);
  assert.equal((await chatgptGate({ pr: moved })).merged, false);
  const rebased = validChatgptPullRequest(); rebased.base.sha = 'f'.repeat(40);
  assert.deepEqual(await chatgptGate({ pr: rebased }), { merged: false, refreshed: true });
  for (const runOverrides of [
    { status: 'queued', conclusion: null }, { status: 'in_progress', conclusion: null },
    { conclusion: 'failure' }, { conclusion: 'cancelled' },
    { head_sha: 'e'.repeat(40) }, { head_repository: { full_name: 'foreign/repository' } },
  ]) assert.equal((await chatgptGate({ runOverrides })).merged, false);
});
