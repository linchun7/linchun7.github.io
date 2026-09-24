import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateAppleSnapshotStore } from '../scripts/update-prices.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('deeply parses every committed Apple snapshot revision', async () => {
  const [history, currentData] = await Promise.all([
    readFile(path.join(projectDir, 'data/history.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectDir, 'data/prices.json'), 'utf8').then(JSON.parse)
  ]);
  const index = await validateAppleSnapshotStore({
    snapshotsDir: path.join(projectDir, 'data/apple-snapshots'),
    snapshotIndexPath: path.join(projectDir, 'data/apple-snapshots/index.json'),
    history,
    currentData,
    deep: true
  });
  assert.ok(index.snapshots.length > 0);
});
