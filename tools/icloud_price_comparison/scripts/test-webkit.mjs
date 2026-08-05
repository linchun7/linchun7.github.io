process.env.PLAYWRIGHT_BROWSER = 'webkit';

await import('../test/ui-smoke.test.mjs');
