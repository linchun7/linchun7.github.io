export const VALID_REGIONS = Object.freeze([
  'Americas',
  'Europe, Middle East & Africa',
  'Asia Pacific'
]);

export const MARKET_SEARCH_ALIASES = Object.freeze({
  'euro-zone': Object.freeze(['eu', 'eurozone', 'euro zone']),
  ci: Object.freeze(["cote d'ivoire", "côte d'ivoire"]),
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

export function marketSearchAliases(marketId) {
  return MARKET_SEARCH_ALIASES[marketId] ?? [];
}
