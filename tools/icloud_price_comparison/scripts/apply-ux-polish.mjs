import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderStaticPage } from './render-static-page.mjs';
import { updateAssetVersions } from './update-asset-versions.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) {
    if (source.includes(after)) return source;
    throw new Error(`Missing expected source for ${label}`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Ambiguous source for ${label}`);
  }
  return `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

async function rewrite(relativePath, transform) {
  const filePath = path.join(PROJECT_DIR, relativePath);
  const source = await readFile(filePath, 'utf8');
  const result = transform(source);
  if (result === source) throw new Error(`No changes produced for ${relativePath}`);
  await writeFile(filePath, result, 'utf8');
}

await rewrite('script.js', (source) => {
  let result = replaceExactlyOnce(source,
`function filteredCountries() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.data.countries.filter((country) => {
    const searchable = \`${'${country.country} ${country.nameZh} ${country.currency} ${REGION_LABELS[country.region] || country.region}'}\`.toLocaleLowerCase('zh-CN');
    return (!query || searchable.includes(query))
      && (state.region === 'all' || country.region === state.region);
  });
}`,
`function filteredCountries() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const exactMarketId = query
    ? state.data.countries.find(({ marketId }) => marketId.toLocaleLowerCase('en-US') === query)?.marketId
    : null;
  return state.data.countries.filter((country) => {
    const searchable = \`${'${country.country} ${country.nameZh} ${country.currency} ${REGION_LABELS[country.region] || country.region}'}\`.toLocaleLowerCase('zh-CN');
    const matchesQuery = !query
      || (exactMarketId ? country.marketId === exactMarketId : searchable.includes(query));
    return matchesQuery
      && (state.region === 'all' || country.region === state.region);
  });
}`,
    'exact marketId search');

  result = replaceExactlyOnce(result,
`      const secondaryName = country.nameZh && country.nameZh !== country.country
        ? \`${'${country.country} · ${country.currency}'}\`
        : '';`,
`      const secondaryName = country.nameZh && country.nameZh !== country.country
        ? \`${'${country.country} · ${country.currency}'}\`
        : country.currency;`,
    'fallback currency subtitle');

  result = replaceExactlyOnce(result,
`  for (const { rank, row } of rankedRows) {
    const rankCell = row.cells[0];
    rankCell.textContent = String(rank);
    rankCell.classList.toggle('rank-top', !staticSnapshotFxStale && state.sortDirection === 'asc' && rank <= 3);
  }`,
`  for (const { rank, row } of rankedRows) {
    const rankCell = row.cells[0];
    rankCell.textContent = String(rank);
    rankCell.classList.toggle('rank-top', !staticSnapshotFxStale && state.sortDirection === 'asc' && rank <= 3);
    const historyButton = row.querySelector('.country-history-button');
    if (historyButton) historyButton.dataset.mobileRank = String(rank);
  }`,
    'static mobile rank reconciliation');

  result = replaceExactlyOnce(result,
`      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
      historyButton.disabled = state.dataFreshness?.status === 'unusable';`,
`      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
      historyButton.dataset.mobileRank = String(displayedRank);
      historyButton.disabled = state.dataFreshness?.status === 'unusable';`,
    'dynamic mobile rank cue');
  return result;
});

await rewrite('scripts/static-page.mjs', (source) => replaceExactlyOnce(source,
`    '              <button class="country-history-button" type="button" disabled>',`,
`    \`              <button class="country-history-button" type="button" data-mobile-rank="\${escapeHtml(rank)}" disabled>\`,`,
  'static mobile rank cue'));

await rewrite('style.css', (source) => {
  let result = replaceExactlyOnce(source,
`  .country-history-button { min-height: 44px; padding-block: 5px; }`,
`  .country-history-button { min-height: 44px; padding-right: 64px; padding-block: 5px; }
  .country-history-button[data-mobile-rank]::after {
    position: absolute;
    top: 50%;
    right: 28px;
    min-width: 28px;
    height: 22px;
    padding: 0 5px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    content: attr(data-mobile-rank);
    transform: translateY(-50%);
    color: var(--accent-dark);
    background: var(--accent-soft);
    border: 1px solid #cfe2fa;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 760;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }`,
    'mobile rank badge');

  result = replaceExactlyOnce(result,
`  .minimum-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }`,
`  .minimum-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }`,
    'three-column mobile minimum cards');

  return replaceExactlyOnce(result,
`@media (prefers-reduced-motion: reduce) {`,
`@media (max-width: 359px) {
  .minimum-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (prefers-reduced-motion: reduce) {`,
    'narrow-mobile minimum-card fallback');
});

await rewrite('test/ui-smoke.test.mjs', (source) => {
  const marker = `test('keeps mobile ranking visible and UX fallbacks stable'`;
  if (source.includes(marker)) throw new Error('UX regression test already exists');
  const testSource = `test('keeps mobile ranking visible and UX fallbacks stable', { timeout: 60_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the mobile ranking and UX regression test');
  if (!browserConfig) return;
  const data = await readFixture('prices.json');
  const fallbackCountry = data.countries.find(({ country, nameZh }) => nameZh === country);
  assert.ok(fallbackCountry, 'the fixture needs at least one market pending an official Chinese name');
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  try {
    for (const viewport of [
      { width: 390, height: 844, minimumColumns: 3 },
      { width: 320, height: 720, minimumColumns: 2 }
    ]) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      await page.route('https://**/*', (route) => {
        if (route.request().url().startsWith('https://www.googletagmanager.com/')) {
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        }
        return route.abort();
      });
      try {
        await page.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, data.countries.length);
        await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);

        const firstHistoryButton = page.locator('#priceRows tr[data-market-id] .country-history-button').first();
        const rankCue = await firstHistoryButton.evaluate((button) => ({
          rank: button.dataset.mobileRank,
          content: getComputedStyle(button, '::after').content,
          paddingRight: Number.parseFloat(getComputedStyle(button).paddingRight)
        }));
        assert.ok(rankCue.rank && rankCue.content.includes(rankCue.rank), String(viewport.width) + 'px must expose the current rank or sequence');
        assert.ok(rankCue.paddingRight >= 60, String(viewport.width) + 'px rank badge must reserve non-overlapping space');

        const minimumColumns = await page.locator('#minimumSummary').evaluate((element) => (
          getComputedStyle(element).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length
        ));
        assert.equal(minimumColumns, viewport.minimumColumns, String(viewport.width) + 'px minimum-price cards should use the intended compact grid');

        await page.locator('#searchInput').fill('us');
        await page.waitForFunction((id) => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === id, 'us');
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'us', 'exact marketId search must outrank substring matches such as Russia');

        await page.locator('#searchInput').fill('jp');
        await page.waitForFunction((id) => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === id, 'jp');
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'jp');

        await page.locator('#searchInput').fill(fallbackCountry.country);
        await page.waitForFunction((id) => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === id, fallbackCountry.marketId);
        assert.equal((await page.locator('#priceRows .country-name-en').first().textContent()).trim(), fallbackCountry.currency, 'pending Chinese names must keep the currency subtitle after dynamic rendering');

        const layout = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        }));
        assert.ok(layout.documentWidth <= layout.viewportWidth + 1, String(viewport.width) + 'px page must not gain horizontal overflow');
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});`;
  return `${source.trimEnd()}\n\n${testSource}\n`;
});

await renderStaticPage({ write: true });
const { versions } = await updateAssetVersions({ projectDir: PROJECT_DIR });
console.log(`Applied iCloud UX polish; asset versions: ${JSON.stringify(versions)}`);
