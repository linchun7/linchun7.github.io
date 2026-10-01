import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Only GitHub's ephemeral runner is provisioned here; local machines are untouched.
export async function prepareUpdaterBrowser({ githubActions = process.env.GITHUB_ACTIONS === 'true', run = spawnSync, check = access } = {}) {
  if (!githubActions) return false;
  // The pinned CLI installs Chromium and its matching headless shell together.
  const result = run('pnpm', ['exec', 'playwright', 'install', '--with-deps', 'chromium'], {
    cwd: new URL('..', import.meta.url), stdio: 'inherit', timeout: 180_000
  });
  if (result.error || result.signal || result.status !== 0) throw new Error('Pinned Chromium setup failed; UI tests and publication must not continue');
  await check(chromium.executablePath());
  console.log('Updater UI uses the Chromium bundled with locked Playwright; system Chrome fallback is disabled on GitHub Actions.');
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareUpdaterBrowser().catch(error => { console.error(error.message); process.exitCode = 1; });
}
