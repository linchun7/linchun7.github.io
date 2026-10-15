import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateChangedFiles, verifyActionReferences } from './auto-merge-official-actions.mjs';

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const GUIDES = ['tools/icloud_price_comparison/README.md', 'tools/icloud_price_comparison/OPERATIONS.md'];
const CRITICAL_PATHS = new Set([
  '.github/workflows/update-icloud-prices.yml',
  '.github/workflows/validate-icloud-price-comparison.yml',
  'tools/icloud_price_comparison/data-contract.js',
  'tools/icloud_price_comparison/data-model.js',
  'tools/icloud_price_comparison/scripts/market-registry.mjs',
  'tools/icloud_price_comparison/scripts/update-prices.mjs',
  'tools/icloud_price_comparison/scripts/parse-prices.mjs',
  'tools/icloud_price_comparison/scripts/render-static-page.mjs',
  'tools/icloud_price_comparison/scripts/static-page.mjs',
  'tools/icloud_price_comparison/scripts/validate-data-artifact.mjs',
  'tools/icloud_price_comparison/scripts/validate-documentation-change.mjs',
]);
// Semantic/version/release policy is shared with the auto-merger. This pattern
// additionally preserves every byte outside the two allowed pin/comment tokens.
const PIN_LINE = /^([ \t]*(?:-[ \t]+)?uses:[ \t]*)(actions\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)@([a-f0-9]{40})([ \t]+#[ \t]+)(v\d+\.\d+\.\d+)([ \t]*\r?)$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function validateDependabotIdentity({ event, repository, baseSha, headSha, checkoutParents }) {
  const pr = event?.pull_request;
  const isDependabot = (user) => user?.login === 'dependabot[bot]' && user.id === 49699333 && user.type === 'Bot';
  invariant(isDependabot(pr?.user) && isDependabot(event?.sender), 'PR author and event sender must be the verified Dependabot Bot');
  invariant(pr.state === 'open' && !pr.draft, 'Dependabot PR must be open and ready');
  invariant(event.repository?.full_name === repository, 'Event repository does not match this workflow');
  invariant(pr.base?.repo?.full_name === repository && pr.head?.repo?.full_name === repository, 'Dependabot PR must belong to this repository');
  invariant(pr.base.ref === event.repository.default_branch, 'Dependabot PR must target the default branch');
  invariant(pr.head.ref?.startsWith('dependabot/github_actions/'), 'PR is outside the approved GitHub Actions branch scope');
  invariant(pr.base.sha === baseSha && pr.head.sha === headSha, 'Event base/head SHA does not match the tested PR');
  invariant(checkoutParents?.length === 2 && checkoutParents[0] === baseSha && checkoutParents[1] === headSha, 'Tested merge commit is not bound to this exact base/head');
}

export function parseRawChanges(raw) {
  if (raw === '') return [];
  const fields = raw.split('\0');
  invariant(fields.pop() === '' && fields.length % 2 === 0, 'Git changed-file response is incomplete');
  const files = [];
  for (let index = 0; index < fields.length; index += 2) {
    const match = fields[index].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([A-Z])$/);
    invariant(match && fields[index + 1], 'Git changed-file metadata is invalid');
    files.push({ filename: fields[index + 1], oldMode: match[1], newMode: match[2], status: match[5] === 'M' ? 'modified' : match[5] });
  }
  return files;
}

async function pinOnlyChanges(files, readContent) {
  invariant(files.length > 0 && files.length <= 20, 'Changed-file count is outside the approved Action scope');
  const references = new Map();
  const patches = [];
  for (const file of files) {
    invariant(/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file.filename), 'Only workflow files may receive the documentation exception');
    invariant(file.status === 'modified' && file.oldMode === '100644' && file.newMode === '100644', 'Workflow additions, deletions, renames, or mode changes require documentation');
    const before = (await readContent(file, 'base')).split('\n');
    const after = (await readContent(file, 'head')).split('\n');
    invariant(before.length === after.length, 'Only existing Action pin lines may change');
    const lines = [];
    for (let index = 0; index < before.length; index += 1) {
      if (before[index] === after[index]) continue;
      const oldPin = before[index].match(PIN_LINE);
      const newPin = after[index].match(PIN_LINE);
      invariant(oldPin && newPin, 'Non-pin workflow content changed');
      for (const part of [1, 2, 4, 6]) {
        invariant(oldPin[part] === newPin[part], 'Action name, indentation, or other workflow bytes changed');
      }
      lines.push('-' + before[index], '+' + after[index]);
      for (const match of [oldPin, newPin]) {
        const reference = { action: match[2], sha: match[3], version: match[5] };
        references.set(reference.action + '@' + reference.version + ':' + reference.sha, reference);
      }
    }
    patches.push({ filename: file.filename, status: 'modified', changes: lines.length, patch: lines.join('\n') });
  }
  validateChangedFiles(patches);
  return [...references.values()];
}

export async function evaluateDocumentationChange(input, {
  readContent = async (file, side) => file[side + 'Content'],
  verifyReferences = verifyActionReferences,
} = {}) {
  const changed = new Set(input.files.filter(({ status, newMode }) => status === 'modified' && newMode === '100644').map(({ filename }) => filename));
  const required = input.files.some(({ filename }) => CRITICAL_PATHS.has(filename));
  const missingDocs = required ? GUIDES.filter((guide) => !changed.has(guide)) : [];
  if (!required || missingDocs.length === 0) return { required, exempt: false, missingDocs, reason: 'Documentation requirements satisfied' };
  try {
    validateDependabotIdentity(input);
    const references = await pinOnlyChanges(input.files, readContent);
    // Verify old pins as well as new pins, including annotated-tag peeling.
    await verifyReferences(references);
    return { required, exempt: true, missingDocs: [], reason: 'Verified same-major official Action pin-only Dependabot update' };
  } catch (error) {
    return { required, exempt: false, missingDocs, reason: 'No documentation exception: ' + error.message };
  }
}

export async function main(env = process.env, runGit = execFileAsync, readText = readFile, log = console.log) {
  const { BASE_SHA: baseSha, HEAD_SHA: headSha, GITHUB_SHA: checkoutSha, GITHUB_REPOSITORY: repository } = env;
  invariant(env.GITHUB_EVENT_NAME === 'pull_request', 'Documentation gate requires a pull_request event');
  invariant([baseSha, headSha, checkoutSha].every((sha) => SHA_PATTERN.test(sha || '')), 'Exact base/head/checkout SHAs are required');
  invariant(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || ''), 'GITHUB_REPOSITORY must be owner/name');
  const event = JSON.parse(await readText(env.GITHUB_EVENT_PATH, 'utf8'));
  const git = async (...args) => (await runGit('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30_000, windowsHide: true })).stdout;
  // Compare the same merge tree that the rest of PR CI tests, even if the
  // Dependabot branch has not yet incorporated unrelated newer main commits.
  const files = parseRawChanges(await git('diff', '--raw', '--no-abbrev', '--no-renames', '-z', baseSha, checkoutSha));
  const result = await evaluateDocumentationChange({
    event, repository, baseSha, headSha, files,
    checkoutParents: (await git('show', '-s', '--format=%P', checkoutSha)).trim().split(/\s+/),
  }, {
    readContent: (file, side) => git('show', (side === 'base' ? baseSha : checkoutSha) + ':' + file.filename),
    verifyReferences: (references) => verifyActionReferences(references, runGit),
  });
  log(result.reason);
  invariant(result.missingDocs.length === 0, 'Critical iCloud architecture changed without required documentation update: ' + result.missingDocs.join(', '));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
