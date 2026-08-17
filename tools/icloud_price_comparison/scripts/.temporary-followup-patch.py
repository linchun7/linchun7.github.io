from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'tools' / 'icloud_price_comparison'


def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one replacement, found {count}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


def append_once(path, marker, block):
    text = path.read_text(encoding='utf-8')
    if marker in text:
        return
    if not text.endswith('\n'):
        text += '\n'
    path.write_text(text + '\n' + block.rstrip() + '\n', encoding='utf-8')


# 1) Centralize search semantics in the small, docs-gated data model.
data_model = PROJECT / 'data-model.js'
data_model.write_text("""export const VALID_REGIONS = Object.freeze([
  'Americas',
  'Europe, Middle East & Africa',
  'Asia Pacific'
]);

export const REGION_LABELS = Object.freeze({
  Americas: '美洲',
  'Europe, Middle East & Africa': '欧洲、中东和非洲',
  'Asia Pacific': '亚太'
});

export const MARKET_SEARCH_ALIASES = Object.freeze({
  'euro-zone': Object.freeze(['eu', 'eurozone', 'euro zone']),
  ci: Object.freeze([\"cote d'ivoire\", \"côte d'ivoire\"]),
  cg: Object.freeze(['republic of the congo']),
  cn: Object.freeze(['mainland china']),
  gb: Object.freeze(['uk']),
  kr: Object.freeze(['south korea']),
  md: Object.freeze(['republic of moldova']),
  tr: Object.freeze(['turkey']),
  tz: Object.freeze(['united republic of tanzania']),
  us: Object.freeze(['usa', 'united states of america']),
  vn: Object.freeze(['viet nam'])
});

const VALID_REGION_SET = new Set(VALID_REGIONS);

export function isValidRegion(value) {
  return VALID_REGION_SET.has(value);
}

export function normalizeMarketSearchText(value, locale = 'zh-CN') {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase(locale);
}

export function marketSearchAliases(marketId) {
  return MARKET_SEARCH_ALIASES[marketId] ?? [];
}

export function matchesMarketSearch(country, query, { regionLabels = REGION_LABELS } = {}) {
  const normalizedQuery = normalizeMarketSearchText(query);
  if (!normalizedQuery) return true;
  const marketId = normalizeMarketSearchText(country.marketId, 'en-US');
  const names = normalizeMarketSearchText(`${country.country ?? ''} ${country.nameZh ?? ''}`);
  const region = normalizeMarketSearchText(`${country.region ?? ''} ${regionLabels[country.region] ?? ''}`);
  const currency = normalizeMarketSearchText(country.currency, 'en-US');
  const aliases = marketSearchAliases(country.marketId)
    .map((alias) => normalizeMarketSearchText(alias, 'en-US'));
  const regionSearchEnabled = [...normalizedQuery].length >= 2;
  return marketId.includes(normalizedQuery)
    || names.includes(normalizedQuery)
    || (regionSearchEnabled && region.includes(normalizedQuery))
    || aliases.some((alias) => alias.includes(normalizedQuery))
    || currency === normalizedQuery;
}

export function marketSearchPriority(country, query) {
  const normalizedQuery = normalizeMarketSearchText(query);
  if (!normalizedQuery) return 0;
  if (normalizeMarketSearchText(country.marketId, 'en-US') === normalizedQuery) return 2;
  return marketSearchAliases(country.marketId)
    .some((alias) => normalizeMarketSearchText(alias, 'en-US') === normalizedQuery) ? 1 : 0;
}

export function validateMarketSearchAliases(aliasMap = MARKET_SEARCH_ALIASES, marketIds = []) {
  if (!aliasMap || typeof aliasMap !== 'object' || Array.isArray(aliasMap)) {
    throw new Error('Market search aliases must be an object');
  }
  const knownIds = new Set(marketIds.map((marketId) => normalizeMarketSearchText(marketId, 'en-US')));
  const exactOwners = new Map();
  for (const [marketId, aliases] of Object.entries(aliasMap)) {
    const normalizedMarketId = normalizeMarketSearchText(marketId, 'en-US');
    if (marketId !== normalizedMarketId) {
      throw new Error(`Market search alias target must be a normalized marketId: ${marketId}`);
    }
    if (knownIds.size && !knownIds.has(normalizedMarketId)) {
      throw new Error(`Market search alias target is not a known marketId: ${marketId}`);
    }
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 32) {
      throw new Error(`Market search aliases are invalid for marketId: ${marketId}`);
    }
    const localAliases = new Set();
    for (const alias of aliases) {
      const normalized = typeof alias === 'string' ? normalizeMarketSearchText(alias, 'en-US') : '';
      if (typeof alias !== 'string'
        || alias !== alias.trim()
        || alias !== normalized
        || [...alias].length === 0
        || [...alias].length > 80
        || /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/u.test(alias)) {
        throw new Error(`Unsafe market search alias for ${marketId}: ${String(alias)}`);
      }
      if (localAliases.has(normalized)) {
        throw new Error(`Duplicate market search alias for ${marketId}: ${alias}`);
      }
      localAliases.add(normalized);
      if (knownIds.has(normalized) && normalized !== normalizedMarketId) {
        throw new Error(`Market search alias ${alias} shadows marketId ${normalized}`);
      }
      const existingOwner = exactOwners.get(normalized);
      if (existingOwner && existingOwner !== normalizedMarketId) {
        throw new Error(`Market search alias ${alias} belongs to both ${existingOwner} and ${marketId}`);
      }
      exactOwners.set(normalized, normalizedMarketId);
    }
  }
  return aliasMap;
}
""", encoding='utf-8')

# 2) Frontend consumes the centralized search model and exposes mobile rank semantics to assistive tech.
script = PROJECT / 'script.js'
replace_once(
    script,
    "import { marketSearchAliases, VALID_REGIONS } from './data-model.js?v=d365ae66';",
    "import { marketSearchPriority, matchesMarketSearch, normalizeMarketSearchText, REGION_LABELS, VALID_REGIONS } from './data-model.js?v=d365ae66';"
)
replace_once(
    script,
    "const REGION_LABELS = {\n  Americas: '美洲',\n  'Europe, Middle East & Africa': '欧洲、中东和非洲',\n  'Asia Pacific': '亚太'\n};\n",
    ""
)
replace_once(
    script,
    """function normalizedSearchQuery() {
  return state.query.trim().toLocaleLowerCase('zh-CN');
}

function normalizedMarketSearchAliases(country) {
  return marketSearchAliases(country.marketId)
    .map((alias) => alias.toLocaleLowerCase('en-US'));
}

function matchesCountrySearch(country, query) {
  if (!query) return true;
  const marketId = country.marketId.toLocaleLowerCase('en-US');
  const names = `${country.country} ${country.nameZh ?? ''}`.toLocaleLowerCase('zh-CN');
  const region = (REGION_LABELS[country.region] || country.region).toLocaleLowerCase('zh-CN');
  const currency = country.currency.toLocaleLowerCase('en-US');
  const aliases = normalizedMarketSearchAliases(country);
  return marketId.includes(query)
    || names.includes(query)
    || (query.length >= 2 && region.includes(query))
    || aliases.some((alias) => alias.includes(query))
    || currency === query;
}

function exactSearchIdentityPriority(country, query) {
  if (!query) return 0;
  if (country.marketId.toLocaleLowerCase('en-US') === query) return 2;
  return normalizedMarketSearchAliases(country).some((alias) => alias === query) ? 1 : 0;
}

function filteredCountries() {
  const query = normalizedSearchQuery();
  return state.data.countries.filter((country) => (
    matchesCountrySearch(country, query)
    && (state.region === 'all' || country.region === state.region)
  ));
}
""",
    """function normalizedSearchQuery() {
  return normalizeMarketSearchText(state.query);
}

function filteredCountries() {
  const query = normalizedSearchQuery();
  return state.data.countries.filter((country) => (
    matchesMarketSearch(country, query)
    && (state.region === 'all' || country.region === state.region)
  ));
}
"""
)
replace_once(
    script,
    """    const aIdentityPriority = exactSearchIdentityPriority(a, query);
    const bIdentityPriority = exactSearchIdentityPriority(b, query);
""",
    """    const aIdentityPriority = marketSearchPriority(a, query);
    const bIdentityPriority = marketSearchPriority(b, query);
"""
)
replace_once(
    script,
    """    const mobileRank = row.querySelector('.mobile-rank');
    if (mobileRank) mobileRank.textContent = String(rank);
""",
    """    const mobileRank = row.querySelector('.mobile-rank');
    if (mobileRank) mobileRank.textContent = String(rank);
    const mobileRankSr = row.querySelector('.mobile-rank-sr');
    if (mobileRankSr) mobileRankSr.textContent = `全球价格排名第 ${rank}`;
"""
)
replace_once(
    script,
    """function createCell(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}
""",
    """function createCell(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function mobileRankAccessibilityText(displayedRank) {
  if (displayedRank === '—') return '排名暂不可用';
  return state.sortKey === 'country'
    ? `当前列表序号第 ${displayedRank}`
    : `全球价格排名第 ${displayedRank}`;
}
"""
)
replace_once(
    script,
    """      historyButton.append(mobileRank);
      if (secondaryName) {
""",
    """      historyButton.append(mobileRank);
      const mobileRankSr = document.createElement('span');
      mobileRankSr.className = 'mobile-rank-sr visually-hidden';
      mobileRankSr.textContent = mobileRankAccessibilityText(displayedRank);
      historyButton.append(mobileRankSr);
      if (secondaryName) {
"""
)

# 3) Static fallback carries the same assistive rank/sequence semantics.
static_page = PROJECT / 'scripts' / 'static-page.mjs'
replace_once(
    static_page,
    """    `              <span class=\"mobile-rank\" aria-hidden=\"true\">${escapeHtml(rank)}</span>`,
    secondary.trimEnd(),
""",
    """    `              <span class=\"mobile-rank\" aria-hidden=\"true\">${escapeHtml(rank)}</span>`,
    `              <span class=\"mobile-rank-sr visually-hidden\">全球价格排名第 ${escapeHtml(rank)}</span>`,
    secondary.trimEnd(),
"""
)
style = PROJECT / 'style.css'
replace_once(style, ".mobile-rank { display: none; }\n", ".mobile-rank { display: none; }\n.mobile-rank-sr { display: none; }\n")
replace_once(
    style,
    """  .price-local { font-size: 12px; }
  .minimum-badge { max-width: 32px; padding-inline: 5px; overflow: hidden; font-size: 10px; text-overflow: clip; }
""",
    """  .mobile-rank-sr { display: block; }
  .price-local { font-size: 12px; }
  .minimum-badge { max-width: 32px; padding-inline: 5px; overflow: hidden; font-size: 10px; text-overflow: clip; }
"""
)

# 4) Published identity aliases can preserve the existing ID; collisions use one error family.
registry = PROJECT / 'scripts' / 'market-registry.mjs'
replace_once(
    registry,
    """    // Once a source name has been published, its identity ledger wins even if a later
    // registry/reservation review discovers a nicer human-facing code. A deliberate
    // migration must update prices/history together instead of silently re-keying here.
""",
    """    // Once a source name has been published, its identity ledger wins. Reviewed
    // source aliases may teach the resolver a new Apple spelling, but they must keep
    // the already-published marketId rather than creating a rekey path.
"""
)
replace_once(
    registry,
    """    const existingOwners = published.ownersById.get(resolved.id);
    if (existingOwners?.length) throw reservedIdentityCollisionError(resolved.id, name, existingOwners);
    return resolved;
""",
    """    const existingOwners = published.ownersById.get(resolved.id);
    if (existingOwners?.length) {
      if (!resolved.unknown) {
        const acceptedNames = new Set([resolved.canonicalName, ...(resolved.aliases ?? [])].map(normalizedNameKey));
        const conflicts = existingOwners.filter(({ identityKey: ownerKey }) => !acceptedNames.has(ownerKey));
        if (!conflicts.length) {
          return {
            ...resolved,
            sourceName: name,
            nameZh: getOfficialChineseMarketName(resolved.id) ?? name,
            reserved: false,
            published: true,
            preservedPublishedIdentity: false
          };
        }
        throw reservedIdentityCollisionError(resolved.id, name, conflicts);
      }
      throw reservedIdentityCollisionError(resolved.id, name, existingOwners);
    }
    return resolved;
"""
)
replace_once(
    registry,
    """  for (const market of Object.values(registry)) {
    const publishedNames = publishedNamesById.get(market.id);
    if (!publishedNames) continue;
    const registryNames = [market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey);
    if (!registryNames.some((name) => publishedNames.has(name))) {
      throw marketIdentityError(`registry market ${market.canonicalName} occupies reserved marketId ${market.id}`);
    }
  }
""",
    """  for (const market of Object.values(registry)) {
    const owners = published.ownersById.get(market.id);
    if (!owners?.length) continue;
    const acceptedNames = new Set([market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey));
    const conflicts = owners.filter(({ identityKey }) => !acceptedNames.has(identityKey));
    if (conflicts.length) {
      throw reservedIdentityCollisionError(market.id, market.canonicalName, conflicts);
    }
  }
"""
)
replace_once(
    registry,
    """    if (conflicts.length) {
      const occupiedBy = conflicts.map(({ sourceName, location }) => `${sourceName} (${location})`).join(', ');
      throw marketIdentityError(`future market ${market.canonicalName} cannot reserve historical marketId ${market.id}; occupied by ${occupiedBy}`);
    }
""",
    """    if (conflicts.length) {
      throw reservedIdentityCollisionError(market.id, market.canonicalName, conflicts);
    }
"""
)

# 5) Unique structural rename candidates fail closed even if Apple reprices at the same time.
update_prices = PROJECT / 'scripts' / 'update-prices.mjs'
replace_once(
    update_prices,
    """  const exactCandidates = diagnostics.filter(({ pricesMatch }) => pricesMatch);
  const exactCountByOld = new Map();
  const exactCountByNew = new Map();
  for (const candidate of exactCandidates) {
    exactCountByOld.set(candidate.oldMarketId, (exactCountByOld.get(candidate.oldMarketId) ?? 0) + 1);
    exactCountByNew.set(candidate.newSourceName, (exactCountByNew.get(candidate.newSourceName) ?? 0) + 1);
  }
  const uniqueExactCandidates = exactCandidates.filter((candidate) => (
    exactCountByOld.get(candidate.oldMarketId) === 1
    && exactCountByNew.get(candidate.newSourceName) === 1
  ));
  if (!uniqueExactCandidates.length) return { status: 'suspected', warnings: diagnostics };
  const details = uniqueExactCandidates
    .map(({ oldSourceName, oldMarketId, newSourceName }) => `${oldSourceName} (${oldMarketId}) -> ${newSourceName}`)
    .join('; ');
  const error = new Error(`MARKET_IDENTITY_RENAME_REVIEW_REQUIRED: ${details}. Add the new Apple source name as an alias for the published marketId, then rerun.`);
  error.code = 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED';
  error.candidates = uniqueExactCandidates;
""",
    """  const uniqueOneToOneCandidates = (items) => {
    const countByOld = new Map();
    const countByNew = new Map();
    for (const candidate of items) {
      countByOld.set(candidate.oldMarketId, (countByOld.get(candidate.oldMarketId) ?? 0) + 1);
      countByNew.set(candidate.newSourceName, (countByNew.get(candidate.newSourceName) ?? 0) + 1);
    }
    return items.filter((candidate) => (
      countByOld.get(candidate.oldMarketId) === 1
      && countByNew.get(candidate.newSourceName) === 1
    ));
  };
  const reviewCandidates = new Map();
  for (const candidate of [
    ...uniqueOneToOneCandidates(diagnostics.filter(({ pricesMatch }) => pricesMatch)),
    ...uniqueOneToOneCandidates(diagnostics)
  ]) {
    reviewCandidates.set(`${candidate.oldMarketId}\\u0000${candidate.newSourceName}`, candidate);
  }
  const requiredReview = [...reviewCandidates.values()];
  if (!requiredReview.length) return { status: 'suspected', warnings: diagnostics };
  const details = requiredReview
    .map(({ oldSourceName, oldMarketId, newSourceName, pricesMatch }) => `${oldSourceName} (${oldMarketId}) -> ${newSourceName}${pricesMatch ? '' : ' [repriced]'}`)
    .join('; ');
  const error = new Error(`MARKET_IDENTITY_RENAME_REVIEW_REQUIRED: ${details}. Add the new Apple source name as a reviewed source alias for the published marketId, then rerun.`);
  error.code = 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED';
  error.candidates = requiredReview;
"""
)

# Update the existing regression to require review for a unique repriced pair, while ambiguous repriced candidates remain warnings.
update_test = PROJECT / 'test' / 'update-prices.test.mjs'
replace_once(
    update_test,
    """  const repriced = structuredClone(added);
  repriced.plans['50GB'].price = 1.09;
  const review = validateAppleMarketRenameReview({ countries: [old] }, [repriced], resolveMarket);
  assert.equal(review.status, 'suspected');
  assert.equal(review.warnings.length, 1);
  assert.equal(review.warnings[0].pricesMatch, false);
});
""",
    """  const repriced = structuredClone(added);
  repriced.plans['50GB'].price = 1.09;
  assert.throws(
    () => validateAppleMarketRenameReview({ countries: [old] }, [repriced], resolveMarket),
    (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
      && error.candidates?.some(({ pricesMatch }) => pricesMatch === false)
  );

  const secondOld = {
    ...structuredClone(old),
    country: 'Second Germany Placeholder',
    marketId: 'second-legacy-de-owner'
  };
  const ambiguous = validateAppleMarketRenameReview({ countries: [old, secondOld] }, [repriced], resolveMarket);
  assert.equal(ambiguous.status, 'suspected');
  assert.equal(ambiguous.warnings.length, 2);
  assert.ok(ambiguous.warnings.every(({ pricesMatch }) => pricesMatch === false));
});
"""
)

# 6) Focused core regression suite for the follow-up contracts.
followup_test = PROJECT / 'test' / 'followup-hardening.test.mjs'
followup_test.write_text("""import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  MARKET_SEARCH_ALIASES,
  marketSearchPriority,
  matchesMarketSearch,
  normalizeMarketSearchText,
  validateMarketSearchAliases
} from '../data-model.js';
import {
  createMarketResolver,
  createPublishedMarketResolver,
  validateMarketIdentityContinuity
} from '../scripts/market-registry.mjs';
import { renderStaticFragments } from '../scripts/static-page.mjs';

test('search normalization covers compatibility forms and both raw/localized region labels', () => {
  const us = { marketId: 'us', country: 'United States', nameZh: '美国', region: 'Americas', currency: 'USD' };
  const cn = { marketId: 'cn', country: 'China mainland', nameZh: '中国大陆', region: 'Asia Pacific', currency: 'CNY' };
  const ng = { marketId: 'ng', country: 'Nigeria', nameZh: '尼日利亚', region: 'Europe, Middle East & Africa', currency: 'NGN' };
  assert.equal(normalizeMarketSearchText(' ＵＳ '), 'us');
  assert.equal(matchesMarketSearch(us, 'ＵＳ'), true);
  assert.equal(marketSearchPriority(us, 'ＵＳ'), 2);
  assert.equal(matchesMarketSearch(cn, '中'), true);
  assert.equal(matchesMarketSearch(ng, '中'), false);
  assert.equal(matchesMarketSearch(ng, '中东'), true);
  assert.equal(matchesMarketSearch(ng, 'Middle East'), true);
  assert.equal(matchesMarketSearch(us, 'Americas'), true);
  assert.equal(matchesMarketSearch(cn, 'Asia Pacific'), true);
});

test('published fallback IDs can receive friendly search aliases only after conflicting candidate IDs are removed', () => {
  const fallbackId = 'apple-reviewed-market-12345678';
  assert.equal(validateMarketSearchAliases({ [fallbackId]: ['de'] }, [fallbackId])[fallbackId][0], 'de');
  assert.throws(
    () => validateMarketSearchAliases({ [fallbackId]: ['de'] }, [fallbackId, 'de']),
    /shadows marketId de/
  );
  assert.equal(validateMarketSearchAliases(MARKET_SEARCH_ALIASES, [
    'euro-zone', 'ci', 'cg', 'cn', 'gb', 'kr', 'md', 'tr', 'tz', 'us', 'vn'
  ]), MARKET_SEARCH_ALIASES);
});

test('reviewed Apple source aliases preserve an already-published fallback identity', () => {
  const fallbackId = 'apple-legacy-raw-name-12345678';
  const registry = {
    'Reviewed Name': { id: fallbackId, canonicalName: 'Reviewed Name', aliases: ['Legacy Raw Name'], reserved: false }
  };
  const resolve = createMarketResolver(registry, { reservedRegistry: {} });
  const previousHistory = {
    schemaVersion: 4,
    markets: { [fallbackId]: { country: 'Legacy Raw Name' } }
  };
  const resolver = createPublishedMarketResolver(null, previousHistory, { registry, resolveUnknown: resolve });
  const resolved = resolver('Reviewed Name');
  assert.equal(resolved.id, fallbackId);
  assert.equal(resolved.published, true);
  assert.equal(resolved.unknown, false);
  assert.doesNotThrow(() => validateMarketIdentityContinuity(null, previousHistory, { registry, resolve }));
});

test('different identities claiming the same historical ID use the collision error family', () => {
  const registry = {
    'New Owner': { id: 'stable-id', canonicalName: 'New Owner', aliases: [], reserved: false }
  };
  const resolve = createMarketResolver(registry, { reservedRegistry: {} });
  const previousHistory = {
    schemaVersion: 4,
    markets: { 'stable-id': { country: 'Old Owner' } }
  };
  assert.throws(
    () => validateMarketIdentityContinuity(null, previousHistory, { registry, resolve }),
    (error) => error.code === 'MARKET_IDENTITY_RESERVED_ID_COLLISION'
  );
});

test('static fallback includes an assistive mobile rank label separate from the visual badge', async () => {
  const payload = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
  const fragments = renderStaticFragments(payload);
  const html = typeof fragments === 'string' ? fragments : JSON.stringify(fragments);
  assert.match(html, /mobile-rank[^>]*aria-hidden=\\"true\\"/);
  assert.match(html, /mobile-rank-sr visually-hidden[^>]*>全球价格排名第 /);
});
""", encoding='utf-8')

package_json = PROJECT / 'package.json'
replace_once(
    package_json,
    'test/data-integrity.test.mjs test/documentation-contract.test.mjs test/market-identity-reservations.test.mjs',
    'test/data-integrity.test.mjs test/documentation-contract.test.mjs test/followup-hardening.test.mjs test/market-identity-reservations.test.mjs'
)

# 7) Add focused browser regressions without rewriting the large UI suite.
ui_test = PROJECT / 'test' / 'ui-smoke.test.mjs'
append_once(ui_test, "normalizes compatibility search and exposes mobile rank semantics", r"""
test('normalizes compatibility search and exposes mobile rank semantics', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the search normalization and mobile accessibility regression test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://**/*', (route) => route.abort());
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 0);
    const search = page.locator('#searchInput');

    await search.fill('ＵＳ');
    await page.waitForFunction(() => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === 'us');
    assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'us');

    await search.fill('Americas');
    await page.waitForFunction(() => document.querySelector('#priceRows tr[data-market-id="us"]'));
    assert.equal(await page.locator('#priceRows tr[data-market-id="us"]').count(), 1);
    assert.equal(await page.locator('#priceRows tr[data-market-id="ng"]').count(), 0);

    await search.fill('Asia Pacific');
    await page.waitForFunction(() => document.querySelector('#priceRows tr[data-market-id="jp"]'));
    assert.equal(await page.locator('#priceRows tr[data-market-id="jp"]').count(), 1);
    assert.equal(await page.locator('#priceRows tr[data-market-id="ng"]').count(), 0);

    await search.fill('');
    const rankText = page.locator('#priceRows .mobile-rank-sr').first();
    assert.match((await rankText.textContent()).trim(), /^全球价格排名第 \\d+$/);
    assert.notEqual(await rankText.evaluate((element) => getComputedStyle(element).display), 'none');

    await page.locator('button[data-sort="country"]').click();
    await page.waitForFunction(() => document.querySelector('#priceRows .mobile-rank-sr')?.textContent === '当前列表序号第 1');
    assert.equal((await page.locator('#priceRows .mobile-rank-sr').first().textContent()).trim(), '当前列表序号第 1');
  } finally {
    await browser.close();
    await server.close(() => {});
  }
});
""")

# 8) Documentation: precise search semantics, fallback promotion, rename+repricing safety, a11y, and a narrower docs gate.
readme = PROJECT / 'README.md'
replace_once(
    readme,
    "- 搜索对 `marketId`、人工维护的 search alias、中英文国家/地区名称使用部分字符串匹配；地区名称仅在搜索词至少 2 个字符时参与部分匹配，避免单字（例如“中”）误命中“欧洲、中东和非洲”等地区标签；完整 `marketId` 命中优先级最高，完整 search alias 次之，但都不排除其他合法部分匹配；币种仅按完整代码匹配，避免短字母把同币种市场全部带出。",
    "- 搜索输入先做 Unicode NFKC 规范化，再对 `marketId`、人工维护的 search alias、中英文国家/地区名称做部分字符串匹配；地区搜索同时覆盖 Apple 原始英文 region 与中文显示标签，但只有搜索词至少 2 个 Unicode 字符时才参与，避免单字（例如“中”）误命中“欧洲、中东和非洲”；完整 `marketId` 命中优先级最高，完整 search alias 次之；币种仅按完整代码匹配。"
)
replace_once(
    readme,
    "- 容量价格排序使用全球参考排名；国家/地区排序使用列表序号，移动端用 `序N` 区分序号与排名。",
    "- 容量价格排序使用全球参考排名；国家/地区排序使用列表序号，移动端用 `序N` 区分序号与排名，并提供独立的读屏文本“全球价格排名第 N / 当前列表序号第 N”，视觉徽标本身不重复进入无障碍名称。"
)
replace_once(
    readme,
    "如果一个真正未知市场已经以 `apple-*` fallback 发布，后来才确认它对应某个友好代码，**仍然不 rekey**：这个 `apple-*` 就是该市场的永久 identity。只给原 `marketId` 增加合适的 `MARKET_SEARCH_ALIASES`，让用户用友好代码找到它而不破坏历史。",
    "如果一个真正未知市场已经以 `apple-*` fallback 发布，后来才完成正式识别，**仍然不 rekey**：这个 `apple-*` 就是该市场的永久 identity。收编时把同一个 `apple-*` 加入 active registry，canonical name / source aliases 必须同时覆盖历史 Apple 名称与当前 Apple 名称；删除与该身份名称或友好代码冲突的 future reservation，并为这个永久 ID 增加 Apple 中文名称 authority（可先为 `null`）。只有冲突的 future reservation 已移除后，才可按需给这个永久 ID 增加 `MARKET_SEARCH_ALIASES`（例如友好两位码）；search alias 仍不参与 identity 决策。"
)
replace_once(
    readme,
    "- 不做模糊名称匹配，不自动把“疑似改名”绑定到旧市场。只有满足严格双向唯一和完整结构一致的高置信 ambiguity 才停止并要求显式 alias；弱信号只记录 review warning。",
    "- 不做模糊名称匹配，不自动把“疑似改名”绑定到旧市场。removed/added 若在 region、currency、canonical tier set 上形成一对一唯一结构候选，即使同一批次同时 repricing 也停止并要求显式 source alias；价格向量完全相同仍可作为多候选中的强 disambiguation。只有结构上仍存在多义性的弱信号才记录 review warning。"
)
replace_once(
    readme,
    "关键架构文件发生变化时，PR CI 会强制要求 `README.md` 与 `OPERATIONS.md` 同步修改；只改代码不更新这两份长期文档会直接失败。文档契约测试随后继续校验关键规则内容，避免只做空白式文档改动。",
    "关键架构事实源发生变化时，PR CI 会强制要求 `README.md` 与 `OPERATIONS.md` 同步修改；identity/data contract、`data-model.js` 中的搜索契约、生成器和关键 update/validate workflow 属于强制范围。`script.js` 作为宽泛 UI/render glue 不再因任意小改动触发两份长文档，但搜索核心语义已集中到受门禁保护的 `data-model.js`。文档契约测试继续校验关键规则内容。PR 还会直接检查 base→head 已发布 marketId 不被删除或原名 rekey，并对已提交差异执行 `git diff --check`。"
)

operations = PROJECT / 'OPERATIONS.md'
replace_once(
    operations,
    "- 搜索对 `marketId`、`MARKET_SEARCH_ALIASES`、中英文国家/地区名做部分匹配；地区名仅在搜索词至少 2 个字符时参与部分匹配，防止单字误命中整片分区；完整 `marketId` 优先级最高，完整 search alias 次之，均不排除其他部分匹配；币种只按完整代码匹配。",
    "- 搜索输入先做 Unicode NFKC 规范化；`marketId`、`MARKET_SEARCH_ALIASES`、中英文国家/地区名做部分匹配。地区搜索同时覆盖 Apple 原始英文 region 与中文显示标签，但仅在查询至少 2 个 Unicode 字符时参与；完整 `marketId` 优先级最高，完整 search alias 次之，币种只按完整代码匹配。"
)
replace_once(
    operations,
    "- 对关键架构 PR 执行文档同步门禁：命中 identity、数据契约、核心搜索/生成器或关键 update/validate workflow 时，`README.md` 与 `OPERATIONS.md` 必须同时进入 diff。",
    "- 对关键架构 PR 执行文档同步门禁：identity、数据契约、`data-model.js` 搜索事实源、生成器或关键 update/validate workflow 变化时，`README.md` 与 `OPERATIONS.md` 必须同时进入 diff；宽泛 `script.js` 的普通 UI/render 小改动不再单独触发该门禁。PR 同时比较 base→head 的已发布 marketId ledger，并检查已提交 diff 格式。"
)
replace_once(
    operations,
    "- 已发布 `apple-*` fallback 永久保持原 ID。后来确认了更友好的代码时，只在 `data-model.js` 的 `MARKET_SEARCH_ALIASES` 添加用户搜索 alias，不改变价格/历史 identity。",
    "- 已发布 `apple-*` fallback 永久保持原 ID。正式收编时 active registry 继续使用该 `apple-*`，source aliases 同时覆盖历史/当前 Apple 英文名称；移除与其名称或友好代码冲突的 future reservation，并给该永久 ID 增加中文名称 authority。只有冲突 reservation 已移除后才可按需增加浏览器 search alias；任何步骤都不得改变 prices/history identity。"
)
replace_once(
    operations,
    "- 只有 removed 与 added unknown 双向唯一，并且 region、currency、canonical tier set 和完整当地价格向量完全相同，才作为高置信 rename ambiguity 停止并要求显式 alias；repricing、多候选或其他弱信号只记录 `MARKET_IDENTITY_RENAME_SUSPECTED`，不得自动绑定旧 ID。",
    "- removed/added 在 region、currency、canonical tier set 上形成一对一唯一结构候选时，即使 Apple 同批 repricing 也以 `MARKET_IDENTITY_RENAME_REVIEW_REQUIRED` 停止并要求显式 source alias；完整当地价格向量相同仍用于多候选 disambiguation。只有结构上仍多义的候选才记录 `MARKET_IDENTITY_RENAME_SUSPECTED`，不得自动绑定旧 ID。"
)

print('follow-up patch applied')
