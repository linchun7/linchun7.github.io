import { spawn } from 'node:child_process';

function runBrowserSuite(browser) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', 'test/ui-smoke.test.mjs'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, PLAYWRIGHT_BROWSER: browser },
      stdio: 'inherit'
    });
    child.on('error', (error) => {
      console.error(`${browser} browser suite could not start: ${error.message}`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      if (signal) console.error(`${browser} browser suite exited after signal ${signal}`);
      resolve(code ?? 1);
    });
  });
}

const results = await Promise.all(['chromium', 'webkit'].map(runBrowserSuite));
if (results.some((code) => code !== 0)) process.exitCode = 1;
