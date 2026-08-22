import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
