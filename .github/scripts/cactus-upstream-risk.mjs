import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INITIAL_REVIEW_CHECKPOINT, UPSTREAM_REPOSITORY } from './monitor-cactus-upstream.mjs';

const shaRegex = /^[a-f0-9]{40}$/i;
const publicApiBase = 'https://api.github.com/repos/' + UPSTREAM_REPOSITORY;
const documentationCandidates = new Set(['README.md', 'README_zh.md']);

// This is a READ-ONLY PUBLIC preflight. It cannot authorize changes to a
// private repository. All candidate changes require isolated private testing.
export function assessUpstreamComparison({ baselineSha, remoteSha, comparison }) {
  if (!shaRegex.test(baselineSha || '') || !shaRegex.test(remoteSha || '')) {
    throw new Error('Invalid upstream baseline or remote commit SHA');
  }

  const base = baselineSha.toLowerCase();
  const head = remoteSha.toLowerCase();
  const result = {
    baselineSha: base,
    remoteSha: head,
    autoMergeAllowed: false,
    requiresPrivateValidation: true,
    changedPaths: [],
    reasons: []
  };

  if (base === head) {
    return { ...result, status: 'up-to-date', requiresPrivateValidation: false };
  }

  if (!comparison || typeof comparison !== 'object') {
    return { ...result, status: 'blocked', reasons: ['missing-compare-evidence'] };
  }
  if (comparison.status !== 'ahead' ||
      comparison.merge_base_commit?.sha?.toLowerCase() !== base ||
      comparison.base_commit?.sha?.toLowerCase() !== base ||
      !Number.isSafeInteger(comparison.ahead_by) ||
      comparison.ahead_by < 1 ||
      comparison.behind_by !== 0) {
    return { ...result, status: 'blocked', reasons: ['unexpected-ancestry'] };
  }
  if (!Number.isSafeInteger(comparison.total_commits) ||
      comparison.total_commits < 1 ||
      comparison.total_commits > 250) {
    return { ...result, status: 'blocked', reasons: ['unbounded-or-incomplete-commit-set'] };
  }
  const commits = comparison.commits;
  if (!Array.isArray(commits) ||
      commits.length !== comparison.total_commits ||
      commits.at(-1)?.sha?.toLowerCase() !== head) {
    return { ...result, status: 'blocked', reasons: ['commit-evidence-mismatch'] };
  }

  // GitHub Compare returns at most 300 changed files even when the actual
  // comparison includes more. At or above the limit we must fail closed.
  if (!Array.isArray(comparison.files) ||
      comparison.files.length === 0 ||
      comparison.files.length >= 300) {
    return { ...result, status: 'blocked', reasons: ['unbounded-or-incomplete-file-set'] };
  }

  const files = comparison.files;
  const seen = new Set();
  for (const file of files) {
    const name = file?.filename;
    if (typeof name !== 'string' ||
        !/^[A-Za-z0-9_./-]+$/.test(name) ||
        name.startsWith('/') ||
        name.split('/').some(segment => segment === '..' || segment === '.') ||
        seen.has(name)) {
      return { ...result, status: 'blocked', reasons: ['invalid-or-duplicate-path'] };
    }
    seen.add(name);
  }

  const paths = [...seen].sort();
  result.changedPaths = paths;

  // Never automatically allow runtime, template, stylesheet, workflow,
  // binary, dependency, translation, license, or config changes.
  if (files.some(file =>
    !documentationCandidates.has(file.filename) ||
    file.status !== 'modified' ||
    file.previous_filename !== undefined ||
    !Number.isSafeInteger(file.changes) ||
    file.changes > 200 ||
    file.changes < 0 ||
    !Number.isSafeInteger(file.additions) ||
    !Number.isSafeInteger(file.deletions)
  )) {
    return { ...result, status: 'manual-review-required', reasons: ['nontrivial-or-runtime-change'] };
  }

  // Documentation-only is merely a candidate: the private file must still
  // be unchanged from its original upstream blob, and private CI must pass.
  return {
    ...result,
    status: 'documentation-candidate',
    reasons: ['local-blob-identity-and-private-ci-required']
  };
}

async function fetchPublicJson(url, fetcher, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'linchun-cactus-read-only-risk-triage'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('Public GitHub API returned HTTP ' + response.status);
  return response.json();
}

export async function inspectPublicUpstream({
  baselineSha = process.env.CACTUS_REVIEWED_BASELINE || INITIAL_REVIEW_CHECKPOINT,
  fetcher = globalThis.fetch,
  token = process.env.GITHUB_TOKEN,
  log = console.log,
  summaryFile = process.env.GITHUB_STEP_SUMMARY
} = {}) {
  if (!shaRegex.test(baselineSha || '')) throw new Error('Invalid public baseline');
  const commit = await fetchPublicJson(publicApiBase + '/commits/master', fetcher, token);
  const remoteSha = String(commit?.sha || '').toLowerCase();
  if (!shaRegex.test(remoteSha)) throw new Error('Invalid public upstream commit');

  const comparison = baselineSha.toLowerCase() === remoteSha
    ? undefined
    : await fetchPublicJson(
      publicApiBase + '/compare/' + baselineSha + '...' + remoteSha,
      fetcher,
      token
    );
  const result = assessUpstreamComparison({ baselineSha, remoteSha, comparison });
  log(JSON.stringify(result));

  if (summaryFile) {
    const markdown = [
      '### Cactus public upstream triage',
      '',
      '- Status: ' + result.status,
      '- Upstream baseline: ' + result.baselineSha,
      '- Current upstream: ' + result.remoteSha,
      '- Changed public files: ' + result.changedPaths.length,
      '- Automatic private merge authorized: **no**',
      '- Reason: ' + (result.reasons.join(', ') || 'unchanged'),
      '',
      'This job only accesses publicly available upstream data. It does not',
      'read private source code, create private PRs, or deploy anything.',
      ''
    ].join('\n');
    appendFileSync(summaryFile, markdown + '\n');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  inspectPublicUpstream().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
