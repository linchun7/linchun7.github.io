import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dependencyOnlyScope, validationScope, parseRawDiff, isDependencyFileSet } from './validation-scope.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), MERGE = 'c'.repeat(40), ANCESTOR = 'd'.repeat(40);
const PACKAGE = 'tools/chatgpt_price_comparison/package.json';
const LOCK = 'tools/chatgpt_price_comparison/pnpm-lock.yaml';
const currentManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = { ...currentManifest, devDependencies: { playwright: '1.63.0' } };
const candidate = { ...manifest, devDependencies: { playwright: '1.64.0' } };
const event = () => ({
  repository: { full_name: 'owner/repository', default_branch: 'main' },
  pull_request: {
    user: { login: 'dependabot[bot]', type: 'Bot' },
    base: { sha: BASE, ref: 'main', repo: { full_name: 'owner/repository' } },
    head: { sha: HEAD, ref: 'dependabot/npm_and_yarn/tools/chatgpt_price_comparison/playwright-1.64.0', repo: { full_name: 'owner/repository' } },
  },
});
const record = (path, mode = '100644', status = 'M') => ':100644 ' + mode + ' ' + BASE + ' ' + HEAD + ' ' + status + '\0' + path + '\0';
const raw = () => record(PACKAGE) + record(LOCK);

function options(overrides = {}) {
  return {
    repository: 'owner/repository', checkoutSha: MERGE,
    regenerate: async () => 'official lock\n',
    git: args => {
      if (args[0] === 'rev-parse') return MERGE + '\n';
      if (args[0] === 'rev-list') return [MERGE, BASE, HEAD].join(' ') + '\n';
      if (args[0] === 'merge-base') return ANCESTOR + '\n';
      if (args[0] === 'diff') {
        assert.deepEqual(args, ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', ANCESTOR, HEAD, '--']);
        return raw();
      }
      if (args[0] === 'show' && args[1] === ANCESTOR + ':' + PACKAGE) return JSON.stringify(manifest);
      if (args[0] === 'show' && args[1] === HEAD + ':' + PACKAGE) return JSON.stringify(candidate);
      if (args[0] === 'show' && args[1] === HEAD + ':' + LOCK) return 'official lock\n';
      throw new Error('unexpected Git request ' + JSON.stringify(args));
    },
    ...overrides,
  };
}

test('only exact modified manifest+lock regular files qualify, with NUL-safe complete Git records', () => {
  assert.equal(isDependencyFileSet(parseRawDiff(raw())), true);
  for (const diff of [
    record(LOCK), raw() + record('tools/chatgpt_price_comparison/scripts/pipeline.py'),
    raw() + record('.npmrc'), raw() + record('strange\nfilename'),
    record(PACKAGE, '120000') + record(LOCK),
    record(PACKAGE, '100755') + record(LOCK),
    record(PACKAGE, '100644', 'A') + record(LOCK),
    record(PACKAGE) + record(PACKAGE),
  ]) assert.equal(isDependencyFileSet(parseRawDiff(diff)), false);
  for (const diff of [raw().slice(0, -1), 'partial\0', ':100644 100644 ' + BASE + ' ' + HEAD + ' R100\0old\0new\0']) {
    assert.throws(() => parseRawDiff(diff));
  }
});

test('accepts a genuine same-repository dependency PR bound to its base/head checkout', async () => {
  assert.equal(await dependencyOnlyScope(event(), options()), true);
});

test('author lookalikes, forks, wrong branches and base/head bindings retain live validation', async () => {
  for (const mutate of [
    e => { e.pull_request.user.login = 'dependabot'; },
    e => { e.pull_request.user.type = 'User'; },
    e => { e.pull_request.head.repo.full_name = 'fork/repository'; },
    e => { e.pull_request.base.repo.full_name = 'other/repository'; },
    e => { e.pull_request.head.ref = 'dependabot/npm_and_yarn/tools/browser-tests/playwright-1.64.0'; },
    e => { e.pull_request.base.ref = 'other'; },
    e => { e.pull_request.head.sha = 'e'.repeat(40); },
    e => { e.pull_request.base.sha = 'f'.repeat(40); },
    e => { e.pull_request.head.sha = '--option'; },
    e => { e.repository.full_name = 'other/repository'; },
  ]) {
    const value = event(); mutate(value);
    assert.equal((await validationScope(value, options())).dependencyOnly, false);
  }
  assert.equal((await validationScope(event(), options({ checkoutSha: HEAD }))).dependencyOnly, false);
  assert.equal((await validationScope({}, options())).dependencyOnly, false);
});

test('code/config changes, malformed evidence, scripts/registry/integrity edits and network failure retain live validation', async () => {
  const normal = options().git;
  for (const git of [
    args => args[0] === 'diff' ? raw() + record('tools/chatgpt_price_comparison/scripts/pipeline.py') : normal(args),
    args => args[0] === 'diff' ? raw().slice(0, -1) : normal(args),
    args => args[0] === 'show' && args[1] === HEAD + ':' + PACKAGE ? '{invalid' : normal(args),
    args => args[0] === 'show' && args[1] === HEAD + ':' + PACKAGE ? JSON.stringify({ ...candidate, scripts: { bypass: 'true' } }) : normal(args),
    args => args[0] === 'show' && args[1] === HEAD + ':' + LOCK ? 'forged registry/integrity/extra dependency' : normal(args),
    () => { throw new Error('Git unavailable'); },
  ]) assert.equal((await validationScope(event(), options({ git }))).dependencyOnly, false);
  assert.equal((await validationScope(event(), options({
    regenerate: async () => { throw new Error('npm unavailable'); },
  }))).dependencyOnly, false);
});
