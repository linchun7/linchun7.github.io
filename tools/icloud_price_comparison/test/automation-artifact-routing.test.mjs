import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const artifactWorkflowUrl = new URL('../../../.github/workflows/validate-action-artifact-roundtrip.yml', import.meta.url);

test('artifact validation routing uses the actual PR diff instead of Dependabot branch naming', async () => {
  const [autoMerge, artifact] = await Promise.all([
    readFile(autoMergeWorkflowUrl, 'utf8'),
    readFile(artifactWorkflowUrl, 'utf8'),
  ]);

  assert.match(artifact, /startsWith\(github\.head_ref, 'dependabot\/github_actions\/'\)/);
  assert.match(autoMerge, /\/pulls\/\$\{PR_NUMBER\}\/files\?per_page=100/);
  assert.match(autoMerge, /actions\\\/(?:upload-artifact\|download-artifact)|upload-artifact\|download-artifact/);
  assert.doesNotMatch(autoMerge, /contains\(github\.event\.workflow_run\.head_branch, '(?:upload-artifact|download-artifact)'\)/);
  assert.match(autoMerge, /should_run=false/);
});
