import { createHash } from 'node:crypto';
import { getOfficialChineseMarketName, getOfficialChineseMarketNames } from './country-names.mjs';

const DEFINITIONS = [
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
  ['kh', 'Cambodia'], ['cn', 'China mainland', ['Mainland China']], ['hk', 'Hong Kong'], ['in', 'India'],
  ['id', 'Indonesia'], ['jp', 'Japan'], ['kz', 'Kazakhstan'], ['kg', 'Kyrgyzstan'], ['la', 'Laos'],
  ['my', 'Malaysia'], ['np', 'Nepal'], ['nz', 'New Zealand'], ['ph', 'Philippines'],
  ['kr', 'Republic of Korea', ['South Korea']], ['sg', 'Singapore'], ['tw', 'Taiwan'],
  ['tj', 'Tajikistan'], ['th', 'Thailand'], ['uz', 'Uzbekistan'], ['vn', 'Vietnam', ['Viet Nam']]
];

export const MARKET_REGISTRY = Object.freeze(Object.fromEntries(DEFINITIONS.map(([id, canonicalName, aliases = []]) => [
  canonicalName,
  Object.freeze({ id, canonicalName, aliases: Object.freeze(aliases) })
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
  const knownById = new Map();
  for (const market of Object.values(registry)) {
    if (knownIds.has(market.id)) throw new Error(`Duplicate marketId in registry: ${market.id}`);
    knownIds.add(market.id);
    knownById.set(market.id, market);
    for (const name of [market.canonicalName, ...(market.aliases ?? [])]) {
      const key = normalizedNameKey(name);
      if (byName.has(key)) throw new Error(`Duplicate market name or alias in registry: ${name}`);
      byName.set(key, market);
    }
  }
  return (sourceName) => {
    const name = normalizedName(sourceName);
    const known = byName.get(normalizedNameKey(name));
    if (known) return {
      ...known,
      sourceName: name,
      nameZh: getOfficialChineseMarketName(known.id),
      unknown: false
    };
    const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
    const id = `apple-${slugify(name)}-${digest}`;
    if (knownIds.has(id)) {
      throw reservedIdentityCollisionError(id, name, [{
        sourceName: knownById.get(id).canonicalName,
        location: 'market-registry.mjs'
      }]);
    }
    return { id, canonicalName: name, sourceName: name, nameZh: name, aliases: [], unknown: true };
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

function publishedIdentityError(message) {
  const error = new Error(`PUBLISHED_MARKET_IDENTITY_CONFLICT: ${message}`);
  error.code = 'PUBLISHED_MARKET_IDENTITY_CONFLICT';
  return error;
}

export function buildPublishedMarketIdentityIndex(previousData, previousHistory) {
  const bySourceName = new Map();
  const sourceNamesById = new Map();
  const ownersById = new Map();
  const add = (sourceName, marketId, location) => {
    const name = normalizedName(sourceName);
    const identityKey = normalizedNameKey(name);
    const previous = bySourceName.get(identityKey);
    if (previous && previous.marketId !== marketId) {
      throw publishedIdentityError(`${name} maps to both ${previous.marketId} (${previous.location}) and ${marketId} (${location})`);
    }
    bySourceName.set(identityKey, { marketId, sourceName: name, location });
    const names = sourceNamesById.get(marketId) ?? new Set();
    names.add(normalizedNameKey(name));
    sourceNamesById.set(marketId, names);
    const owners = ownersById.get(marketId) ?? [];
    if (!owners.some((owner) => owner.identityKey === identityKey && owner.location === location)) {
      owners.push({ sourceName: name, identityKey, location });
    }
    ownersById.set(marketId, owners);
  };
  if (previousData?.schemaVersion === 4) {
    for (const country of previousData.countries ?? []) add(country.country, country.marketId, 'prices.json');
  }
  if (previousHistory?.schemaVersion === 4) {
    for (const [marketId, record] of Object.entries(previousHistory.markets ?? {})) {
      add(record.country, marketId, 'history.json');
    }
  }
  return { bySourceName, sourceNamesById, ownersById };
}

function reservedIdentityCollisionError(generatedMarketId, newSourceName, owners) {
  const reserved = owners.map(({ sourceName, location }) => `${sourceName} (${location})`).join(', ');
  const error = new Error(`MARKET_IDENTITY_RESERVED_ID_COLLISION: generatedMarketId=${generatedMarketId}; newSourceName=${newSourceName}; reserved=${reserved}`);
  error.code = 'MARKET_IDENTITY_RESERVED_ID_COLLISION';
  error.generatedMarketId = generatedMarketId;
  error.newSourceName = newSourceName;
  error.reservedOwners = owners.map(({ sourceName, location }) => ({ sourceName, location }));
  return error;
}

export function createPublishedMarketResolver(previousData, previousHistory, {
  registry = MARKET_REGISTRY,
  resolveUnknown = createMarketResolver(registry)
} = {}) {
  const published = buildPublishedMarketIdentityIndex(previousData, previousHistory);
  return (sourceName) => {
    const resolved = resolveUnknown(sourceName);
    if (!resolved.unknown) return resolved;
    const name = normalizedName(sourceName);
    const historical = published.bySourceName.get(normalizedNameKey(name));
    if (!historical) {
      const reservedOwners = published.ownersById.get(resolved.id);
      if (reservedOwners?.length) throw reservedIdentityCollisionError(resolved.id, name, reservedOwners);
      return resolved;
    }
    return {
      ...resolved,
      id: historical.marketId,
      sourceName: name,
      nameZh: name,
      published: true
    };
  };
}

export function validateMarketIdentityContinuity(previousData, previousHistory, {
  registry = MARKET_REGISTRY,
  resolve = null
} = {}) {
  const resolver = resolve ?? (registry === MARKET_REGISTRY ? resolveMarket : createMarketResolver(registry));
  const published = buildPublishedMarketIdentityIndex(previousData, previousHistory);
  const publishedNamesById = published.sourceNamesById;
  const checkPublishedIdentity = (sourceName, expectedId, location) => {
    let resolved;
    try {
      resolved = resolver(sourceName);
    } catch (error) {
      throw marketIdentityError(`${location} cannot resolve ${sourceName}: ${error.message}`);
    }
    if (!resolved.unknown && resolved.id !== expectedId) {
      throw marketIdentityError(`${location} maps ${sourceName} from ${expectedId} to ${resolved.id}`);
    }
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

export function attachMarketIdentity(countries, {
  onUnknown = () => {},
  onChineseNamePending = () => {},
  resolve = resolveMarket,
  chineseNames = null
} = {}) {
  const ids = new Map();
  return countries.map((country) => {
    const market = resolve(country.country);
    const previousName = ids.get(market.id);
    if (previousName && previousName !== country.country) {
      throw new Error(`marketId collision between ${previousName} and ${country.country}: ${market.id}`);
    }
    ids.set(market.id, country.country);
    if (market.unknown) onUnknown(market, country);
    const officialName = getOfficialChineseMarketName(market.id, chineseNames ?? undefined);
    if (officialName === null) onChineseNamePending(market, country);
    return {
      ...country,
      marketId: market.id,
      nameZh: officialName ?? country.country
    };
  });
}

export function validateMarketRegistry(registry = MARKET_REGISTRY) {
  if (Object.keys(registry).length === 0 || Object.keys(registry).length > 500) {
    throw new Error(`Market registry is empty or oversized: ${Object.keys(registry).length}`);
  }
  createMarketResolver(registry);
  for (const market of Object.values(registry)) {
    if (!Object.hasOwn(getOfficialChineseMarketNames(), market.id)) {
      throw new Error(`Market registry is missing a Chinese-name authority record for marketId: ${market.id}`);
    }
  }
  return registry;
}
