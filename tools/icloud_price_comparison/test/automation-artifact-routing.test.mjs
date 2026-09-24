import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { requiredActionValidationWorkflows } from '../scripts/auto-merge-official-actions.mjs';

const ICLOUD_WORKFLOW = 'Validate iCloud price comparison';
const ARTIFACT_WORKFLOW = 'Validate Action artifact roundtrip';
const autoMergeWorkflowUrl = new URL('../../../.github/workflows/auto-merge-official-actions.yml', import.meta.url);
const artifactWorkflowUrl = new URL('../../../.github/workflows/validate-action-artifact-roundtrip.yml', import.meta.url);

function actionChange(action) {
  return {
    filename: '.github/workflows/example.yml',
    patch: [
      '@@ -1 +1 @@',
      `-        uses: actions/${action}@${'a'.repeat(40)} # v1.0.0`,
      `+        uses: actions/${action}@${'b'.repeat(40)} # v1.1.0`,
    ].join('\n'),
  };
}

test('artifact validation routing uses the actual PR diff instead of Dependabot branch naming', async () => {
  const [autoMerge, artifact] = await Promise.all([
    readFile(autoMergeWorkflowUrl, 'utf8'),
    readFile(artifactWorkflowUrl, 'utf8'),
  ]);

  assert.match(artifact, /startsWith\(github\.head_ref, 'dependabot\/github_actions\/'\)/);
  assert.match(autoMerge, /\/pulls\/\$\{PR_NUMBER\}\/files\?per_page=100/);
  assert.match(autoMerge, /\['upload-artifact', 'download-artifact'\]/);
  assert.doesNotMatch(autoMerge, /contains\(github\.event\.workflow_run\.head_branch, '(?:upload-artifact|download-artifact)'\)/);
  assert.match(autoMerge, /should_run=false/);
});

test('artifact roundtrip becomes required only for upload/download Action diffs', () => {
  assert.deepEqual(requiredActionValidationWorkflows([actionChange('checkout')]), [ICLOUD_WORKFLOW]);
  assert.deepEqual(requiredActionValidationWorkflows([actionChange('upload-artifact')]), [ICLOUD_WORKFLOW, ARTIFACT_WORKFLOW]);
  assert.deepEqual(requiredActionValidationWorkflows([actionChange('download-artifact')]), [ICLOUD_WORKFLOW, ARTIFACT_WORKFLOW]);
});
