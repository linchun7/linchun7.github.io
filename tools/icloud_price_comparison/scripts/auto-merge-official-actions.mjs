import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_LINE_PATTERN = /^([+-])\s*uses:\s*(actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([a-f0-9]{40})\s+#\s+v[0-9][A-Za-z0-9._+-]*\s*$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePullRequest(pr, expected) {
  invariant(pr.state === 'open' && !pr.draft, 'Pull request must be open and ready');
  invariant(pr.user?.login === 'dependabot[bot]', 'Pull request author must be dependabot[bot]');
  invariant(pr.base?.ref === expected.defaultBranch, 'Pull request must target the default branch');
  invariant(pr.base?.sha === expected.baseSha, 'Base SHA changed after validation');
  invariant(pr.head?.sha === expected.headSha, 'Head SHA changed after validation');
  invariant(pr.head?.repo?.full_name === expected.repository, 'Dependabot branch must belong to this repository');
  invariant(pr.head?.ref?.startsWith('dependabot/github_actions/'), 'Pull request must be a GitHub Actions update');
}

export function validateChangedFiles(files) {
  invariant(files.length > 0, 'Pull request must contain at least one changed file');

  let changedReferenceCount = 0;
  for (const file of files) {
    invariant(WORKFLOW_PATH_PATTERN.test(file.filename), 'Only GitHub workflow files may change: ' + file.filename);
    invariant(file.status === 'modified' && !file.previous_filename, 'Workflow files may only be modified: ' + file.filename);
    invariant(typeof file.patch === 'string', 'GitHub must provide a complete patch for ' + file.filename);

    const changedLines = file.patch
      .split('\n')
      .filter((line) => (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)));
    invariant(changedLines.length === file.changes, 'Patch is incomplete for ' + file.filename);

    const oldReferences = [];
    const newReferences = [];
    for (const line of changedLines) {
      const match = line.match(ACTION_LINE_PATTERN);
      invariant(match, 'Only full-SHA actions/* references may change in ' + file.filename);
      const reference = { action: match[2], sha: match[3] };
      (match[1] === '-' ? oldReferences : newReferences).push(reference);
    }

    invariant(oldReferences.length > 0, 'Workflow update must replace an existing Action reference');
    invariant(oldReferences.length === newReferences.length, 'Action replacements must be one-for-one');
    const oldActions = oldReferences.map(({ action }) => action).sort();
    const newActions = newReferences.map(({ action }) => action).sort();
    invariant(JSON.stringify(oldActions) === JSON.stringify(newActions), 'Action names must not change');

    const oldDigests = oldReferences.map(({ action, sha }) => action + '@' + sha).sort();
    const newDigests = newReferences.map(({ action, sha }) => action + '@' + sha).sort();
    invariant(JSON.stringify(oldDigests) !== JSON.stringify(newDigests), 'At least one Action SHA must change');
    changedReferenceCount += newReferences.length;
  }

  return changedReferenceCount;
}

async function githubRequest(repository, token, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.github.com/repos/' + repository + path, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('GitHub API ' + response.status + ': ' + (body.message || path));
  }
  return body;
}

async function readPullRequestFiles(repository, token, pullNumber, fetchImpl) {
  const files = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubRequest(repository, token, '/pulls/' + pullNumber + '/files?per_page=100&page=' + page, {}, fetchImpl);
    files.push(...batch);
    if (batch.length < 100) return files;
  }
}

export async function main(env = process.env, fetchImpl = fetch, log = console.log) {
  const {
    DEFAULT_BRANCH: defaultBranch,
    GITHUB_TOKEN: token,
    PR_NUMBER: pullNumberText,
    REPOSITORY: repository,
    RUN_BASE_SHA: baseSha,
    RUN_HEAD_SHA: headSha,
  } = env;
  const pullNumber = Number(pullNumberText);

  invariant(token, 'GITHUB_TOKEN is required');
  invariant(/^[^/]+\/[^/]+$/.test(repository || ''), 'REPOSITORY must be owner/name');
  invariant(defaultBranch, 'DEFAULT_BRANCH is required');
  invariant(Number.isSafeInteger(pullNumber) && pullNumber > 0, 'PR_NUMBER must be a positive integer');
  invariant(SHA_PATTERN.test(baseSha || ''), 'RUN_BASE_SHA must be a full SHA');
  invariant(SHA_PATTERN.test(headSha || ''), 'RUN_HEAD_SHA must be a full SHA');

  const pullRequest = await githubRequest(repository, token, '/pulls/' + pullNumber, {}, fetchImpl);
  validatePullRequest(pullRequest, { repository, defaultBranch, baseSha, headSha });

  const files = await readPullRequestFiles(repository, token, pullNumber, fetchImpl);
  invariant(files.length === pullRequest.changed_files, 'Changed-file list is incomplete');
  const referenceCount = validateChangedFiles(files);

  const result = await githubRequest(repository, token, '/pulls/' + pullNumber + '/merge', {
    method: 'PUT',
    body: JSON.stringify({
      commit_title: 'chore: update official GitHub Actions (#' + pullNumber + ')',
      merge_method: 'squash',
      sha: headSha,
    }),
  }, fetchImpl);
  invariant(result.merged === true, result.message || 'GitHub did not merge the pull request');
  log('Merged Dependabot PR #' + pullNumber + ' after validating ' + referenceCount + ' official Action reference(s).');
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
