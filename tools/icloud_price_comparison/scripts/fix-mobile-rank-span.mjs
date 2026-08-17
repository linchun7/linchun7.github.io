import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { updateAssetVersions } from './update-asset-versions.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Missing expected source for ${label}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Ambiguous source for ${label}`);
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
`    const historyButton = row.querySelector('.country-history-button');
    if (historyButton) historyButton.dataset.mobileRank = String(rank);`,
`    const mobileRank = row.querySelector('.mobile-rank');
    if (mobileRank) mobileRank.textContent = String(rank);`,
    'static rank reconciliation');

  result = replaceExactlyOnce(result,
`      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
      historyButton.dataset.mobileRank = String(displayedRank);
      historyButton.disabled = state.dataFreshness?.status === 'unusable';`,
`      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
      historyButton.disabled = state.dataFreshness?.status === 'unusable';`,
    'remove mobile rank data attribute');

  return replaceExactlyOnce(result,
`      historyButton.append(name);
      if (secondaryName) {`,
`      historyButton.append(name);
      const mobileRank = document.createElement('span');
      mobileRank.className = 'mobile-rank';
      mobileRank.setAttribute('aria-hidden', 'true');
      mobileRank.textContent = String(displayedRank);
      historyButton.append(mobileRank);
      if (secondaryName) {`,
    'dynamic mobile rank span');
});

await rewrite('scripts/static-page.mjs', (source) => {
  let result = replaceExactlyOnce(source,
`    \`              <button class="country-history-button" type="button" data-mobile-rank="\${escapeHtml(rank)}" disabled>\`,`,
`    '              <button class="country-history-button" type="button" disabled>',`,
    'remove static rank data attribute');
  return replaceExactlyOnce(result,
`    \`              <span class="country-name">\${escapeHtml(displayName(country))}</span>\`,
    secondary.trimEnd(),`,
`    \`              <span class="country-name">\${escapeHtml(displayName(country))}</span>\`,
    \`              <span class="mobile-rank" aria-hidden="true">\${escapeHtml(rank)}</span>\`,
    secondary.trimEnd(),`,
    'static mobile rank span');
});

await rewrite('style.css', (source) => {
  let result = replaceExactlyOnce(source,
`.history-affordance { position: absolute; top: 50%; right: 2px; color: var(--muted); font-size: 20px; line-height: 1; opacity: .7; transform: translateY(-50%); transition: color 120ms ease-out, opacity 120ms ease-out; }`,
`.mobile-rank { display: none; }
.history-affordance { position: absolute; top: 50%; right: 2px; color: var(--muted); font-size: 20px; line-height: 1; opacity: .7; transform: translateY(-50%); transition: color 120ms ease-out, opacity 120ms ease-out; }`,
    'default hidden mobile rank');

  return replaceExactlyOnce(result,
`  .country-history-button[data-mobile-rank]::after {
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
`  .mobile-rank {
    position: absolute;
    top: 50%;
    right: 28px;
    min-width: 28px;
    height: 22px;
    padding: 0 5px;
    display: inline-flex;
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
    font-variant-numeric: tabular-nums;
  }`,
    'real mobile rank span styling');
});

await rewrite('test/ui-smoke.test.mjs', (source) => replaceExactlyOnce(source,
`        const firstHistoryButton = page.locator('#priceRows tr[data-market-id] .country-history-button').first();
        const rankCue = await firstHistoryButton.evaluate((button) => ({
          rank: button.dataset.mobileRank,
          content: getComputedStyle(button, '::after').content,
          paddingRight: Number.parseFloat(getComputedStyle(button).paddingRight)
        }));
        assert.ok(rankCue.rank && rankCue.content.includes(rankCue.rank), String(viewport.width) + 'px must expose the current rank or sequence');
        assert.ok(rankCue.paddingRight >= 60, String(viewport.width) + 'px rank badge must reserve non-overlapping space');`,
`        const firstHistoryButton = page.locator('#priceRows tr[data-market-id] .country-history-button').first();
        const rankBadge = firstHistoryButton.locator('.mobile-rank');
        const rankCue = await firstHistoryButton.evaluate((button) => ({
          paddingRight: Number.parseFloat(getComputedStyle(button).paddingRight)
        }));
        assert.equal(await rankBadge.isVisible(), true, String(viewport.width) + 'px must expose the current rank or sequence');
        assert.match((await rankBadge.textContent()).trim(), /^\\d+|—$/, String(viewport.width) + 'px rank badge must contain the current rank or sequence');
        assert.ok(rankCue.paddingRight >= 60, String(viewport.width) + 'px rank badge must reserve non-overlapping space');`,
  'cross-browser rank test'));

const { renderStaticPage } = await import('./render-static-page.mjs?rank-span=1');
await renderStaticPage({ write: true });
const { versions } = await updateAssetVersions({ projectDir: PROJECT_DIR });
console.log(`Applied cross-browser mobile rank fix; asset versions: ${JSON.stringify(versions)}`);
