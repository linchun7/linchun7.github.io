import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET only: retries never repeat a publication or request a new Pages build.
export async function githubJson(url, { token, fetchImpl = fetch, sleep = pause,
  now = Date.now, deadline = now() + 900000, maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (now() >= deadline) throw new Error('PAGES_API_DEADLINE');
    let response;
    let transient = false;
    let retryAfter = 0;
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token,
          'Cache-Control': 'no-cache', 'X-GitHub-Api-Version': '2026-03-10' },
        signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))) });
    } catch (error) {
      // Only transport/timeouts are retryable. Programming/schema errors are not.
      transient = error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name);
      if (!transient) throw error;
    }
    if (response) {
      const retry = response.headers.get('retry-after');
      retryAfter = retry == null ? 0 : Number(retry) * 1000;
      if (!Number.isFinite(retryAfter)) retryAfter = Math.max(0, Date.parse(retry) - now());
      const rateLimited = response.status === 403 &&
        (retry != null || response.headers.get('x-ratelimit-remaining') === '0');
      transient = rateLimited || [429, 500, 502, 503, 504].includes(response.status);
      if (!response.ok && !transient) {
        await response.body?.cancel().catch(() => {});
        throw new Error('PAGES_API_HTTP_' + response.status);
      }
      if (response.ok) {
        // Deadline covers reading the response too; JSON/schema failures are permanent.
        try {
          const result = await response.json();
          if (now() >= deadline) throw new Error('PAGES_API_DEADLINE');
          return result;
        } catch (error) {
          transient = error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error.name);
          if (!transient) throw error;
        }
      }
      await response.body?.cancel().catch(() => {});
    }
    if (!transient || attempt === maxAttempts) throw new Error('PAGES_API_RETRIES_EXHAUSTED');
    const delay = Math.max(1000 * 2 ** (attempt - 1), retryAfter || 0);
    if (delay > 60000 || now() + delay >= deadline) throw new Error('PAGES_API_RETRY_BUDGET');
    await sleep(delay);
  }
  throw new Error('PAGES_API_RETRIES_EXHAUSTED');
}

export async function waitForPages({ repository, targetSha, token, maxWaitMs = 900000,
  maxPolls = 180, intervalMs = 5000, now = Date.now, sleep = pause,
  request = githubJson, log = console.log } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !SHA.test(targetSha || '')) {
    throw new Error('PAGES_INVALID_TARGET');
  }
  const deadline = now() + maxWaitMs;
  const base = 'https://api.github.com/repos/' + repository;
  const relations = new Map();
  let observed = 'none';
  for (let poll = 1; poll <= maxPolls && now() < deadline; poll++) {
    const options = { token, now, sleep, deadline };
    const builds = await request(base + '/pages/builds?per_page=100', options);
    if (!Array.isArray(builds) || builds.length > 100) throw new Error('PAGES_INVALID_BUILD_LIST');
    // GitHub lists builds newest first. The first relevant attempt owns the result.
    for (const build of builds) {
      if (!build || !SHA.test(build.commit || '') || typeof build.status !== 'string' ||
          (build.error?.message != null && typeof build.error.message !== 'string')) {
        throw new Error('PAGES_INVALID_BUILD');
      }
      observed = build.commit + ':' + build.status;
      let relation = build.commit === targetSha ? 'identical' : relations.get(build.commit);
      if (!relation) {
        const comparison = await request(base + '/compare/' + targetSha + '...' + build.commit, options);
        if (!['ahead', 'behind', 'diverged', 'identical'].includes(comparison?.status)) {
          throw new Error('PAGES_INVALID_COMPARISON');
        }
        relation = comparison.status === 'ahead' ? 'successor' : 'unrelated';
        relations.set(build.commit, relation);
      }
      if (relation === 'unrelated') continue;
      if (build.status === 'errored' || build.error?.message) throw new Error('PAGES_BUILD_FAILED: ' + observed);
      if (build.status === 'built') {
        if (now() >= deadline) throw new Error('PAGES_API_DEADLINE');
        return { built_sha: build.commit, build_relation: relation };
      }
      if (!['queued', 'building'].includes(build.status)) throw new Error('PAGES_INVALID_BUILD_STATUS: ' + build.status);
      break; // A newer pending attempt must never be rescued by an older success.
    }
    if (poll === 1 || poll % 12 === 0) log('Pages wait ' + poll + '/' + maxPolls + ': ' + observed);
    if (poll < maxPolls && now() + intervalMs < deadline) await sleep(intervalMs);
    else break;
  }
  throw new Error('PAGES_BUILD_TIMEOUT: ' + observed);
}

export async function main(env = process.env) {
  if (!env.GITHUB_OUTPUT || !env.GH_TOKEN) throw new Error('PAGES_MISSING_ENV');
  await appendFile(env.GITHUB_OUTPUT, 'pages_built=false\n');
  const result = await waitForPages({ repository: env.GITHUB_REPOSITORY, targetSha: env.TARGET_SHA, token: env.GH_TOKEN });
  await appendFile(env.GITHUB_OUTPUT, 'pages_built=true\nbuilt_sha=' + result.built_sha +
    '\nbuild_relation=' + result.build_relation + '\n');
  console.log('Pages built ' + result.built_sha + ' (' + result.build_relation + ').');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
