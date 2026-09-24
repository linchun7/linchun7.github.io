import { readFileSync } from 'node:fs';

const DEFAULT_MAPPING = Object.freeze(JSON.parse(readFileSync(
  new URL('./country-names.zh.json', import.meta.url),
  'utf8'
)));

export function getOfficialChineseMarketName(marketId, mapping = DEFAULT_MAPPING) {
  return Object.hasOwn(mapping, marketId) ? mapping[marketId] : null;
}

export function getOfficialChineseMarketNames() {
  return DEFAULT_MAPPING;
}
