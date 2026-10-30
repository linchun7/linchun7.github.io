import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UPSTREAM_REPOSITORY } from './monitor-cactus-upstream.mjs';

// This step is strictly READ-ONLY and extracts one public upstream commit SHA.
// It never clones private source code, prints source content, or writes remotely.
export const PRIVATE_BASELINE_URL =
  'https://api.github.com/repos/linchun7/linchun.github.io/contents/themes/cactus/package.json?ref=main';

export function extractReviewedCactusSha(apiResponse) {
  if (!apiResponse || typeof apiResponse !== 'object' ||
      apiResponse.type !== 'file' ||
      apiResponse.path !== 'themes/cactus/package.json' ||
      apiResponse.encoding !== 'base64' ||
      typeof apiResponse.content !== 'string' ||
      typeof apiResponse.size !== 'number' ||
      !Number.isSafeInteger(apiResponse.size) ||
      apiResponse.size < 1 || apiResponse.size > 16_384) {
    throw new Error('Untrusted private baseline metadata shape.');
  }
  const compact = apiResponse.content.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error('Invalid encoded baseline metadata.');
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.length !== apiResponse.size ||
      bytes.toString('base64') !== compact ||
      !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw new Error('Private baseline metadata bytes are not canonical UTF-8.');
  }
  let pkg;
  try { pkg = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('Invalid private baseline JSON.'); }
  const upstream = pkg?.upstream;
  if (upstream?.repository !== 'https://github.com/' + UPSTREAM_REPOSITORY ||
      !/^[a-f0-9]{40}$/i.test(upstream?.baseline || '')) {
    throw new Error('Unrecognized private upstream baseline or source.');
  }
  return upstream.baseline.toLowerCase();
}

export async function readPrivateBaseline({
  token = process.env.CACTUS_PRIVATE_READ_TOKEN,
  fetcher = globalThis.fetch,
  writeOutput = process.env.GITHUB_OUTPUT,
  log = console.log
} = {}) {
  if (typeof token !== 'string' || !token.trim()) {
    throw new Error('Private read token is required; refusing static fallback when synchronization is enabled.');
  }
  if (typeof fetcher !== 'function') throw new Error('No fetch implementation.');
  const response = await fetcher(PRIVATE_BASELINE_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'linchun-cactus-private-baseline-readonly'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error('Private baseline metadata access failed: HTTP ' + response.status);
  const metadata = await response.json();
  const baselineSha = extractReviewedCactusSha(metadata);
  if (writeOutput) appendFileSync(writeOutput, 'reviewed_sha=' + baselineSha + '\n');
  log(JSON.stringify({ status: 'private-reviewed-baseline-read', upstreamSha: baselineSha }));
  return baselineSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  readPrivateBaseline().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
