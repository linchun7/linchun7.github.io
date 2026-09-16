import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, copyFile, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { load } from 'cheerio';
import { parseApplePrices } from '../scripts/parse-prices.mjs';
import { createPublishedMarketResolver, resolveMarket } from '../scripts/market-registry.mjs';
import { main, createNetworkBudget, validateAppleMarketRenameReview, getExchangeRates, fetchResource } from '../scripts/update-prices.mjs';
import { validateExtractedDataArtifact } from '../scripts/validate-data-artifact.mjs';
import { importAppleArchives } from '../scripts/import-apple-archives.mjs';

// Canonical synthetic source: no dependency on production count, FX, publication
// date or current wall clock. Values below are test evidence, not Apple facts.
const TIERS = [['50GB', '50 GB', .99], ['200GB', '200 GB', 2.99], ['2TB', '2 TB', 9.99], ['6TB', '6 TB', 29.99], ['12TB', '12 TB', 59.99]];
const REGIONS = [['nasalac', 'Americas'], ['emea', 'Europe, Middle East & Africa'], ['ap', 'Asia Pacific']];
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
function canonicalCountries() {
  return REGIONS.flatMap(([, region], r) => Array.from({ length: 22 }, (_, i) => ({
    country: r === 1 && i === 0 ? 'Ivory Coast' : `Review Market ${r}-${i}`,
    region, currency: 'USD', prices: TIERS.map(([, , price]) => price)
  })));
}
function sourceHtml(countries, publication, table = true) {
  const body = REGIONS.map(([id, region]) => {
    const header = `<h3 id="${id}">${escape(region)}</h3>`;
    const selected = countries.filter((country) => country.region === region);
    if (!table) return header + selected.map((c) => `<h4 class="gb-header">${escape(c.country)} (${c.currency})</h4><ul>${TIERS.map(([, label], i) => `<li><strong>${label}</strong>: $${c.prices[i].toFixed(2)}</li>`).join('')}</ul>`).join('');
    return header + `<div><table><thead><tr><th>Country (Currency)</th>${TIERS.map(([, label]) => `<th><p>${label}</p></th>`).join('')}</tr></thead><tbody>${selected.map((c) => `<tr><td><p>${escape(c.country)} (${c.currency})</p></td>${c.prices.map((price) => `<td><p>$${price.toFixed(2)}</p></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }).join('');
  return `<!doctype html><html><body>${body}<p>Published Date: <time datetime="${publication}">${publication}</time></p><!--${'x'.repeat(20000)}--></body></html>`;
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'icloud-loop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const snapshotsDir = path.join(dataDir, 'apple-snapshots');
  await mkdir(snapshotsDir, { recursive: true });
  await writeFile(path.join(snapshotsDir, 'README.md'), 'Synthetic evidence for production-loop tests.\n');
  const paths = {
    currentDataPath: path.join(dataDir, 'prices.json'), historyPath: path.join(dataDir, 'history.json'),
    runLogPath: path.join(dataDir, 'run-log.json'), snapshotsDir,
    snapshotIndexPath: path.join(snapshotsDir, 'index.json'), namesPath: path.join(root, 'names.json')
  };
  await copyFile(new URL('../scripts/country-names.zh.json', import.meta.url), paths.namesPath);
  return { root, dataDir, paths };
}
async function allBytes(directory) {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(directory, entry.name);
    entries.push([entry.name, entry.isDirectory() ? await allBytes(full) : (await readFile(full)).toString('base64')]);
  }
  return entries;
}
async function run(t, paths, htmls, now) {
  t.mock.timers.setTime(new Date(now).getTime());
  let appleRequests = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('support.apple.com')) {
      const html = htmls[Math.min(appleRequests++, htmls.length - 1)];
      return new Response(html);
    }
    const rates = { USD: 1, CNY: 7.2 };
    return new Response(JSON.stringify({ result: 'success', base_code: 'USD', time_last_update_unix: Date.now() / 1000, rates, conversion_rates: rates }));
  };
  try {
    await main({ paths, stepSummaryPath: null, dryRun: false, networkBudget: createNetworkBudget({ sleep: async () => {} }) });
    const dataDir = path.dirname(paths.currentDataPath);
    await validateExtractedDataArtifact(dataDir); // Different implementation, full public boundary.
    const prices = JSON.parse(await readFile(paths.currentDataPath));
    const history = JSON.parse(await readFile(paths.historyPath));
    const index = JSON.parse(await readFile(paths.snapshotIndexPath));
    return { appleRequests, prices, history, index };
  } finally { globalThis.fetch = original; }
}

test('canonical full loop binds live observations, revisions, source aliases and first-published fallback IDs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-10T15:59:58Z') });
  const { root, paths, dataDir } = await fixture(t);
  const initial = canonicalCountries();
  const first = await run(t, paths, [sourceHtml(initial, '2026-04-09', false)], '2026-04-10T15:59:58Z');
  assert.equal(first.appleRequests, 2);
  assert.equal(first.history.markets.ci.events[0].observedAt, '2026-04-10');
  const revised = structuredClone(initial);
  revised.find((c) => c.country === 'Ivory Coast').country = "Cote D'Ivoire";
  revised.push({ country: 'Afghanistan', region: REGIONS[1][1], currency: 'USD', prices: TIERS.map(([, , price]) => price) });
  const rollout = structuredClone(revised);
  rollout.at(-1).prices[0] = 1.09;
  const second = await run(t, paths, [sourceHtml(rollout, '2026-04-10'), sourceHtml(revised, '2026-04-10'), sourceHtml(revised, '2026-04-10')], '2026-04-10T16:00:02Z');
  assert.equal(second.appleRequests, 3, 'A/B/B must adopt B, not A');
  assert.equal(second.prices.source.parser, 'cross-checked');
  assert.equal(second.prices.countries.length, revised.length);
  assert.equal(second.history.markets.ci.events.length, 1, 'source rename is not a price event');
  assert.equal(second.history.markets.ci.country, "Cote D'Ivoire");
  const publication = second.history.sourcePublishedDates.at(-1);
  assert.ok(publication.changes.removedCountries.some((c) => c.country === 'Ivory Coast'));
  assert.ok(publication.changes.addedCountries.some((c) => c.country === "Cote D'Ivoire"));
  const marketId = resolveMarket('Afghanistan').id;
  const observed = second.history.markets[marketId].events[0];
  assert.equal(observed.observedAtUtc, '2026-04-10T16:00:02.000Z');
  assert.equal(observed.observedAt, '2026-04-11');
  assert.equal(second.index.snapshots.at(-1).revisions[0].firstConfirmedDate, observed.observedAt);
  assert.equal(second.index.snapshots.at(-1).publishedDate, '2026-04-10');
  assert.equal(observed.plans['50GB'], .99, 'authoritative B price must be retained');

  const forged = structuredClone(second.history);
  forged.markets[marketId].events[0].observedAt = '2026-04-09';
  delete forged.markets[marketId].events[0].observedAtBeijing;
  delete forged.markets[marketId].events[0].observedAtUtc;
  await writeFile(paths.historyPath, JSON.stringify(forged));
  await assert.rejects(validateExtractedDataArtifact(dataDir), /snapshot evidence/);
  await writeFile(paths.historyPath, JSON.stringify(second.history));

  revised.at(-1).country = 'afghanistan';
  revised.at(-1).prices[0] = 1.19;
  const third = await run(t, paths, [sourceHtml(revised, '2026-04-10')], '2026-04-10T16:30:00Z');
  assert.equal(third.prices.countries.find((c) => c.country === 'afghanistan').marketId, marketId);
  assert.equal(third.history.markets[marketId].events.length, 2);
  assert.equal(third.index.snapshots.at(-1).revisions.length, 2, 'same publication date permits distinct confirmed revisions');
  const fourth = await run(t, paths, [sourceHtml(revised, '2026-04-10')], '2026-04-10T16:31:00Z');
  assert.equal(fourth.appleRequests, 1);
  assert.deepEqual(fourth.history.markets, third.history.markets, 'no duplicate price events');
  assert.deepEqual(fourth.index, third.index, 'no overwritten or duplicate evidence');

  const prior = await allBytes(dataDir);
  const broken = load(sourceHtml(revised, '2026-04-10'));
  broken('table').first().remove();
  await assert.rejects(run(t, paths, [broken.html()], '2026-04-10T16:32:00Z'), /no interpretable pricing table/);
  assert.deepEqual(await allBytes(dataDir), prior, 'partial source must not modify any public file');
  // A split regional table must not turn an unrecognized fragment into a
  // confirmed market removal. Even identical network samples cannot prove
  // completeness when both decoders excluded the same DOM evidence.
  const split = load(sourceHtml(revised, '2026-04-10'));
  const table = split('table').first();
  const header = table.find('thead tr').clone();
  header.children().first().text('Market (Currency)');
  const fragment = split('<table><thead></thead><tbody></tbody></table>');
  fragment.find('thead').append(header);
  fragment.find('tbody').append(table.find('tbody tr').first());
  table.after(fragment);
  await assert.rejects(run(t, paths, [split.html(), split.html()], '2026-04-10T16:33:00Z'), /Unrecognized table inside Apple/);
  assert.deepEqual(await allBytes(dataDir), prior, 'ignored source fragments must not publish removals or alter evidence');
  // A later archive backfill must not erase already witnessed live revisions.
  const archiveDir = path.join(root, 'archive');
  await mkdir(archiveDir);
  await writeFile(path.join(archiveDir, 'initial.html'), sourceHtml(initial, '2026-04-09', false)
    + '<!-- https://web.archive.org/web/20260410155958/https://support.apple.com/en-us/108047 -->');
  const older = structuredClone(initial);
  older.find((c) => c.country === 'Ivory Coast').prices[0] = .89;
  await writeFile(path.join(archiveDir, 'older.html'), sourceHtml(older, '2026-04-08', false)
    + '<!-- https://web.archive.org/web/20260409125900/https://support.apple.com/en-us/108047 -->');
  await importAppleArchives(archiveDir, { ...paths, pricesPath: paths.currentDataPath });
  await validateExtractedDataArtifact(dataDir);
  const imported = JSON.parse(await readFile(paths.historyPath));
  assert.equal(imported.markets[marketId].events.length, 2, 'backfill must retain both live revisions');
  assert.equal(imported.markets[marketId].events[0].observedAt, '2026-04-11');
  assert.equal(imported.markets.ci.events[0].observedAt, '2026-04-08', 'new archive event uses publication evidence');
  assert.equal(imported.markets.ci.events[1].observedAtUtc, '2026-04-10T15:59:58.000Z', 'existing live UTC evidence must survive backfill');
  assert.equal(imported.markets[marketId].events[0].observedAtUtc, observed.observedAtUtc);

});

test('reviewed source rename never enters unknown-market rename candidates; real unresolved rename still blocks', () => {
  const old = { country: 'Ivory Coast', marketId: 'ci', region: REGIONS[1][1], currency: 'USD', plans: { '50GB': { price: .99 } } };
  const current = { ...old, country: "Cote D'Ivoire" };
  const added = { ...old, marketId: undefined, country: 'Unreviewed Market' };
  const previous = { schemaVersion: 4, countries: [old] };
  const resolve = createPublishedMarketResolver(previous, null);
  assert.deepEqual(validateAppleMarketRenameReview(previous, [current, added], resolve), { status: 'passed', warnings: [] });
  assert.throws(() => validateAppleMarketRenameReview(previous, [added], resolve), { code: 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED' });
});

test('provider response bodies and exceptions never leak into FX logs, summaries or public fallback reasons', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-11T00:00:00Z') });
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const logs = [];
  console.warn = (...parts) => logs.push(parts.join(' '));
  t.after(() => { globalThis.fetch = originalFetch; console.warn = originalWarn; });
  const secret = 'UNTRUSTED_PROVIDER_DETAILS_FAKE_SECRET_123456';
  const previous = { schemaVersion: 3, fx: { fetchedAt: new Date().toISOString(), derivedCurrency: 'CNY' } };
  for (const respond of [
    () => new Response(JSON.stringify({ result: 'error', 'error-type': secret })),
    () => new Response(`{"${secret}": invalid`),
    () => new Response('failed', { status: 503, statusText: secret }),
    () => { throw new Error(`Bearer ${secret}`); }
  ]) {
    globalThis.fetch = async () => respond();
    const result = await getExchangeRates(previous, { apiKey: secret, networkBudget: createNetworkBudget({ sleep: async () => {} }) });
    assert.equal(result.stale, true);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!logs.join('\n').includes(secret));
  }
  globalThis.fetch = async () => { throw new Error(secret); };
  await assert.rejects(fetchResource('https://example.test/', { json: true, attempts: 1 }), (error) => {
    assert.ok(!String(error).includes(secret));
    assert.ok(!String(error.cause).includes(secret));
    return true;
  });
});


test('SIGKILL at each public write boundary recovers the exact prior artifact and stale lock', { timeout: 30000 }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-10T12:00:00Z') });
  for (const target of ['snapshot', 'index', 'prices', 'history', 'run-log']) {
    await t.test(target, async (sub) => {
      const { paths, dataDir } = await fixture(sub);
      const countries = canonicalCountries();
      await run(t, paths, [sourceHtml(countries, '2026-04-09')], '2026-04-10T12:00:00Z');
      const before = await allBytes(dataDir);
      countries[0].prices[0] = 1.09;
      const boundary = { snapshot: path.join(paths.snapshotsDir, '2026-04-11.json'), index: paths.snapshotIndexPath,
        prices: paths.currentDataPath, history: paths.historyPath, 'run-log': paths.runLogPath }[target];
      const child = fork(new URL('./helpers/crash-updater.mjs', import.meta.url), [], {
        env: { ...process.env, ICLOUD_CRASH_FIXTURE: JSON.stringify({ paths, html: sourceHtml(countries, '2026-04-11'), boundary }) },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      });
      let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
      sub.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
      const exited = once(child, 'exit');
      const reached = await Promise.race([
        once(child, 'message').then(([message]) => message),
        exited.then(([code, signal]) => { throw new Error(`child exited before checkpoint: ${code}/${signal}: ${stderr}`); })
      ]);
      assert.deepEqual(reached, { boundary });
      // The lock must reject another live writer, not steal ownership.
      await assert.rejects(main({ paths, dryRun: false, stepSummaryPath: null }), /lock|already running|another/i);
      child.kill('SIGKILL');
      assert.equal((await exited)[1], 'SIGKILL');
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response('<html>broken Apple</html>' + 'x'.repeat(20000));
      try {
        // Recovery runs before parsing. Force the next source to fail so no new
        // commit can hide whether rollback actually restored the old bytes.
        await assert.rejects(main({ paths, dryRun: false, stepSummaryPath: null,
          networkBudget: createNetworkBudget({ sleep: async () => {} }) }));
      } finally { globalThis.fetch = originalFetch; }
      assert.deepEqual(await allBytes(dataDir), before, `${target}: rollback must be byte-exact, without orphan/tmp/index drift`);
      await validateExtractedDataArtifact(dataDir);
    });
  }
});

test('seal: an unfamiliar heading cannot hide a pricing fragment from both production decoders', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-10T12:00:00Z') });
  for (const headerMode of ['unrecognized', 'missing']) {
    for (const amount of ['$0.99', 'N/A', '', '-', '$-1', '$1oops']) {
      await t.test(`${headerMode} header / ${amount || 'empty'} prices`, async (child) => {
        const { paths, dataDir } = await fixture(child);
        const initial = canonicalCountries();
        // Do not let digits in a synthetic market name masquerade as amounts.
        initial[0].country = 'Bahamas';
        await run(t, paths, [sourceHtml(initial, '2026-04-09')], '2026-04-10T12:00:00Z');
        const before = await allBytes(dataDir);
        const $ = load(sourceHtml(initial, '2026-04-10'));
        const original = $('table').first();
        const fragment = $('<table><thead></thead><tbody></tbody></table>');
        if (headerMode === 'unrecognized') {
          const header = original.find('thead tr').clone();
          header.children().first().text('Market (Currency)');
          fragment.find('thead').append(header);
        }
        fragment.find('tbody').append(original.find('tbody tr').first());
        fragment.find('tbody td').slice(1).text(amount);
        original.after('<h3>Additional iCloud plans</h3>', fragment);
        await assert.rejects(run(t, paths, [$.html(), $.html()], '2026-04-10T12:01:00Z'), /Unrecognized|Unexplained|unaccounted|pricing/i);
        assert.deepEqual(await allBytes(dataDir), before, 'unaccounted fragment must not publish a deletion or mutate any evidence');
        await validateExtractedDataArtifact(dataDir);
      });
    }
  }
});
