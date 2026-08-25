import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
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
  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-token'));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
});

test('still accepts a fully validated iCloud lockfile-only transitive update', async () => {
  const pullRequest = { ...validIcloudPullRequest(), changed_files: 1 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(icloudLockOnlyChangedFiles());
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.includes('/contents/' + ICLOUD_PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(baseIcloudPackage()));
    if (url.endsWith('/pulls/42/merge')) return Response.json({ merged: true });
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await main(env(ICLOUD_WORKFLOW), fetchImpl, () => {});
  assert.equal(requests.length, 5);
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
  assert.equal(requests.length, 5);

  const wrongWorkflowFetch = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    return Response.json({ message: 'must not read further' }, { status: 500 });
  };
  await assert.rejects(
    main(env(ICLOUD_WORKFLOW), wrongWorkflowFetch, () => {}),
    /cannot be handled by Validate iCloud price comparison/
  );
});
