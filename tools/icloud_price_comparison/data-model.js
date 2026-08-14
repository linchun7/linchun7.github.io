export const VALID_REGIONS = Object.freeze([
  'Americas',
  'Europe, Middle East & Africa',
  'Asia Pacific'
]);

const VALID_REGION_SET = new Set(VALID_REGIONS);

export function isValidRegion(value) {
  return VALID_REGION_SET.has(value);
}
