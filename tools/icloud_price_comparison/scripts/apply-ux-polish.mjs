import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return result;
});

await rewrite('style.css', (source) => {
  let result = replaceExactlyOnce(source,
`  .price-table th:first-child,
  .price-table td:first-child { display: none; }
  .price-table td.loading-cell:first-child,
  .price-table td.empty-cell:first-child { display: table-cell; }`,
`  .price-table th:first-child { display: none; }
  .price-table tbody tr[data-market-id] { position: relative; }
  .price-table tbody tr[data-market-id] > td:first-child {
    position: absolute;
    top: 50%;
    left: 12px;
    z-index: 1;
    width: 30px;
    height: 22px;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    transform: translateY(-50%);
    color: var(--accent-dark);
    background: var(--accent-soft);
    border: 1px solid #cfe2fa;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 760;
    line-height: 1;
  }
  .price-table td.loading-cell:first-child,
  .price-table td.empty-cell:first-child { display: table-cell; }`,
    'mobile rank badge');

  result = replaceExactlyOnce(result,
`  .price-table td:nth-child(2) { position: static; background: inherit; box-shadow: none; }`,
`  .price-table td:nth-child(2) { position: static; padding-left: 54px; background: inherit; box-shadow: none; }`,
    'mobile country rank spacing');

  result = replaceExactlyOnce(result,
`  .minimum-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }`,
`  .minimum-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 16px; }`,
    'three-column mobile minimum cards');

  result = replaceExactlyOnce(result,
`  .price-table th:nth-child(2),
  .price-table td:nth-child(2) { width: 43%; padding-left: 18px; }`,
`  .price-table th:nth-child(2),
  .price-table td:nth-child(2) { width: 43%; padding-left: 52px; }`,
    'small mobile country rank spacing');

  return replaceExactlyOnce(result,
`@media (prefers-reduced-motion: reduce) {`,
`@media (max-width: 359px) {
  .minimum-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .price-table tbody tr[data-market-id] > td:first-child { left: 8px; }
  .price-table th:nth-child(2),
  .price-table td:nth-child(2) { width: 46%; padding-left: 46px; }
}

@media (prefers-reduced-motion: reduce) {`,
    'narrow-mobile fallback');
});

await rewrite('test/ui-smoke.test.mjs', (source) => {
  const marker = `test('keeps mobile ranking visible and UX fallbacks stable'`;
  if (source.includes(marker)) throw new Error('UX regression test already exists');
  return `${source.trimEnd()}\n\n${String.raw`test('keeps mobile ranking visible and UX fallbacks stable', { timeout: 60_000 }, async (context) => {
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
        await page.goto(\`http://127.0.0.1:\${port}/\`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction((count) => document.querySelectorAll('#priceRows tr[data-market-id]').length === count, data.countries.length);
        await page.waitForFunction(() => document.querySelector('#loadStatus')?.hidden === true);

        const firstRank = page.locator('#priceRows tr[data-market-id] > td:first-child').first();
        assert.equal(await firstRank.isVisible(), true, \`\${viewport.width}px must expose the current rank or sequence\`);
        const rankBox = await firstRank.boundingBox();
        assert.ok(rankBox && rankBox.width >= 22 && rankBox.height >= 20, \`\${viewport.width}px rank badge must remain legible\`);

        const minimumColumns = await page.locator('#minimumSummary').evaluate((element) => (
          getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length
        ));
        assert.equal(minimumColumns, viewport.minimumColumns, \`\${viewport.width}px minimum-price cards should use the intended compact grid\`);

        await page.locator('#searchInput').fill('us');
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'us', 'exact marketId search must outrank substring matches such as Russia');

        await page.locator('#searchInput').fill('jp');
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'jp');

        await page.locator('#searchInput').fill(fallbackCountry.country);
        await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
        assert.equal((await page.locator('#priceRows .country-name-en').first().textContent()).trim(), fallbackCountry.currency, 'pending Chinese names must keep the currency subtitle after dynamic rendering');

        const layout = await page.evaluate(() => ({
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: document.documentElement.clientWidth
        }));
        assert.ok(layout.documentWidth <= layout.viewportWidth + 1, \`\${viewport.width}px page must not gain horizontal overflow\`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});`}\n`;
});

const { versions } = await updateAssetVersions({ projectDir: PROJECT_DIR });
console.log(`Applied iCloud UX polish; asset versions: ${JSON.stringify(versions)}`);
