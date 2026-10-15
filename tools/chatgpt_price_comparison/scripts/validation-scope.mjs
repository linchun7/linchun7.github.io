import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePlaywrightDependencyUpdate } from './dependency-policy.mjs';

const SHA = /^[a-f0-9]{40}$/;
const PREFIX = 'dependabot/npm_and_yarn/tools/chatgpt_price_comparison/';
const PACKAGE = 'tools/chatgpt_price_comparison/package.json';
const LOCK = 'tools/chatgpt_price_comparison/pnpm-lock.yaml';

export function parseRawDiff(text) {
  const fields = text.split('\0');
  if (fields.pop() !== '' || fields.length % 2) throw new Error('Incomplete Git diff');
  const files = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/);
    if (!match) throw new Error('Unsupported Git diff record');
    files.push({ oldMode: match[1], newMode: match[2], status: match[5], filename: fields[index + 1] });
  }
  return files;
}

export function isDependencyFileSet(files) {
  return files.length === 2
    && files.every(file => file.status === 'M' && file.oldMode === '100644' && file.newMode === '100644')
    && [PACKAGE, LOCK].every(path => files.filter(file => file.filename === path).length === 1);
}

export async function dependencyOnlyScope(event, {
  repository,
  checkoutSha,
  git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 15_000 }),
  regenerate,
} = {}) {
  const pr = event?.pull_request;
  if (!pr || pr.user?.login !== 'dependabot[bot]' || pr.user?.type !== 'Bot'
    || event.repository?.full_name !== repository
    || pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository
    || pr.base?.ref !== event.repository?.default_branch
    || !pr.head?.ref?.startsWith(PREFIX)
    || !SHA.test(pr.base?.sha || '') || !SHA.test(pr.head?.sha || '') || !SHA.test(checkoutSha || '')) return false;

  const base = pr.base.sha;
  const head = pr.head.sha;
  // Bind the supplied PR identity to the actual GitHub merge checkout.
  if (git(['rev-parse', 'HEAD']).trim() !== checkoutSha) return false;
  const parents = git(['rev-list', '--parents', '-n', '1', checkoutSha]).trim().split(/\s+/);
  if (parents.length !== 3 || parents[0] !== checkoutSha || parents[1] !== base || parents[2] !== head) return false;
  const ancestor = git(['merge-base', base, head]).trim();
  if (!SHA.test(ancestor)) throw new Error('Invalid merge base');
  const files = parseRawDiff(git(['diff', '--raw', '--no-abbrev', '--no-renames', '-z', ancestor, head, '--']));
  if (!isDependencyFileSet(files)) return false;
  const baseManifest = JSON.parse(git(['show', ancestor + ':' + PACKAGE]));
  const headManifest = JSON.parse(git(['show', head + ':' + PACKAGE]));
  const headLock = git(['show', head + ':' + LOCK]);
  await validatePlaywrightDependencyUpdate(baseManifest, headManifest, headLock, regenerate);
  return true;
}

export async function validationScope(event, options) {
  try {
    return { dependencyOnly: await dependencyOnlyScope(event, options), reason: 'validated PR scope' };
  } catch {
    // Missing Git evidence, invalid JSON, registry errors, and lock mismatches
    // retain the original live checks; they never authorize an automatic merge.
    return { dependencyOnly: false, reason: 'scope could not be proven; retaining live validation' };
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  let event;
  try { event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')); }
  catch { event = {}; }
  const result = await validationScope(event, {
    repository: process.env.GITHUB_REPOSITORY,
    checkoutSha: process.env.GITHUB_SHA,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, 'dependency_only=' + result.dependencyOnly + '\n');
  console.log('ChatGPT validation: ' + result.reason + '; dependency_only=' + result.dependencyOnly);
}
