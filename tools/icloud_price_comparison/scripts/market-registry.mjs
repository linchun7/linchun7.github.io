import { createHash } from 'node:crypto';

const DEFINITIONS = [
  ['bs', 'Bahamas', '巴哈马'], ['bb', 'Barbados', '巴巴多斯'], ['br', 'Brazil', '巴西'],
  ['ca', 'Canada', '加拿大'], ['cl', 'Chile', '智利'], ['co', 'Colombia', '哥伦比亚'],
  ['mx', 'Mexico', '墨西哥'], ['pe', 'Peru', '秘鲁'], ['sr', 'Suriname', '苏里南'],
  ['us', 'United States', '美国', ['United States of America']],
  ['al', 'Albania', '阿尔巴尼亚'], ['am', 'Armenia', '亚美尼亚'], ['az', 'Azerbaijan', '阿塞拜疆'],
  ['bh', 'Bahrain', '巴林'], ['by', 'Belarus', '白俄罗斯'], ['bj', 'Benin', '贝宁'],
  ['bg', 'Bulgaria', '保加利亚'], ['cm', 'Cameroon', '喀麦隆'], ['hr', 'Croatia', '克罗地亚'],
  ['cz', 'Czechia', '捷克', ['Czech Republic']], ['dk', 'Denmark', '丹麦'], ['eg', 'Egypt', '埃及'],
  ['euro-zone', 'Euro Zone', '欧盟', ['Euro', 'Eurozone']], ['ge', 'Georgia', '格鲁吉亚'], ['gh', 'Ghana', '加纳'],
  ['hu', 'Hungary', '匈牙利'], ['is', 'Iceland', '冰岛'], ['il', 'Israel', '以色列'],
  ['ci', 'Ivory Coast', '科特迪瓦', ["Cote D'Ivoire", 'Côte d’Ivoire', "Côte d'Ivoire"]],
  ['ke', 'Kenya', '肯尼亚'], ['mu', 'Mauritius', '毛里求斯'], ['md', 'Moldova', '摩尔多瓦', ['Republic of Moldova']],
  ['ng', 'Nigeria', '尼日利亚'], ['no', 'Norway', '挪威'], ['pk', 'Pakistan', '巴基斯坦'],
  ['pl', 'Poland', '波兰'], ['qa', 'Qatar', '卡塔尔'], ['cg', 'Republic of Congo', '刚果共和国', ['Republic of the Congo']],
  ['ro', 'Romania', '罗马尼亚'], ['ru', 'Russia', '俄罗斯', ['Russian Federation']],
  ['sa', 'Saudi Arabia', '沙特阿拉伯'], ['sn', 'Senegal', '塞内加尔'], ['za', 'South Africa', '南非'],
  ['se', 'Sweden', '瑞典'], ['ch', 'Switzerland', '瑞士'], ['tz', 'Tanzania', '坦桑尼亚', ['United Republic of Tanzania']],
  ['tr', 'Türkiye', '土耳其', ['Turkey']], ['ug', 'Uganda', '乌干达'],
  ['ae', 'United Arab Emirates', '阿拉伯联合酋长国'], ['gb', 'United Kingdom', '英国', ['UK']],
  ['zm', 'Zambia', '赞比亚'], ['zw', 'Zimbabwe', '津巴布韦'],
  ['au', 'Australia', '澳大利亚'], ['kh', 'Cambodia', '柬埔寨'],
  ['cn', 'China mainland', '中国大陆', ['Mainland China']], ['hk', 'Hong Kong', '香港'],
  ['in', 'India', '印度'], ['id', 'Indonesia', '印度尼西亚'], ['jp', 'Japan', '日本'],
  ['kz', 'Kazakhstan', '哈萨克斯坦'], ['kg', 'Kyrgyzstan', '吉尔吉斯斯坦'], ['la', 'Laos', '老挝'],
  ['my', 'Malaysia', '马来西亚'], ['np', 'Nepal', '尼泊尔'], ['nz', 'New Zealand', '新西兰'],
  ['ph', 'Philippines', '菲律宾'], ['kr', 'Republic of Korea', '韩国', ['South Korea']],
  ['sg', 'Singapore', '新加坡'], ['tw', 'Taiwan', '台湾'], ['tj', 'Tajikistan', '塔吉克斯坦'],
  ['th', 'Thailand', '泰国'], ['uz', 'Uzbekistan', '乌兹别克斯坦'], ['vn', 'Vietnam', '越南', ['Viet Nam']]
];

export const MARKET_REGISTRY = Object.freeze(Object.fromEntries(DEFINITIONS.map(([id, canonicalName, zh, aliases = []]) => [
  canonicalName,
  Object.freeze({ id, canonicalName, zh, aliases: Object.freeze(aliases) })
])));

function normalizedName(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function normalizedNameKey(value) {
  return normalizedName(value).toLocaleLowerCase('en-US');
}

function slugify(value) {
  return normalizedName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'market';
}

export function createMarketResolver(registry = MARKET_REGISTRY) {
  const byName = new Map();
  const knownIds = new Set();
  for (const market of Object.values(registry)) {
    if (knownIds.has(market.id)) throw new Error(`Duplicate marketId in registry: ${market.id}`);
    knownIds.add(market.id);
    for (const name of [market.canonicalName, ...(market.aliases ?? [])]) {
      const key = normalizedNameKey(name);
      if (byName.has(key)) throw new Error(`Duplicate market name or alias in registry: ${name}`);
      byName.set(key, market);
    }
  }
  return (sourceName) => {
    const name = normalizedName(sourceName);
    const known = byName.get(normalizedNameKey(name));
    if (known) return { ...known, sourceName: name, unknown: false };
    const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
    const id = `apple-${slugify(name)}-${digest}`;
    if (knownIds.has(id)) throw new Error(`Generated marketId collides with registry: ${id}`);
    return { id, canonicalName: name, sourceName: name, zh: name, aliases: [], unknown: true };
  };
}

const defaultResolver = createMarketResolver();

export function resolveMarket(sourceName) {
  return defaultResolver(sourceName);
}

function marketIdentityError(message) {
  const error = new Error(`MARKET_IDENTITY_REKEY: ${message}`);
  error.code = 'MARKET_IDENTITY_REKEY';
  return error;
}

export function validateMarketIdentityContinuity(previousData, previousHistory, {
  registry = MARKET_REGISTRY,
  resolve = null
} = {}) {
  const resolver = resolve ?? (registry === MARKET_REGISTRY ? resolveMarket : createMarketResolver(registry));
  const publishedNamesById = new Map();
  const checkPublishedIdentity = (sourceName, expectedId, location) => {
    let resolved;
    try {
      resolved = resolver(sourceName);
    } catch (error) {
      throw marketIdentityError(`${location} cannot resolve ${sourceName}: ${error.message}`);
    }
    if (resolved.id !== expectedId) {
      throw marketIdentityError(`${location} maps ${sourceName} from ${expectedId} to ${resolved.id}`);
    }
    const names = publishedNamesById.get(expectedId) ?? new Set();
    names.add(normalizedNameKey(sourceName));
    publishedNamesById.set(expectedId, names);
  };

  if (previousData?.schemaVersion === 4) {
    for (const country of previousData.countries ?? []) {
      checkPublishedIdentity(country.country, country.marketId, 'prices.json');
    }
  }
  if (previousHistory?.schemaVersion === 4) {
    for (const [marketId, record] of Object.entries(previousHistory.markets ?? {})) {
      checkPublishedIdentity(record.country, marketId, 'history.json');
    }
  }

  for (const market of Object.values(registry)) {
    const publishedNames = publishedNamesById.get(market.id);
    if (!publishedNames) continue;
    const registryNames = [market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey);
    if (!registryNames.some((name) => publishedNames.has(name))) {
      throw marketIdentityError(`registry market ${market.canonicalName} occupies reserved marketId ${market.id}`);
    }
  }
  return { status: 'passed', reservedMarketIds: [...publishedNamesById.keys()].sort() };
}

export function attachMarketIdentity(countries, { onUnknown = () => {}, resolve = resolveMarket } = {}) {
  const ids = new Map();
  return countries.map((country) => {
    const market = resolve(country.country);
    const previousName = ids.get(market.id);
    if (previousName && previousName !== country.country) {
      throw new Error(`marketId collision between ${previousName} and ${country.country}: ${market.id}`);
    }
    ids.set(market.id, country.country);
    if (market.unknown) onUnknown(market, country);
    return {
      ...country,
      marketId: market.id,
      nameZh: market.unknown ? country.country : market.zh
    };
  });
}

export function validateMarketRegistry(registry = MARKET_REGISTRY) {
  if (Object.keys(registry).length < 73 || Object.keys(registry).length > 500) {
    throw new Error(`Market registry is incomplete or oversized: ${Object.keys(registry).length}`);
  }
  createMarketResolver(registry);
  return registry;
}
