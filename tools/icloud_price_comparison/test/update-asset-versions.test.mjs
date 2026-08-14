import assert from 'node:assert/strict';
import { appendFile, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeAssetUpdates, updateAssetVersions } from '../scripts/update-asset-versions.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('content hashes cover direct and transitive browser assets in check and write modes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-assets-'));
  try {
    for (const name of ['index.html', 'script.js', 'data-contract.js', 'data-model.js', 'price-bootstrap.js', 'style.css']) {
      await cp(path.join(PROJECT_DIR, name), path.join(root, name));
    }
    await cp(path.join(PROJECT_DIR, 'vendor'), path.join(root, 'vendor'), { recursive: true });
    await assert.doesNotReject(updateAssetVersions({ projectDir: root, check: true }));

    await appendFile(path.join(root, 'data-model.js'), '\n// hash invalidation fixture\n', 'utf8');
    await assert.rejects(
      updateAssetVersions({ projectDir: root, check: true }),
      /Static asset versions are stale.*data-contract\.js.*script\.js.*index\.html/
    );
    await updateAssetVersions({ projectDir: root });
    await assert.doesNotReject(updateAssetVersions({ projectDir: root, check: true }));

    const { versions } = await computeAssetUpdates(root);
    const html = await readFile(path.join(root, 'index.html'), 'utf8');
    const script = await readFile(path.join(root, 'script.js'), 'utf8');
    const contract = await readFile(path.join(root, 'data-contract.js'), 'utf8');
    assert.match(html, new RegExp(`script\\.js\\?v=${versions['script.js']}`));
    assert.match(script, new RegExp(`data-contract\\.js\\?v=${versions['data-contract.js']}`));
    assert.match(contract, new RegExp(`data-model\\.js\\?v=${versions['data-model.js']}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
