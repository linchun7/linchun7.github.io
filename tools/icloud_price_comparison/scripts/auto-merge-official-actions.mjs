import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const ACTION_LINE_PATTERN = /^([+-])\s*uses:\s*(actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([a-f0-9]{40})\s+#\s+(v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\s*$/;
const ACTION_STABLE_SEMVER_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;
const NPM_BRANCH_PREFIX = 'dependabot/npm_and_yarn/tools/icloud_price_comparison/';
const NPM_PACKAGE_PATH = 'tools/icloud_price_comparison/package.json';
const NPM_LOCK_PATH = 'tools/icloud_price_comparison/pnpm-lock.yaml';
const STABLE_SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_CHANGED_FILES = 20;
const MAX_ACTION_REFERENCES = 100;
const execFileAsync = promisify(execFile);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateCommonPullRequest(pr, expected) {
  invariant(pr.state === 'open' && !pr.draft, 'Pull request must be open and ready');
  invariant(pr.user?.login === 'dependabot[bot]', 'Pull request author must be dependabot[bot]');
  invariant(pr.base?.ref === expected.defaultBranch, 'Pull request must target the default branch');
  invariant(pr.base?.sha === expected.baseSha, 'Base SHA changed after validation');
  invariant(pr.head?.sha === expected.headSha, 'Head SHA changed after validation');
  invariant(pr.head?.repo?.full_name === expected.repository, 'Dependabot branch must belong to this repository');
}

export function validatePullRequest(pr, expected) {
  validateCommonPullRequest(pr, expected);
  invariant(pr.head?.ref?.startsWith('dependabot/github_actions/'), 'Pull request must be a GitHub Actions update');
}

export function validateNpmPullRequest(pr, expected) {
  validateCommonPullRequest(pr, expected);
  invariant(pr.head?.ref?.startsWith(NPM_BRANCH_PREFIX), 'Pull request must be an iCloud npm update');
}

function classifyDependabotPullRequest(pr, expected) {
  validateCommonPullRequest(pr, expected);
  if (pr.head?.ref?.startsWith('dependabot/github_actions/')) return 'github-actions';
  if (pr.head?.ref?.startsWith(NPM_BRANCH_PREFIX)) return 'npm';
  throw new Error('Dependabot branch is outside the approved automation scopes');
}

function parseStableActionVersion(version, label) {
  invariant(typeof version === 'string', `${label} must use an exact stable vX.Y.Z release tag`);
  const match = version.match(ACTION_STABLE_SEMVER_PATTERN);
  invariant(match, `${label} must use an exact stable vX.Y.Z release tag`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validateRoutineActionVersions(oldReferences, newReferences, filename) {
  for (const action of new Set(oldReferences.map(({ action: name }) => name))) {
    const oldVersions = [...new Set(oldReferences.filter(({ action: name }) => name === action).map(({ version }) => version))];
    const newVersions = [...new Set(newReferences.filter(({ action: name }) => name === action).map(({ version }) => version))];
    invariant(oldVersions.length === 1 && newVersions.length === 1, `Action ${action} must use one reviewed version per changed workflow: ${filename}`);
    const oldVersion = parseStableActionVersion(oldVersions[0], `${action} old version`);
    const newVersion = parseStableActionVersion(newVersions[0], `${action} new version`);
    invariant(newVersion[0] === oldVersion[0], `${action} major update requires manual review`);
    invariant(compareVersions(newVersion, oldVersion) > 0, `${action} update must move forward`);
  }
}

export function validateChangedFiles(files) {
  invariant(files.length > 0 && files.length <= MAX_CHANGED_FILES, 'Changed-file count is invalid');

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
      const reference = { action: match[2], sha: match[3], version: match[4] };
      (match[1] === '-' ? oldReferences : newReferences).push(reference);
    }

    invariant(oldReferences.length > 0, 'Workflow update must replace an existing Action reference');
    invariant(oldReferences.length === newReferences.length, 'Action replacements must be one-for-one');
    const oldActions = oldReferences.map(({ action }) => action).sort();
    const newActions = newReferences.map(({ action }) => action).sort();
    invariant(JSON.stringify(oldActions) === JSON.stringify(newActions), 'Action names must not change');
    validateRoutineActionVersions(oldReferences, newReferences, file.filename);

    const oldDigests = oldReferences.map(({ action, sha }) => action + '@' + sha).sort();
    const newDigests = newReferences.map(({ action, sha }) => action + '@' + sha).sort();
    invariant(JSON.stringify(oldDigests) !== JSON.stringify(newDigests), 'At least one Action SHA must change');
    changedReferenceCount += newReferences.length;
    invariant(changedReferenceCount <= MAX_ACTION_REFERENCES, 'Action reference count is invalid');
  }

  return changedReferenceCount;
}

export function validateNpmChangedFiles(files) {
  invariant(files.length === 1 || files.length === 2, 'Routine npm update must change pnpm-lock.yaml, optionally with package.json');
  const actualFiles = files.map(({ filename }) => filename).sort();
  const lockOnly = [NPM_LOCK_PATH];
  const directUpdate = [NPM_LOCK_PATH, NPM_PACKAGE_PATH].sort();
  invariant(
    isDeepStrictEqual(actualFiles, lockOnly) || isDeepStrictEqual(actualFiles, directUpdate),
    'Routine npm update changed files outside the approved dependency pair'
  );
  for (const file of files) {
    invariant(file.status === 'modified' && !file.previous_filename, 'Routine npm dependency files may only be modified');
  }
  return actualFiles.includes(NPM_PACKAGE_PATH);
}

function parseStableVersion(version, label) {
  invariant(typeof version === 'string', `${label} must use an exact stable semver pin`);
  const match = version.match(STABLE_SEMVER_PATTERN);
  invariant(match, `${label} must use an exact stable semver pin`);
  return match.slice(1).map(Number);
}

export function validateRoutineNpmPackageUpdate(basePackage, headPackage) {
  invariant(basePackage && headPackage && typeof basePackage === 'object' && typeof headPackage === 'object', 'package.json payload is invalid');
  const {
    dependencies: baseDependencies = {},
    devDependencies: baseDevDependencies = {},
    ...baseRest
  } = basePackage;
  const {
    dependencies: headDependencies = {},
    devDependencies: headDevDependencies = {},
    ...headRest
  } = headPackage;

  invariant(isDeepStrictEqual(baseRest, headRest), 'Routine npm update may only change dependency version pins');

  const changes = [];
  for (const [sectionName, baseSection, headSection] of [
    ['dependencies', baseDependencies, headDependencies],
    ['devDependencies', baseDevDependencies, headDevDependencies],
  ]) {
    const baseNames = Object.keys(baseSection).sort();
    const headNames = Object.keys(headSection).sort();
    invariant(isDeepStrictEqual(baseNames, headNames), `Routine npm update may not add or remove ${sectionName}`);

    for (const packageName of baseNames) {
      const before = baseSection[packageName];
      const after = headSection[packageName];
      if (before === after) continue;
      const oldVersion = parseStableVersion(before, `${packageName} old version`);
      const newVersion = parseStableVersion(after, `${packageName} new version`);
      invariant(newVersion[0] === oldVersion[0], `${packageName} major update requires manual review`);
      invariant(compareVersions(newVersion, oldVersion) > 0, `${packageName} update must move forward`);
      changes.push({ packageName, before, after });
    }
  }

  return changes;
}

async function githubRequest(repository, token, path, options = {}, fetchImpl = fetch) {
  const response = await fetchImpl('https://api.github.com/repos/' + repository + path, {
    ...options,
    redirect: 'error',
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

function collectNewActionReferences(files) {
  const references = new Map();
  for (const file of files) {
    for (const line of file.patch.split('\n')) {
      const match = line.match(ACTION_LINE_PATTERN);
      if (!match || match[1] !== '+') continue;
      const reference = { action: match[2], sha: match[3], version: match[4] };
      references.set(`${reference.action}@${reference.version}:${reference.sha}`, reference);
    }
  }
  return [...references.values()];
}

export async function resolveActionTagCommit(reference, runGit = execFileAsync) {
  const repository = reference.action.split('/').slice(0, 2).join('/');
  const tagRef = `refs/tags/${reference.version}`;
  const { stdout } = await runGit('git', [
    'ls-remote',
    '--exit-code',
    `https://github.com/${repository}.git`,
    tagRef,
    `${tagRef}^{}`
  ], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 30_000,
    windowsHide: true
  });
  let directCommit = null;
  let peeledCommit = null;
  for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^([a-f0-9]{40})\t(.+)$/);
    invariant(match && (match[2] === tagRef || match[2] === `${tagRef}^{}`), `Unexpected tag response for ${reference.action}@${reference.version}`);
    if (match[2].endsWith('^{}')) peeledCommit = match[1];
    else directCommit = match[1];
  }
  const commit = peeledCommit ?? directCommit;
  invariant(SHA_PATTERN.test(commit || ''), `Release tag was not found for ${reference.action}@${reference.version}`);
  return commit;
}

export async function verifyActionReferences(references, runGit = execFileAsync) {
  invariant(references.length > 0 && references.length <= MAX_ACTION_REFERENCES, 'Action reference count is invalid');
  for (const reference of references) {
    const taggedCommit = await resolveActionTagCommit(reference, runGit);
    invariant(
      taggedCommit === reference.sha,
      `Pinned SHA does not match ${reference.action}@${reference.version}`
    );
  }
}

async function readPullRequestFiles(repository, token, pullNumber, fetchImpl) {
  const files = await githubRequest(
    repository,
    token,
    '/pulls/' + pullNumber + '/files?per_page=' + MAX_CHANGED_FILES + '&page=1',
    {},
    fetchImpl
  );
  invariant(Array.isArray(files) && files.length <= MAX_CHANGED_FILES, 'Changed-file response is invalid');
  return files;
}

async function readJsonAtRef(repository, token, path, ref, fetchImpl) {
  const payload = await githubRequest(
    repository,
    token,
    '/contents/' + path + '?ref=' + encodeURIComponent(ref),
    {},
    fetchImpl
  );
  invariant(payload?.encoding === 'base64' && typeof payload.content === 'string', `Unable to read ${path} at ${ref}`);
  const text = Buffer.from(payload.content.replace(/\s+/g, ''), 'base64').toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path} at ${ref} is not valid JSON`);
  }
}

export async function main(env = process.env, fetchImpl = fetch, log = console.log, runGit = execFileAsync) {
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
  const kind = classifyDependabotPullRequest(pullRequest, { repository, defaultBranch, baseSha, headSha });
  invariant(
    Number.isSafeInteger(pullRequest.changed_files)
      && pullRequest.changed_files > 0
      && pullRequest.changed_files <= MAX_CHANGED_FILES,
    'Pull request changed-file count is invalid'
  );

  const files = await readPullRequestFiles(repository, token, pullNumber, fetchImpl);
  invariant(files.length === pullRequest.changed_files, 'Changed-file list is incomplete');

  let summary;
  let commitTitle;
  if (kind === 'github-actions') {
    const referenceCount = validateChangedFiles(files);
    const actionReferences = collectNewActionReferences(files);
    await verifyActionReferences(actionReferences, runGit);
    summary = `${referenceCount} official Action reference(s) and exact release tag(s)`;
    commitTitle = 'chore: update official GitHub Actions (#' + pullNumber + ')';
  } else {
    const packageFileChanged = validateNpmChangedFiles(files);
    const [basePackage, headPackage] = await Promise.all([
      readJsonAtRef(repository, token, NPM_PACKAGE_PATH, baseSha, fetchImpl),
      readJsonAtRef(repository, token, NPM_PACKAGE_PATH, headSha, fetchImpl),
    ]);
    const changes = validateRoutineNpmPackageUpdate(basePackage, headPackage);
    if (packageFileChanged) {
      invariant(changes.length > 0, 'package.json changed without an approved dependency version update');
      summary = `${changes.length} routine npm dependency update(s)`;
    } else {
      invariant(changes.length === 0, 'Lockfile-only update unexpectedly changed package.json semantics');
      summary = 'one lockfile-only transitive npm dependency update';
    }
    commitTitle = 'chore: update iCloud dependencies (#' + pullNumber + ')';
  }

  const result = await githubRequest(repository, token, '/pulls/' + pullNumber + '/merge', {
    method: 'PUT',
    body: JSON.stringify({
      commit_title: commitTitle,
      merge_method: 'squash',
      sha: headSha,
    }),
  }, fetchImpl);
  invariant(result.merged === true, result.message || 'GitHub did not merge the pull request');
  log(`Merged Dependabot PR #${pullNumber} after validating ${summary}.`);
}

function logInline(value, maximumCodePoints = 1000) {
  const safe = String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/g, ' ')
    .replace(/::/g, ': :')
    .replace(/\s+/g, ' ')
    .trim();
  return [...safe.slice(0, maximumCodePoints * 2)].slice(0, maximumCodePoints).join('');
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  main().catch((error) => {
    console.error(`Dependabot auto-merge failed: ${logInline(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
