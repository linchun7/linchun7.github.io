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

export function foldPublicationCountryRenames(changes, currentCountries = []) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const added = Array.isArray(source.addedCountries) ? source.addedCountries : [];
  const removed = Array.isArray(source.removedCountries) ? source.removedCountries : [];
  const current = Array.isArray(currentCountries) ? currentCountries : [];
  const addedByName = new Map();
  const removedByName = new Map();
  const currentByName = new Map();
  const reviewedName = (entry) => {
    const name = typeof entry?.nameZh === 'string' ? entry.nameZh.trim() : '';
    return /[\u3400-\u9fff]/u.test(name) ? name : '';
  };
  const addIndex = (map, entry, index) => {
    const name = reviewedName(entry);
    if (!name) return;
    const indexes = map.get(name) ?? [];
    indexes.push(index);
    map.set(name, indexes);
  };
  added.forEach((entry, index) => addIndex(addedByName, entry, index));
  removed.forEach((entry, index) => addIndex(removedByName, entry, index));
  current.forEach((entry, index) => addIndex(currentByName, entry, index));

  const foldedAdded = new Set();
  const foldedRemoved = new Set();
  const renamedCountries = [];
  for (const [nameZh, addedIndexes] of addedByName) {
    const removedIndexes = removedByName.get(nameZh) ?? [];
    const currentIndexes = currentByName.get(nameZh) ?? [];
    if (addedIndexes.length !== 1 || removedIndexes.length !== 1 || currentIndexes.length !== 1) continue;
    const addedIndex = addedIndexes[0];
    const removedIndex = removedIndexes[0];
    const from = removed[removedIndex]?.country;
    const to = added[addedIndex]?.country;
    const currentMarket = current[currentIndexes[0]];
    if (!from || !to || from === to || !currentMarket?.marketId || currentMarket.country !== to) continue;
    foldedAdded.add(addedIndex);
    foldedRemoved.add(removedIndex);
    renamedCountries.push({ from, to, nameZh, marketId: currentMarket.marketId });
  }

  return {
    ...source,
    addedCountries: added.filter((_, index) => !foldedAdded.has(index)),
    removedCountries: removed.filter((_, index) => !foldedRemoved.has(index)),
    renamedCountries,
  };
}
