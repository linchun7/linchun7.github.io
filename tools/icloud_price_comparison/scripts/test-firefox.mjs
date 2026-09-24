process.env.PLAYWRIGHT_BROWSER = 'firefox';
await import('../test/ui-smoke.test.mjs');
await import('../test/static-descending-url-state.test.mjs');
