import assert from 'node:assert/strict';
import test from 'node:test';

import {
  main,
  validateNpmChangedFiles,
  validateNpmPullRequest,
  validateRoutineNpmPackageUpdate,
} from '../scripts/auto-merge-dependabot.mjs';

const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const PACKAGE_PATH = 'tools/icloud_price_comparison/package.json';
const LOCK_PATH = 'tools/icloud_price_comparison/pnpm-lock.yaml';

function validPullRequest() {
  return {
    state: 'open',
    draft: false,
    user: { login: 'dependabot[bot]' },
    base: { ref: 'main', sha: BASE_SHA },
    head: {
      ref: 'dependabot/npm_and_yarn/tools/icloud_price_comparison/icloud-price-dependencies-123456',
      sha: HEAD_SHA,
      repo: { full_name: 'owner/repository' },
    },
  };
}

function basePackage() {
  return {
    name: 'icloud-price-comparison',
    version: '2.0.0',
    private: true,
    type: 'module',
    engines: { node: '>=22' },
    packageManager: 'pnpm@10.14.0+sha512.example',
    scripts: { test: 'node --test' },
    dependencies: { cheerio: '1.2.0' },
    devDependencies: { lucide: '1.31.0', playwright: '1.62.1' },
  };
}

function routinePackage() {
  const value = structuredClone(basePackage());
  value.dependencies.cheerio = '1.3.0';
  value.devDependencies.lucide = '1.31.1';
  return value;
}

function changedFiles() {
  return [
    { filename: PACKAGE_PATH, status: 'modified' },
    { filename: LOCK_PATH, status: 'modified' },
  ];
}

function asContent(value) {
  return {
    encoding: 'base64',
    content: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

test('accepts only the tested iCloud Dependabot npm pull request', () => {
  const expected = {
    repository: 'owner/repository',
    defaultBranch: 'main',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
  assert.doesNotThrow(() => validateNpmPullRequest(validPullRequest(), expected));

  for (const mutate of [
    (pr) => { pr.user.login = 'someone'; },
    (pr) => { pr.base.sha = 'c'.repeat(40); },
    (pr) => { pr.head.sha = 'd'.repeat(40); },
    (pr) => { pr.head.ref = 'dependabot/npm_and_yarn/other_project/dependencies'; },
    (pr) => { pr.head.ref = 'dependabot/github_actions/actions'; },
    (pr) => { pr.head.repo.full_name = 'fork/repository'; },
    (pr) => { pr.draft = true; },
  ]) {
    const pullRequest = validPullRequest();
    mutate(pullRequest);
    assert.throws(() => validateNpmPullRequest(pullRequest, expected));
  }
});

test('allows only package.json plus pnpm-lock.yaml for routine npm auto-merge', () => {
  assert.doesNotThrow(() => validateNpmChangedFiles(changedFiles()));

  const extra = [...changedFiles(), { filename: 'tools/icloud_price_comparison/script.js', status: 'modified' }];
  assert.throws(() => validateNpmChangedFiles(extra));
  assert.throws(() => validateNpmChangedFiles([changedFiles()[0]]));

  const renamed = changedFiles();
  renamed[0] = { ...renamed[0], previous_filename: 'old-package.json' };
  assert.throws(() => validateNpmChangedFiles(renamed));
});

test('auto-merges only forward minor or patch changes to existing exact dependency pins', () => {
  const changes = validateRoutineNpmPackageUpdate(basePackage(), routinePackage());
  assert.deepEqual(changes, [
    { packageName: 'cheerio', before: '1.2.0', after: '1.3.0' },
    { packageName: 'lucide', before: '1.31.0', after: '1.31.1' },
  ]);

  const invalidPackages = [
    (value) => { value.dependencies.cheerio = '2.0.0'; },
    (value) => { value.dependencies.cheerio = '^1.3.0'; },
    (value) => { value.dependencies.cheerio = '1.1.9'; },
    (value) => { value.dependencies.newPackage = '1.0.0'; },
    (value) => { delete value.devDependencies.playwright; },
    (value) => { value.scripts.test = 'echo changed'; value.dependencies.cheerio = '1.3.0'; },
    (value) => { value.packageManager = 'pnpm@11.0.0'; value.dependencies.cheerio = '1.3.0'; },
  ];

  for (const mutate of invalidPackages) {
    const value = structuredClone(basePackage());
    mutate(value);
    assert.throws(() => validateRoutineNpmPackageUpdate(basePackage(), value));
  }
});

test('merges a fully validated routine npm PR only at the exact tested head SHA', async () => {
  const pullRequest = { ...validPullRequest(), changed_files: 2 };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(changedFiles());
    if (url.includes('/contents/' + PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(basePackage()));
    if (url.includes('/contents/' + PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(routinePackage()));
    if (url.endsWith('/pulls/42/merge')) {
      const body = JSON.parse(options.body);
      assert.equal(options.method, 'PUT');
      assert.equal(body.sha, HEAD_SHA);
      assert.equal(body.merge_method, 'squash');
      assert.equal(body.commit_title, 'chore: update iCloud dependencies (#42)');
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

  assert.equal(requests.length, 5);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === 'Bearer test-token'));
  assert.ok(requests.every(({ options }) => options.redirect === 'error'));
});

test('refuses to merge a major npm update even after a successful CI trigger', async () => {
  const pullRequest = { ...validPullRequest(), changed_files: 2 };
  const major = basePackage();
  major.dependencies.cheerio = '2.0.0';
  let mergeRequested = false;
  const fetchImpl = async (url) => {
    if (url.endsWith('/pulls/42')) return Response.json(pullRequest);
    if (url.includes('/pulls/42/files?')) return Response.json(changedFiles());
    if (url.includes('/contents/' + PACKAGE_PATH + '?ref=' + BASE_SHA)) return Response.json(asContent(basePackage()));
    if (url.includes('/contents/' + PACKAGE_PATH + '?ref=' + HEAD_SHA)) return Response.json(asContent(major));
    if (url.endsWith('/pulls/42/merge')) {
      mergeRequested = true;
      return Response.json({ merged: true });
    }
    return Response.json({ message: 'unexpected request' }, { status: 404 });
  };

  await assert.rejects(main({
    DEFAULT_BRANCH: 'main',
    GITHUB_TOKEN: 'test-token',
    PR_NUMBER: '42',
    REPOSITORY: 'owner/repository',
    RUN_BASE_SHA: BASE_SHA,
    RUN_HEAD_SHA: HEAD_SHA,
  }, fetchImpl, () => {}), /major update requires manual review/);
  assert.equal(mergeRequested, false);
});
