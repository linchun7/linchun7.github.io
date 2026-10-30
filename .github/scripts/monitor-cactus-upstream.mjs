import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PUBLIC_REPOSITORY = 'linchun7/linchun7.github.io';
export const UPSTREAM_REPOSITORY = 'probberechts/hexo-theme-cactus';
// This is a PUBLIC upstream commit SHA, not a private-repository commit.
export const INITIAL_REVIEW_CHECKPOINT = '7a6074d830ac5d524582f142ac524c041077aad7';
export const ISSUE_TITLE = 'Cactus upstream update available';
export const ISSUE_MARKER = '<!-- cactus-upstream-public-monitor:v1 -->';

const shaPattern = /^[0-9a-f]{40}$/i;
const apiRoot = 'https://api.github.com/repos/';
const issueRoot = apiRoot + PUBLIC_REPOSITORY + '/issues';

async function githubJson(url, { token, fetcher, method = 'GET', payload } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'linchun-cactus-public-upstream-monitor'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (payload !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetcher(url, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error('GitHub API ' + response.status + ': ' + String(body?.message || 'unexpected response'));
  }
  return body;
}

export function renderIssueBody(remoteSha, commitDate = 'unknown') {
  if (!shaPattern.test(remoteSha)) throw new Error('Invalid upstream commit SHA.');
  return [
    ISSUE_MARKER,
    'Automatically maintained by a scheduled GitHub Actions workflow in this public repository.',
    '',
    '- Public upstream: https://github.com/' + UPSTREAM_REPOSITORY,
    '- Initial reviewed upstream checkpoint: ' + INITIAL_REVIEW_CHECKPOINT,
    '- Current upstream HEAD: ' + remoteSha,
    '- Latest upstream commit date (UTC): ' + commitDate,
    '- Compare upstream commits: https://github.com/' + UPSTREAM_REPOSITORY +
      '/compare/' + INITIAL_REVIEW_CHECKPOINT + '...' + remoteSha,
    '',
    'This workflow uses public upstream data only. It does not access any private repository.',
    'Changes to the customized theme are not merged or deployed automatically.'
  ].join('\n');
}

export function extractTrackedSha(body) {
  if (typeof body !== 'string') return null;
  const match = body.match(/^- Current upstream HEAD: ([0-9a-f]{40})$/im);
  return match ? match[1].toLowerCase() : null;
}

export function isManagedIssue(issue) {
  return Boolean(
    issue &&
    !issue.pull_request &&
    issue.title === ISSUE_TITLE &&
    typeof issue.body === 'string' &&
    issue.body.includes(ISSUE_MARKER) &&
    issue.user?.login === 'github-actions[bot]'
  );
}

async function findManagedIssue(token, fetcher) {
  // Include closed issues to avoid re-notifying an already acknowledged commit.
  // GitHub sorts issues by creation date descending by default.
  for (let page = 1; page <= 20; page += 1) {
    const issues = await githubJson(
      issueRoot + '?state=all&sort=created&direction=desc&per_page=100&page=' + page,
      { token, fetcher }
    );
    if (!Array.isArray(issues)) throw new Error('GitHub did not return an issues array.');
    const matching = issues.find(isManagedIssue);
    if (matching) return matching;
    if (issues.length < 100) return null;
  }
  // Failing closed is safer than creating duplicate issues after a truncated scan.
  throw new Error('Issue scan exceeded 20 pages; refusing to create a possible duplicate.');
}

export async function runMonitor({
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  dryRun = false,
  fetcher = globalThis.fetch,
  log = console.log
} = {}) {
  if (!dryRun && repository !== PUBLIC_REPOSITORY) {
    throw new Error('Live monitoring may only write to ' + PUBLIC_REPOSITORY);
  }
  if (!dryRun && !token) {
    throw new Error('Missing GITHUB_TOKEN for public repository issue management.');
  }
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation available.');

  const upstream = await githubJson(
    apiRoot + UPSTREAM_REPOSITORY + '/commits/master',
    { token, fetcher }
  );
  const remoteSha = String(upstream?.sha || '').toLowerCase();
  if (!shaPattern.test(remoteSha)) throw new Error('Invalid upstream response SHA.');
  const date = String(upstream?.commit?.committer?.date || 'unknown');
  const current = remoteSha === INITIAL_REVIEW_CHECKPOINT;

  if (dryRun) {
    const result = { status: current ? 'up-to-date' : 'update-available', remoteSha, dryRun: true };
    log(JSON.stringify(result));
    return result;
  }

  const existing = await findManagedIssue(token, fetcher);

  if (current) {
    if (existing?.state === 'open') {
      await githubJson(issueRoot + '/' + existing.number, {
        token, fetcher, method: 'PATCH',
        payload: { state: 'closed', state_reason: 'completed' }
      });
      const result = { status: 'up-to-date', remoteSha, closedIssue: existing.number };
      log(JSON.stringify(result));
      return result;
    }
    const result = { status: 'up-to-date', remoteSha, issue: existing?.number ?? null };
    log(JSON.stringify(result));
    return result;
  }

  const body = renderIssueBody(remoteSha, date);
  if (!existing) {
    const created = await githubJson(issueRoot, {
      token, fetcher, method: 'POST', payload: { title: ISSUE_TITLE, body }
    });
    if (!Number.isInteger(created?.number)) throw new Error('Created issue response has no number.');
    const result = { status: 'update-available', remoteSha, createdIssue: created.number };
    log(JSON.stringify(result));
    return result;
  }

  const lastAlertSha = extractTrackedSha(existing.body);
  if (existing.state === 'closed' && lastAlertSha === remoteSha) {
    const result = { status: 'already-acknowledged', remoteSha, issue: existing.number };
    log(JSON.stringify(result));
    return result;
  }

  if (existing.state === 'open' && existing.body === body) {
    const result = { status: 'unchanged', remoteSha, issue: existing.number };
    log(JSON.stringify(result));
    return result;
  }

  const payload = existing.state === 'closed'
    ? { state: 'open', body }
    : { body };
  await githubJson(issueRoot + '/' + existing.number, {
    token, fetcher, method: 'PATCH', payload
  });
  const result = { status: 'update-available', remoteSha, updatedIssue: existing.number };
  log(JSON.stringify(result));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMonitor({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
