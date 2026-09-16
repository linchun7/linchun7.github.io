export const VALID_REGIONS = Object.freeze([
  'Americas',
  'Europe, Middle East & Africa',
  'Asia Pacific'
]);

export const REGION_LABELS = Object.freeze({
  Americas: '美洲',
  'Europe, Middle East & Africa': '欧洲、中东和非洲',
  'Asia Pacific': '亚太'
});

export const REVIEWED_PUBLICATION_RENAMES = Object.freeze([
  Object.freeze({ marketId: 'ci', from: 'Ivory Coast', to: "Cote D'Ivoire" })
]);

const VALID_REGION_SET = new Set(VALID_REGIONS);

export function isValidRegion(value) {
  return VALID_REGION_SET.has(value);
}

export function normalizeMarketSearchText(value, locale = 'zh-CN') {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase(locale);
}


export function matchesMarketSearch(country, query, { regionLabels = REGION_LABELS } = {}) {
  const normalizedQuery = normalizeMarketSearchText(query);
  if (!normalizedQuery) return true;
  const marketId = normalizeMarketSearchText(country.marketId, 'en-US');
  const names = normalizeMarketSearchText(`${country.country ?? ''} ${country.nameZh ?? ''}`);
  const region = normalizeMarketSearchText(`${country.region ?? ''} ${regionLabels[country.region] ?? ''}`);
  const currency = normalizeMarketSearchText(country.currency, 'en-US');
  const regionSearchEnabled = [...normalizedQuery].length >= 2;
  return marketId.includes(normalizedQuery)
    || names.includes(normalizedQuery)
    || (regionSearchEnabled && region.includes(normalizedQuery))
    || currency === normalizedQuery;
}

export function marketSearchPriority(country, query) {
  const normalizedQuery = normalizeMarketSearchText(query);
  if (!normalizedQuery) return 0;
  return normalizeMarketSearchText(country.marketId, 'en-US') === normalizedQuery ? 2 : 0;
}

export function foldPublicationCountryRenames(changes, currentCountries = [], reviewedRenames = REVIEWED_PUBLICATION_RENAMES) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const added = Array.isArray(source.addedCountries) ? source.addedCountries : [];
  const removed = Array.isArray(source.removedCountries) ? source.removedCountries : [];
  const current = Array.isArray(currentCountries) ? currentCountries : [];
  const rules = Array.isArray(reviewedRenames) ? reviewedRenames : [];
  const foldedAdded = new Set();
  const foldedRemoved = new Set();
  const renamedCountries = [];

  for (const rule of rules) {
    if (!rule?.marketId || !rule?.from || !rule?.to || rule.from === rule.to) continue;
    const addedIndexes = added.flatMap((entry, index) => entry?.country === rule.to ? [index] : []);
    const removedIndexes = removed.flatMap((entry, index) => entry?.country === rule.from ? [index] : []);
    const currentMatches = current.filter((entry) => entry?.marketId === rule.marketId && entry?.country === rule.to);
    if (addedIndexes.length !== 1 || removedIndexes.length !== 1 || currentMatches.length !== 1) continue;

    const addedIndex = addedIndexes[0];
    const removedIndex = removedIndexes[0];
    const currentMarket = currentMatches[0];
    const nameZh = typeof currentMarket.nameZh === 'string' && currentMarket.nameZh.trim()
      ? currentMarket.nameZh.trim()
      : (added[addedIndex]?.nameZh || removed[removedIndex]?.nameZh || rule.to);
    foldedAdded.add(addedIndex);
    foldedRemoved.add(removedIndex);
    renamedCountries.push({ from: rule.from, to: rule.to, nameZh, marketId: rule.marketId });
  }

  return {
    ...source,
    addedCountries: added.filter((_, index) => !foldedAdded.has(index)),
    removedCountries: removed.filter((_, index) => !foldedRemoved.has(index)),
    renamedCountries,
  };
}
