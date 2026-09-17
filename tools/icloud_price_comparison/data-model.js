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

// Reviewed source identities only; shared by the registry and presentation.
// Never derive identity from Chinese labels, prices, order or fuzzy strings.
export const REVIEWED_MARKET_IDENTITIES = Object.freeze([
  ['bs', 'Bahamas'], ['bb', 'Barbados'], ['br', 'Brazil'], ['ca', 'Canada'], ['cl', 'Chile'],
  ['co', 'Colombia'], ['mx', 'Mexico'], ['pe', 'Peru'], ['sr', 'Suriname'],
  ['us', 'United States', ['United States of America']], ['al', 'Albania'], ['am', 'Armenia'],
  ['az', 'Azerbaijan'], ['bh', 'Bahrain'], ['by', 'Belarus'], ['bj', 'Benin'], ['bg', 'Bulgaria'],
  ['cm', 'Cameroon'], ['hr', 'Croatia'], ['cz', 'Czechia', ['Czech Republic']], ['dk', 'Denmark'],
  ['eg', 'Egypt'], ['euro-zone', 'Euro Zone', ['Euro', 'Eurozone']], ['ge', 'Georgia'], ['gh', 'Ghana'],
  ['hu', 'Hungary'], ['is', 'Iceland'], ['il', 'Israel'],
  ['ci', 'Ivory Coast', ["Cote D'Ivoire", 'Côte d’Ivoire', "Côte d'Ivoire"]], ['ke', 'Kenya'],
  ['mu', 'Mauritius'], ['md', 'Moldova', ['Republic of Moldova']], ['ng', 'Nigeria'], ['no', 'Norway'],
  ['pk', 'Pakistan'], ['pl', 'Poland'], ['qa', 'Qatar'],
  ['cg', 'Republic of Congo', ['Republic of the Congo']], ['ro', 'Romania'],
  ['ru', 'Russia', ['Russian Federation']], ['sa', 'Saudi Arabia'], ['sn', 'Senegal'], ['za', 'South Africa'],
  ['se', 'Sweden'], ['ch', 'Switzerland'], ['tz', 'Tanzania', ['United Republic of Tanzania']],
  ['tr', 'Türkiye', ['Turkey']], ['ug', 'Uganda'], ['ae', 'United Arab Emirates'],
  ['gb', 'United Kingdom', ['UK']], ['zm', 'Zambia'], ['zw', 'Zimbabwe'], ['au', 'Australia'],
  ['kh', 'Cambodia'], ['cn', 'China mainland', ['China', 'Mainland China']], ['hk', 'Hong Kong'], ['in', 'India'],
  ['id', 'Indonesia'], ['jp', 'Japan'], ['kz', 'Kazakhstan'], ['kg', 'Kyrgyzstan'], ['la', 'Laos'],
  ['my', 'Malaysia'], ['np', 'Nepal'], ['nz', 'New Zealand'], ['ph', 'Philippines'],
  ['kr', 'Republic of Korea', ['South Korea']], ['sg', 'Singapore'], ['tw', 'Taiwan'],
  ['tj', 'Tajikistan'], ['th', 'Thailand'], ['uz', 'Uzbekistan'], ['vn', 'Vietnam', ['Viet Nam']]
].map(([id, canonicalName, aliases = []]) => Object.freeze({ id, canonicalName, aliases: Object.freeze(aliases) })));

export function sourceNameIdentityKey(value) {
  return String(value ?? '').normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

const reviewedIdentityByName = new Map(REVIEWED_MARKET_IDENTITIES.flatMap(({ id, canonicalName, aliases }) => (
  [canonicalName, ...aliases].map((name) => [sourceNameIdentityKey(name), id])
)));
const reviewedIdentity = (name) => reviewedIdentityByName.get(sourceNameIdentityKey(name));

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

// Explicit identityEvidence comes only from the updater's validated before/after
// stable-ID ledger. Without it, use only the reviewed source-name declarations.
export function foldPublicationCountryRenames(changes, currentCountries = [], identityEvidence = null) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const added = Array.isArray(source.addedCountries) ? source.addedCountries : [];
  const removed = Array.isArray(source.removedCountries) ? source.removedCountries : [];
  const current = Array.isArray(currentCountries) ? currentCountries : [];
  const rules = identityEvidence === null ? removed.flatMap((before) => added.flatMap((after) => {
    const marketId = reviewedIdentity(before?.country);
    return marketId && marketId === reviewedIdentity(after?.country)
      ? [{ marketId, from: before.country, to: after.country }] : [];
  })) : (Array.isArray(identityEvidence) ? identityEvidence : []);
  const candidates = [];
  for (const rule of rules) {
    if (!rule?.marketId || !rule?.from || !rule?.to || rule.from === rule.to) continue;
    const addedIndexes = added.flatMap((entry, index) => entry?.country === rule.to ? [index] : []);
    const removedIndexes = removed.flatMap((entry, index) => entry?.country === rule.from ? [index] : []);
    const currentMatches = current.filter((entry) => entry?.marketId === rule.marketId);
    if (addedIndexes.length !== 1 || removedIndexes.length !== 1 || currentMatches.length !== 1) continue;
    const market = currentMatches[0];
    if (market.country !== rule.to && !(reviewedIdentity(market.country) === rule.marketId
      && reviewedIdentity(rule.from) === rule.marketId && reviewedIdentity(rule.to) === rule.marketId)) continue;
    const addedIndex = addedIndexes[0];
    const removedIndex = removedIndexes[0];
    if ([added[addedIndex], removed[removedIndex]].some((entry) => entry.marketId != null && entry.marketId !== rule.marketId)) continue;
    if (!candidates.some((candidate) => candidate.addedIndex === addedIndex && candidate.removedIndex === removedIndex && candidate.rule.marketId === rule.marketId)) {
      candidates.push({ rule, market, addedIndex, removedIndex });
    }
  }
  const unique = candidates.filter((candidate) => candidates.every((other) => other === candidate || (
    other.addedIndex !== candidate.addedIndex && other.removedIndex !== candidate.removedIndex && other.rule.marketId !== candidate.rule.marketId
  )));
  const foldedAdded = new Set(unique.map(({ addedIndex }) => addedIndex));
  const foldedRemoved = new Set(unique.map(({ removedIndex }) => removedIndex));
  const renamedCountries = unique.map(({ rule, market, addedIndex, removedIndex }) => ({
    from: rule.from, to: rule.to, marketId: rule.marketId,
    nameZh: typeof market.nameZh === 'string' && market.nameZh.trim()
      ? market.nameZh.trim() : (added[addedIndex]?.nameZh || removed[removedIndex]?.nameZh || rule.to),
  })).sort((first, second) => first.marketId.localeCompare(second.marketId));
  return { ...source, addedCountries: added.filter((_, index) => !foldedAdded.has(index)),
    removedCountries: removed.filter((_, index) => !foldedRemoved.has(index)), renamedCountries };
}
