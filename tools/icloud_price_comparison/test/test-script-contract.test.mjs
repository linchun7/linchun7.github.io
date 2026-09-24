import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageUrl = new URL('../package.json', import.meta.url);

test('keeps post-update data validation complete', async () => {
  const packageJson = await readFile(packageUrl, 'utf8').then(JSON.parse);
  const dataScript = packageJson.scripts?.['test:data'];

  assert.equal(typeof dataScript, 'string');
  for (const requiredTest of [
    'test/data-contract.test.mjs',
    'test/data-integrity.test.mjs',
    'test/state-contract.test.mjs'
  ]) {
    assert.ok(
      dataScript.split(/\s+/).includes(requiredTest),
      `test:data must include ${requiredTest}`
    );
  }
});

test('keeps one forced-colors implementation and no hidden test imports', async () => {
  const packageJson = await readFile(packageUrl, 'utf8').then(JSON.parse);
  const [ui, descending, runner] = await Promise.all([
    readFile(new URL('./ui-smoke.test.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./static-descending-url-state.test.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/test-browsers.mjs', import.meta.url), 'utf8')
  ]);
  assert.equal(packageJson.scripts['test:ui'], 'node --test --test-concurrency=1 test/ui-smoke.test.mjs');
  assert.equal((ui.match(/test\('preserves sorting and minimum-price cues in forced-colors mode'/g) || []).length, 1);
  assert.doesNotMatch(runner, /test-skip-pattern|LEGACY_FORCED_COLORS/);
  assert.doesNotMatch(descending, /import\s+['"][^'"]+\.test\.mjs['"]/);
  for (const browser of ['firefox', 'webkit']) {
    const alias = await readFile(new URL(`../scripts/test-${browser}.mjs`, import.meta.url), 'utf8');
    assert.ok(alias.includes("import('../test/ui-smoke.test.mjs')"));
    assert.ok(alias.includes("import('../test/static-descending-url-state.test.mjs')"));
  }
  await assert.rejects(readFile(new URL('./forced-colors-smoke.test.mjs', import.meta.url)), { code: 'ENOENT' });
});

test('a missing browser fails promptly without leaving the test server alive', { timeout: 15_000 }, async () => {
  const emptyBrowsers = await mkdtemp(join(tmpdir(), 'icloud-missing-browser-'));
  try {
    // A deliberately empty browser directory makes launch fail without network access.
    const env = { ...process.env, PLAYWRIGHT_BROWSER: 'firefox', PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers };
    // This standalone child must report text, not inherit the parent's binary test protocol.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./static-descending-url-state.test.mjs', import.meta.url))
    ], {
      env,
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(result.error, undefined, `child must exit itself, not require termination: ${result.error?.message}`);
    assert.equal(result.status, 1, 'a missing browser must fail, not skip or pass');
    assert.match(`${result.stdout}\n${result.stderr}`, /Executable doesn't exist/);
  } finally {
    await rm(emptyBrowsers, { recursive: true, force: true });
  }
});
