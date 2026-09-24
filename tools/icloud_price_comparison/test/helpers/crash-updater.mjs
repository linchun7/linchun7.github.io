// Mechanical child fixture: pause after a real filesystem boundary so the parent
// can SIGKILL the process (no finally/catch rollback may execute in this child).
import fs from 'node:fs/promises';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const { paths, html, boundary } = JSON.parse(process.env.ICLOUD_CRASH_FIXTURE);
let stopped = false;
async function checkpoint(target) {
  if (!stopped && path.resolve(target) === path.resolve(boundary)) {
    stopped = true;
    process.send({ boundary });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
}
const rename = fs.rename;
fs.rename = async (...args) => { const result = await rename(...args); await checkpoint(args[1]); return result; };
const link = fs.link;
fs.link = async (...args) => { const result = await link(...args); await checkpoint(args[1]); return result; };
syncBuiltinESMExports();
globalThis.fetch = async (url) => String(url).includes('support.apple.com')
  ? new Response(html)
  : new Response(JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: Date.now() / 1000, rates: { USD: 1, CNY: 7.2 }, conversion_rates: { USD: 1, CNY: 7.2 } }));
const { main, createNetworkBudget } = await import('../../scripts/update-prices.mjs');
try {
  await main({ paths, dryRun: false, stepSummaryPath: null, networkBudget: createNetworkBudget({ sleep: async () => {} }) });
  process.send({ unexpectedCompletion: true });
} catch (error) { process.send({ error: String(error) }); process.exitCode = 1; }
