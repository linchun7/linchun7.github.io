import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { regeneratePlaywrightLock, validatePlaywrightManifestUpdate, validatePlaywrightDependencyUpdate } from './dependency-policy.mjs';

const currentManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const manifest = { ...currentManifest, devDependencies: { playwright: '1.63.0' } };
const base = () => structuredClone(manifest);
const head = () => ({ ...base(), devDependencies: { playwright: '1.64.0' } });

test('allows only one stable same-major forward Playwright pin', () => {
  assert.deepEqual(validatePlaywrightManifestUpdate(base(), head()), { before: '1.63.0', after: '1.64.0' });
  for (const mutate of [
    p => { p.devDependencies.playwright = '2.0.0'; },
    p => { p.devDependencies.playwright = '^1.64.0'; },
    p => { p.devDependencies.playwright = '1.64.0-beta.1'; },
    p => { p.devDependencies.playwright = '1.62.0'; },
    p => { p.devDependencies.playwright = '1.63.0'; },
    p => { p.devDependencies.extra = '1.0.0'; },
    p => { p.scripts['test:browser-matrix'] = 'echo bypass'; },
    p => { p.packageManager = 'pnpm@11.0.0'; },
    p => { p.pnpm = { overrides: { 'playwright-core': 'file:evil' } }; },
    p => { p.dependencies = { extra: '1.0.0' }; },
  ]) {
    const value = head();
    mutate(value);
    assert.throws(() => validatePlaywrightManifestUpdate(base(), value));
  }
});

test('compares the complete lock, including dependency graph, registry, scripts and integrity', async () => {
  const expected = 'official lock\n  integrity: sha512-verified\n';
  const regenerate = async value => {
    assert.equal(value.devDependencies.playwright, '1.64.0');
    return expected;
  };
  await validatePlaywrightDependencyUpdate(base(), head(), expected, regenerate);
  for (const alteration of [
    'extra-package@1.0.0:\n', 'scripts: run-evil\n',
    'registry: https://example.invalid/\n', 'integrity: sha512-forged\n',
    'settings: changed\n',
  ]) {
    await assert.rejects(validatePlaywrightDependencyUpdate(base(), head(), expected + alteration, regenerate), /does not match/);
  }
  await assert.rejects(validatePlaywrightDependencyUpdate(base(), head(), expected,
    async () => { throw new Error('registry unavailable'); }), /registry unavailable/);
});

test('regenerates without candidate lock/config/scripts or merge credentials and cleans temporary files', async () => {
  let directory;
  const actual = await regeneratePlaywrightLock(head(), async (command, args, options) => {
    directory = options.cwd;
    assert.equal(command, 'corepack');
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('--ignore-pnpmfile'));
    assert.ok(args.includes('--registry=https://registry.npmjs.org/'));
    assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.equal(options.env.NODE_OPTIONS, undefined);
    assert.equal(options.env.HOME, directory);
    const input = JSON.parse(await readFile(directory + '/package.json', 'utf8'));
    assert.deepEqual(input, { private: true, packageManager: manifest.packageManager, devDependencies: { playwright: '1.64.0' } });
    await assert.rejects(readFile(directory + '/pnpm-lock.yaml'));
    await writeFile(directory + '/pnpm-lock.yaml', 'official lock\n');
  });
  assert.equal(actual, 'official lock\n');
  await assert.rejects(readFile(directory + '/package.json'));
});

test('real pinned pnpm reproduces the committed and normally generated candidate lock', {
  skip: process.env.VERIFY_PNPM_ROUNDTRIP !== '1',
}, async () => {
  const committed = await readFile(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8');
  const generated = await regeneratePlaywrightLock(currentManifest);
  assert.equal(generated, committed);
  const [major, minor, patch] = currentManifest.devDependencies.playwright.split('.').map(Number);
  if (minor > 0 || patch > 0) {
    const prior = { ...currentManifest, devDependencies: {
      playwright: minor > 0 ? major + '.' + (minor - 1) + '.0' : major + '.0.' + (patch - 1),
    } };
    await validatePlaywrightDependencyUpdate(prior, currentManifest, generated);
  }
});
