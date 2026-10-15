import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PINNED_PNPM = /^pnpm@\d+\.\d+\.\d+\+sha512\.[a-f0-9]{128}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePlaywrightManifestUpdate(base, head) {
  invariant(base && head && typeof base === 'object' && typeof head === 'object', 'Invalid dependency manifest');
  const { devDependencies: before, ...baseRest } = base;
  const { devDependencies: after, ...headRest } = head;
  invariant(isDeepStrictEqual(baseRest, headRest), 'Only the Playwright version pin may change');
  invariant(before && after
    && isDeepStrictEqual(Object.keys(before), ['playwright'])
    && isDeepStrictEqual(Object.keys(after), ['playwright']), 'Only the reviewed Playwright dependency is allowed');
  const oldVersion = typeof before.playwright === 'string' && before.playwright.match(VERSION);
  const newVersion = typeof after.playwright === 'string' && after.playwright.match(VERSION);
  invariant(oldVersion && newVersion, 'Playwright must use exact stable semver pins');
  const oldParts = oldVersion.slice(1).map(Number);
  const newParts = newVersion.slice(1).map(Number);
  invariant(oldParts.every(Number.isSafeInteger) && newParts.every(Number.isSafeInteger), 'Unsafe Playwright version');
  invariant(oldParts[0] === newParts[0], 'Playwright major updates require manual review');
  invariant(newParts[1] > oldParts[1] || (newParts[1] === oldParts[1] && newParts[2] > oldParts[2]), 'Playwright update must move forward');
  invariant(PINNED_PNPM.test(head.packageManager || ''), 'An integrity-pinned pnpm package manager is required');
  return { before: before.playwright, after: after.playwright };
}

// Generate from the official registry, never from a candidate lock, npmrc,
// pnpmfile, scripts, overrides or inherited package-manager configuration.
// A fresh private HOME/store also keeps the merge job token out of this child.
export async function regeneratePlaywrightLock(manifest, run = execFileAsync) {
  invariant(PINNED_PNPM.test(manifest.packageManager || ''), 'An integrity-pinned pnpm package manager is required');
  invariant(VERSION.test(manifest.devDependencies?.playwright || ''), 'An exact Playwright pin is required');
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-dependency-lock-'));
  try {
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      private: true,
      packageManager: manifest.packageManager,
      devDependencies: { playwright: manifest.devDependencies.playwright },
    }) + '\n');
    await run('corepack', [
      'pnpm', 'install', '--lockfile-only', '--ignore-scripts',
      '--no-frozen-lockfile', '--ignore-pnpmfile',
      '--registry=https://registry.npmjs.org/',
      '--config.store-dir=' + join(directory, 'store'),
    ], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        HOME: directory,
        CI: 'true',
        COREPACK_HOME: join(directory, 'corepack'),
        COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
        XDG_CONFIG_HOME: directory,
        npm_config_userconfig: join(directory, 'empty-npmrc'),
        npm_config_globalconfig: join(directory, 'empty-global-npmrc'),
      },
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    return await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function normalizedLock(value) {
  invariant(typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 256 * 1024, 'Invalid or oversized Playwright lockfile');
  return value.replace(/\r\n/g, '\n').trimEnd() + '\n';
}

export async function validatePlaywrightDependencyUpdate(base, head, lock, regenerate = regeneratePlaywrightLock) {
  const update = validatePlaywrightManifestUpdate(base, head);
  const expected = await regenerate(head);
  invariant(normalizedLock(lock) === normalizedLock(expected), 'Candidate lockfile does not match a fresh official-registry pnpm resolution');
  return update;
}
