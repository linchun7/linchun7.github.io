import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { evaluateDocumentationChange, main, parseRawChanges } from '../scripts/validate-documentation-change.mjs';
import { validateChangedFiles, verifyActionReferences } from '../scripts/auto-merge-official-actions.mjs';

const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const MERGE = 'e'.repeat(40);
const OLD = 'c'.repeat(40);
const NEW = 'd'.repeat(40);
const WORKFLOW = '.github/workflows/update-icloud-prices.yml';
const README = 'tools/icloud_price_comparison/README.md';
const OPERATIONS = 'tools/icloud_price_comparison/OPERATIONS.md';
const bot = () => ({ login: 'dependabot[bot]', id: 49699333, type: 'Bot' });
const workflow = (sha = OLD, version = 'v6.0.0') => [
  'name: Pin fixture', 'on: push', 'permissions:', '  contents: read', 'jobs:', '  check:', '    runs-on: ubuntu-latest', '    steps:',
  '      - name: Checkout', '        uses: actions/checkout@' + sha + ' # ' + version,
  '        with:', '          persist-credentials: false', '',
].join('\n');
function file(filename = WORKFLOW) {
  return { filename, status: 'modified', oldMode: '100644', newMode: '100644', baseContent: workflow(), headContent: workflow(NEW, 'v6.1.0') };
}
function fixture() {
  return {
    repository: 'owner/repository', baseSha: BASE, headSha: HEAD, checkoutParents: [BASE, HEAD],
    event: {
      sender: bot(), repository: { full_name: 'owner/repository', default_branch: 'main' },
      pull_request: {
        state: 'open', draft: false, user: bot(),
        base: { ref: 'main', sha: BASE, repo: { full_name: 'owner/repository' } },
        head: { ref: 'dependabot/github_actions/checkout-6.1.0', sha: HEAD, repo: { full_name: 'owner/repository' } },
      },
    },
    files: [file()],
  };
}
function releaseGit(output) {
  return async (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args.slice(0, 3), ['ls-remote', '--exit-code', 'https://github.com/actions/checkout.git']);
    assert.equal(options.timeout, 30_000);
    const version = args[3].slice('refs/tags/'.length);
    return { stdout: output === undefined ? (version === 'v6.0.0' ? OLD : NEW) + '\trefs/tags/' + version + '\n' : output, stderr: '' };
  };
}
const verify = (references) => verifyActionReferences(references, releaseGit());
const evaluate = (input, verifyReferences = verify) => evaluateDocumentationChange(input, { verifyReferences });

test('exempts only verified same-major pin-only updates and verifies both old and new tags', async () => {
  const input = fixture();
  input.files.push(file('.github/workflows/validate-icloud-price-comparison.yml'));
  const observed = [];
  const result = await evaluate(input, async (references) => {
    observed.push(...references);
    await verify(references);
  });
  assert.equal(result.required, true);
  assert.equal(result.exempt, true);
  assert.deepEqual(result.missingDocs, []);
  assert.deepEqual(observed, [
    { action: 'actions/checkout', sha: OLD, version: 'v6.0.0' },
    { action: 'actions/checkout', sha: NEW, version: 'v6.1.0' },
  ]);
  assert.equal((await evaluate(fixture(), (references) => verifyActionReferences(references, async (_command, args) => ({
    stdout: 'f'.repeat(40) + '\t' + args[3] + '\n' + (args[3].endsWith('v6.0.0') ? OLD : NEW) + '\t' + args[4] + '\n',
  })))).exempt, true, 'annotated release tags are peeled by the shared resolver');
});

test('ordinary changes retain documentation requirements and never need release network access', async () => {
  const neverVerify = () => assert.fail('non-exempt changes must not query release tags');
  const ordinary = fixture();
  ordinary.event.sender = { login: 'maintainer' };
  ordinary.files[0].headContent += '        run: echo changed\n';
  for (const missing of [[README, OPERATIONS], [OPERATIONS], []]) {
    const input = structuredClone(ordinary);
    for (const filename of [README, OPERATIONS].filter((name) => !missing.includes(name))) input.files.push(file(filename));
    const result = await evaluate(input, neverVerify);
    assert.equal(result.exempt, false);
    assert.deepEqual(result.missingDocs, missing);
  }
  const noncritical = fixture();
  noncritical.files = [file('tools/icloud_price_comparison/style.css')];
  assert.equal((await evaluate(noncritical, neverVerify)).required, false);
  const deletedGuide = structuredClone(ordinary);
  deletedGuide.files.push({ ...file(README), status: 'D', newMode: '000000' }, file(OPERATIONS));
  assert.deepEqual((await evaluate(deletedGuide, neverVerify)).missingDocs, [README]);
  const gateChange = fixture();
  gateChange.files = [file('tools/icloud_price_comparison/scripts/validate-documentation-change.mjs')];
  assert.equal((await evaluate(gateChange, neverVerify)).required, true, 'the extracted gate remains a critical architecture path');
});

test('fake authors, sender impersonation, foreign forks, branches, SHAs and merge bindings receive no exception', async () => {
  for (const mutate of [
    (i) => { i.event.pull_request.user.login = 'dependabot'; },
    (i) => { i.event.pull_request.user.id = 123; },
    (i) => { i.event.pull_request.user.type = 'User'; },
    (i) => { i.event.sender = { login: 'dependabot[bot]', type: 'Bot', id: 123 }; },
    (i) => { delete i.event.sender; },
    (i) => { i.event.pull_request.state = 'closed'; },
    (i) => { i.event.pull_request.draft = true; },
    (i) => { i.event.repository.full_name = 'foreign/repository'; },
    (i) => { i.event.pull_request.head.repo.full_name = 'foreign/fork'; },
    (i) => { i.event.pull_request.base.repo.full_name = 'foreign/repository'; },
    (i) => { i.event.pull_request.base.ref = 'release'; },
    (i) => { i.event.pull_request.head.ref = 'dependabot/npm_and_yarn/checkout'; },
    (i) => { i.event.pull_request.base.sha = MERGE; },
    (i) => { i.event.pull_request.head.sha = MERGE; },
    (i) => { i.checkoutParents = [HEAD, BASE]; },
    (i) => { i.checkoutParents = [BASE]; },
    (i) => { i.checkoutParents = [BASE, HEAD, MERGE]; },
  ]) {
    const input = fixture();
    mutate(input);
    const result = await evaluate(input, () => assert.fail('untrusted identity must not query official tags'));
    assert.equal(result.exempt, false, mutate.toString());
    assert.deepEqual(result.missingDocs, [README, OPERATIONS]);
    assert.match(result.reason, /^No documentation exception:/);
  }
});

test('command, permission, indentation, comments and other byte changes cannot hide inside pin updates', async () => {
  for (const mutate of [
    (f) => { f.headContent = f.headContent.replace('contents: read', 'contents: write'); },
    (f) => { f.headContent = f.headContent.replace('persist-credentials: false', 'persist-credentials: true'); },
    (f) => { f.headContent += '      - run: curl https://example.invalid\n'; },
    (f) => { f.headContent = f.headContent.replace('        uses:', '      uses:'); },
    (f) => { f.headContent = f.headContent.replace(' # v6.1.0', '  # v6.1.0'); },
    (f) => { f.headContent = f.headContent.replace('v6.1.0', 'v6.1.0; run: bad'); },
    (f) => { f.headContent = f.headContent.slice(0, -1); },
    (f) => { f.headContent = f.headContent.replace('actions/checkout', 'actions/setup-node'); },
    (f) => { f.status = 'added'; },
    (f) => { f.newMode = '100755'; },
    (f) => { f.oldMode = '120000'; },
    (f) => { f.filename = 'tools/icloud_price_comparison/scripts/update-prices.mjs'; },
  ]) {
    const input = fixture();
    mutate(input.files[0]);
    const result = await evaluate(input, () => assert.fail('broader diffs must not query tags'));
    assert.equal(result.exempt, false, mutate.toString());
  }
  for (const extra of [
    file('tools/icloud_price_comparison/data-model.js'),
    { ...file('.github/workflows/added.yml'), status: 'A', oldMode: '000000' },
    { ...file('.github/workflows/deleted.yml'), status: 'D', newMode: '000000' },
    { ...file('.github/workflows/unchanged-content.yml'), headContent: workflow() },
    { ...file('.github/workflows/another-action.yml'), baseContent: workflow().replaceAll('actions/checkout', 'actions/setup-node'), headContent: workflow(NEW, 'v6.1.0').replaceAll('actions/checkout', 'actions/setup-node') },
  ]) {
    const input = fixture();
    input.files.push(extra);
    assert.equal((await evaluate(input, () => assert.fail('extra changes must fail before release verification'))).exempt, false);
  }
  const excessive = fixture();
  excessive.files = Array.from({ length: 21 }, (_, index) => file(index === 0 ? WORKFLOW : '.github/workflows/test-' + index + '.yml'));
  assert.equal((await evaluate(excessive)).exempt, false);
});

test('rollback, same version, major, prerelease, mutable pins and third-party Actions never receive an exception', async () => {
  for (const mutate of [
    (f) => { f.baseContent = workflow(OLD, 'v6.2.0'); },
    (f) => { f.headContent = workflow(NEW, 'v6.0.0'); },
    (f) => { f.headContent = workflow(NEW, 'v7.0.0'); },
    (f) => { f.headContent = workflow(NEW, 'v6.1.0-beta.1'); },
    (f) => { f.headContent = workflow('v6', 'v6.1.0'); },
    (f) => { f.headContent = workflow(OLD, 'v6.1.0'); },
    (f) => { f.baseContent = f.baseContent.replace('actions/checkout', 'third-party/checkout'); f.headContent = f.headContent.replace('actions/checkout', 'third-party/checkout'); },
  ]) {
    const input = fixture();
    mutate(input.files[0]);
    const result = await evaluate(input, () => assert.fail('invalid pins must not query tags'));
    assert.equal(result.exempt, false, mutate.toString());
  }
});

test('unresolvable, malformed or mismatched SHAs and release-network failures fall back to required guides with a reason', async () => {
  for (const runGit of [
    async () => { throw new Error('release network timed out'); },
    releaseGit(''),
    releaseGit('not-a-sha\trefs/tags/v6.0.0\n'),
    releaseGit(NEW + '\trefs/tags/v6.0.0\n'),
    releaseGit(OLD + '\trefs/tags/unexpected\n'),
    async (_command, args) => ({ stdout: (args[3].endsWith('v6.0.0') ? OLD : OLD) + '\t' + args[3] + '\n' }),
  ]) {
    const result = await evaluate(fixture(), (references) => verifyActionReferences(references, runGit));
    assert.equal(result.exempt, false);
    assert.deepEqual(result.missingDocs, [README, OPERATIONS]);
    assert.match(result.reason, /No documentation exception: .+/);
  }
});

test('raw Git changes are complete, NUL-delimited and preserve filenames and mode changes', () => {
  const raw = ':100644 100755 ' + OLD + ' ' + NEW + ' M\0a\nb.yml\0';
  assert.deepEqual(parseRawChanges(raw), [{ filename: 'a\nb.yml', oldMode: '100644', newMode: '100755', status: 'modified' }]);
  assert.deepEqual(parseRawChanges(''), []);
  assert.throws(() => parseRawChanges(raw.slice(0, -1)), /incomplete/);
  assert.throws(() => parseRawChanges(':bad\0file\0'), /invalid/);
});

test('CLI compares and reads the tested merge tree, binds its parents, and runs the shared real release validator', async () => {
  const input = fixture();
  const requests = [];
  const logs = [];
  const env = {
    BASE_SHA: BASE, HEAD_SHA: HEAD, GITHUB_SHA: MERGE,
    GITHUB_REPOSITORY: input.repository, GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_EVENT_PATH: '/event.json',
  };
  const git = async (command, args, options) => {
    requests.push(args);
    if (args[0] === 'diff') return { stdout: ':100644 100644 ' + OLD + ' ' + NEW + ' M\0' + WORKFLOW + '\0' };
    if (args[0] === 'show' && args[1] === '-s') return { stdout: BASE + ' ' + HEAD + '\n' };
    if (args[0] === 'show') {
      assert.ok([BASE + ':' + WORKFLOW, MERGE + ':' + WORKFLOW].includes(args[1]), 'content must come from exact Git objects, never the working tree or an out-of-date PR tree');
      return { stdout: args[1].startsWith(BASE) ? workflow() : workflow(NEW, 'v6.1.0') };
    }
    return releaseGit()(command, args, options);
  };
  const readEvent = async (path, encoding) => {
    assert.equal(path, '/event.json');
    assert.equal(encoding, 'utf8');
    return JSON.stringify(input.event);
  };
  const result = await main(env, git, readEvent, (message) => logs.push(message));
  assert.equal(result.exempt, true);
  assert.deepEqual(requests[0], ['diff', '--raw', '--no-abbrev', '--no-renames', '-z', BASE, MERGE]);
  assert.match(logs.join('\n'), /Verified same-major/);
  const untrusted = structuredClone(input.event);
  untrusted.pull_request.user.id = 123;
  await assert.rejects(main(env, git, async () => JSON.stringify(untrusted), () => {}), /without required documentation update/);
  await assert.rejects(main({ ...env, GITHUB_EVENT_NAME: 'push' }, git, readEvent), /pull_request/);
  await assert.rejects(main({ ...env, HEAD_SHA: 'main' }, git, readEvent), /Exact base\/head\/checkout SHAs/);
});

const readHistoricalFixture = async () => JSON.parse(await readFile(new URL('./fixtures/dependabot-195-action-pins.json', import.meta.url), 'utf8'));

test('replays all seven actual PR #195 pin-only patches, including real list shorthand and release refs', async () => {
  const historical = await readHistoricalFixture();
  assert.equal(historical.files.length, 7);
  assert.equal(validateChangedFiles(historical.files), 19);
  assert.equal(historical.files.some(({ filename }) => filename.endsWith('README.md') || filename.endsWith('OPERATIONS.md')), false);
  // These excerpts preserve the actual patch bytes. Full original Git trees
  // and live official tags are checked separately on Actions below.
  const excerpt = (patch, marker) => patch.split('\n').filter((line) => line.startsWith(' ') || line.startsWith(marker)).map((line) => line.slice(1)).join('\n');
  const files = historical.files.map((file) => ({
    ...file, oldMode: '100644', newMode: '100644',
    baseContent: excerpt(file.patch, '-'), headContent: excerpt(file.patch, '+'),
  }));
  const result = await evaluateDocumentationChange({
    repository: historical.reconstructedEvent.repository.full_name,
    event: historical.reconstructedEvent, baseSha: historical.baseSha, headSha: historical.headSha,
    checkoutParents: [historical.baseSha, historical.headSha], files,
  }, {
    verifyReferences: async (references) => assert.deepEqual(references, historical.references),
  });
  assert.equal(result.exempt, true);
});

test('opt-in research verifies actual historical Git merge bytes and both live official release tags read-only', {
  skip: process.env.VERIFY_HISTORICAL_ACTION_TAGS !== 'true', timeout: 120_000,
}, async () => {
  const historical = await readHistoricalFixture();
  const runGit = promisify(execFile);
  await runGit('git', ['fetch', '--no-tags', 'origin', historical.baseSha, historical.headSha, historical.checkoutSha], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const result = await main({
    BASE_SHA: historical.baseSha, HEAD_SHA: historical.headSha, GITHUB_SHA: historical.checkoutSha,
    GITHUB_REPOSITORY: historical.reconstructedEvent.repository.full_name,
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'reconstructed-fixture-only',
  }, runGit, async (path) => {
    assert.equal(path, 'reconstructed-fixture-only');
    return JSON.stringify(historical.reconstructedEvent);
  }, () => {});
  assert.equal(result.exempt, true, result.reason);
  assert.deepEqual(result.missingDocs, []);
});

test('default regression validates complete merge-tree bytes in an isolated local Git fixture without network', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'icloud-documentation-git-'));
  const execute = promisify(execFile);
  const git = async (...args) => (await execute('git', args, { cwd: directory, encoding: 'utf8', timeout: 10_000 })).stdout;
  try {
    await git('init', '--initial-branch=main');
    await git('config', 'user.name', 'Documentation gate test');
    await git('config', 'user.email', 'documentation-gate@example.invalid');
    await git('config', 'commit.gpgsign', 'false');
    const filenames = [WORKFLOW, '.github/workflows/validate-chatgpt-prices.yml'];
    const writeWorkflows = async (sha, version) => {
      for (const [index, filename] of filenames.entries()) {
        const destination = join(directory, filename);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, index === 0 ? workflow(sha, version) : workflow(sha, version).replace('      - name: Checkout\n        uses:', '      - uses:'), 'utf8');
      }
    };
    await writeWorkflows(OLD, 'v6.0.0');
    await git('add', '.');
    await git('commit', '-qm', 'base fixture');
    const base = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', '-b', 'pin-update');
    await writeWorkflows(NEW, 'v6.1.0');
    await git('add', '.');
    await git('commit', '-qm', 'pin-only fixture');
    const head = (await git('rev-parse', 'HEAD')).trim();
    await git('checkout', 'main');
    await git('merge', '--no-ff', '--no-edit', 'pin-update');
    const merge = (await git('rev-parse', 'HEAD')).trim();
    const input = fixture();
    input.event.pull_request.base.sha = base;
    input.event.pull_request.head.sha = head;
    const requests = [];
    const result = await main({
      BASE_SHA: base, HEAD_SHA: head, GITHUB_SHA: merge,
      GITHUB_REPOSITORY: input.repository, GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: 'local-fixture',
    }, async (command, args, options) => {
      requests.push(args);
      if (args[0] === 'ls-remote') return releaseGit()(command, args, options);
      return execute(command, args, { ...options, cwd: directory });
    }, async () => JSON.stringify(input.event), () => {});
    assert.equal(result.exempt, true, result.reason);
    assert.equal(requests.filter(([command]) => command === 'ls-remote').length, 2, 'only the injected fixed official-tag responses are used; no remote is configured or contacted');
    assert.ok(requests.some((args) => args[0] === 'diff' && args.at(-1) === merge));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
