export const APPLE_SUPPORT_URL = 'https://support.apple.com/en-us/108047';

const ALLOWED_FX_SOURCE_URLS = new Set([
  'https://v6.exchangerate-api.com/v6/latest/USD',
  'https://open.er-api.com/v6/latest/USD'
]);
const ALLOWED_PARSERS = new Set(['cross-checked', 'document-order', 'apple-markers-fallback']);
export const PUBLIC_PRICE_SCHEMA_VERSION = 4;
const PUBLIC_PRICE_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'generatedAt', 'source', 'run', 'fx', 'tiers', 'countries']);
const PUBLIC_PRICE_SOURCE_KEYS = new Set(['name', 'url', 'publishedDate', 'parser', 'parserStatus']);
const PUBLIC_PRICE_RUN_KEYS = new Set(['startedAtUtc', 'finishedAtUtc', 'observedAtBeijing', 'observedAtUtc', 'countries', 'pricePoints']);
const PUBLIC_PRICE_FX_KEYS = new Set(['sourceUrl', 'sourceMode', 'fallbackUsed', 'fallbackReason', 'base', 'fetchedAt', 'stale', 'derivedCurrency']);
const PUBLIC_PRICE_TIER_KEYS = new Set(['id', 'label', 'capacityGb']);
const PUBLIC_PRICE_V3_COUNTRY_KEYS = new Set(['country', 'region', 'currency', 'plans', 'nameZh']);
const PUBLIC_PRICE_COUNTRY_KEYS = new Set(['marketId', 'country', 'region', 'currency', 'plans', 'nameZh']);
const PUBLIC_PRICE_V3_PLAN_KEYS = new Set(['price', 'formattedPrice', 'cnyPrice']);
const PUBLIC_PRICE_PLAN_KEYS = new Set(['price', 'formattedPrice', 'cnyPrice', 'cnyRank']);
const PUBLIC_HISTORY_LEGACY_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'updatedAt', 'countries', 'sourcePublishedDates']);
const PUBLIC_HISTORY_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'updatedAt', 'markets', 'sourcePublishedDates']);
const PUBLIC_HISTORY_LEGACY_RECORD_KEYS = new Set(['nameZh', 'region', 'events']);
const PUBLIC_HISTORY_RECORD_KEYS = new Set(['country', 'nameZh', 'region', 'events']);
const PUBLIC_HISTORY_EVENT_KEYS = new Set(['observedAt', 'observedAtUtc', 'observedAtBeijing', 'currency', 'plans']);
const PUBLIC_HISTORY_PUBLICATION_KEYS = new Set(['publishedDate', 'observedAt', 'observedAtUtc', 'observedAtBeijing', 'kind', 'changes']);
const PUBLIC_HISTORY_CHANGE_KEYS = new Set(['addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries']);
const PUBLIC_HISTORY_LISTED_TIER_KEYS = new Set(['id', 'label']);
const PUBLIC_HISTORY_LISTED_COUNTRY_KEYS = new Set(['country', 'nameZh']);
const PUBLIC_HISTORY_CHANGED_COUNTRY_KEYS = new Set(['country', 'nameZh', 'fromCurrency', 'toCurrency', 'fromRegion', 'toRegion', 'tiers']);
const PUBLIC_HISTORY_CHANGED_TIER_KEYS = new Set(['id', 'from', 'to']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIER_ID_PATTERN = /^\d+(?:\.\d+)?(?:GB|TB)$/;
const MARKET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TIER_CAPACITY_GB = 1024 * 1024;
const MAX_PUBLIC_TIERS = 20;
const MAX_PUBLIC_COUNTRIES = 250;
const MAX_HISTORY_COUNTRIES = 500;
const MAX_HISTORY_EVENTS_PER_COUNTRY = 1000;
const MAX_PUBLICATION_HISTORY_ENTRIES = 1000;
const MAX_FX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_FX_ARTIFACT_AGE_MS = (36 * 60 * 60 * 1_000) + MAX_FX_FUTURE_SKEW_MS;
const PUBLIC_FX_FALLBACK_REASONS = new Set([
  'source-unavailable',
  'request-failed',
  'missing-rates',
  'stale-response',
  'future-timestamp',
  'invalid-timestamp',
  'invalid-response'
]);
const FORBIDDEN_PUBLIC_TEXT_PATTERN = /[\0-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/u;
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];
const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.size && actualKeys.every((key) => expectedKeys.has(key));
}

function hasAllowedKeys(value, allowedKeys, requiredKeys = []) {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.every((key) => allowedKeys.has(key))
    && requiredKeys.every((key) => Object.hasOwn(value, key));
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function hasSafeText(value, maxLength = 256) {
  return typeof value === 'string'
    && value.length <= maxLength
    && Boolean(value.trim())
    && !FORBIDDEN_PUBLIC_TEXT_PATTERN.test(value)
    && !hasUnpairedSurrogate(value);
}

export function formattedPriceNumber(value) {
  if (typeof value !== 'string') return Number.NaN;
  const text = value.replace(/[\u00a0\u202f]/g, ' ').trim();
  const matches = [...text.matchAll(/[0-9][0-9.,\s'\u2019]*/g)];
  if (matches.length !== 1) return Number.NaN;
  const normalized = matches[0][0]
    .replace(/\u2019/g, "'")
    .trim();
  const groupedInteger = /[1-9]\d{0,2}(?:[.,' ]\d{3})+/;
  const decimal = new RegExp(`^(?:${groupedInteger.source}|\\d+)[.,]\\d{1,2}$`);
  const grouped = new RegExp(`^${groupedInteger.source}$`);
  if (decimal.test(normalized)) {
    const decimalIndex = Math.max(normalized.lastIndexOf(','), normalized.lastIndexOf('.'));
    if (normalized.slice(0, decimalIndex).includes(normalized[decimalIndex])) return Number.NaN;
    const integerPart = normalized.slice(0, decimalIndex).replace(/[.,' ]/g, '');
    return Number(`${integerPart}.${normalized.slice(decimalIndex + 1)}`);
  }
  if (grouped.test(normalized)) return Number(normalized.replace(/[.,' ]/g, ''));
  return /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
}

export function isPublicFxFallbackReason(value) {
  return value === null || PUBLIC_FX_FALLBACK_REASONS.has(value);
}

export function publicFxFallbackReason(value) {
  if (value === null || value === undefined) return null;
  return PUBLIC_FX_FALLBACK_REASONS.has(value) ? value : 'source-unavailable';
}

export function isValidDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function isValidIsoTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function canonicalTierDefinition(id) {
  if (typeof id !== 'string' || !TIER_ID_PATTERN.test(id) || UNSAFE_OBJECT_KEYS.has(id)) return null;
  const match = id.match(/^(\d+(?:\.\d+)?)(GB|TB)$/);
  const amount = Number(match?.[1]);
  const unit = match?.[2];
  if (!Number.isFinite(amount) || amount <= 0 || String(amount) !== match[1]) return null;
  const capacityGb = amount * (unit === 'TB' ? 1024 : 1);
  if (!Number.isFinite(capacityGb) || capacityGb <= 0 || capacityGb > MAX_TIER_CAPACITY_GB) return null;
  return { id, label: `${match[1]} ${unit}`, capacityGb };
}

function isCanonicalTier(tier) {
  const canonical = canonicalTierDefinition(tier?.id);
  return canonical !== null
    && tier.label === canonical.label
    && tier.capacityGb === canonical.capacityGb;
}

export function publicationDateKey(value) {
  const text = String(value ?? '').trim().replace(/^published\s+date\s*:?\s*/i, '');
  if (isValidDateOnly(text)) return text;
  const match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return `raw:${text}`;
  const month = MONTHS.indexOf(match[1].toLowerCase());
  if (month < 0) return `raw:${text}`;
  const year = Number(match[3]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month
    && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : `raw:${text}`;
}

export function isValidPublishedDate(value) {
  return isValidDateOnly(publicationDateKey(value));
}

export function isValidPublicationChanges(changes) {
  if (changes === undefined || changes === null) return true;
  if (!hasAllowedKeys(changes, PUBLIC_HISTORY_CHANGE_KEYS)) return false;
  const arrays = ['addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries'];
  if (arrays.some((key) => changes[key] !== undefined && !Array.isArray(changes[key]))) return false;
  if ((changes.addedTiers?.length ?? 0) > MAX_PUBLIC_TIERS
    || (changes.removedTiers?.length ?? 0) > MAX_PUBLIC_TIERS
    || (changes.addedCountries?.length ?? 0) > MAX_HISTORY_COUNTRIES
    || (changes.removedCountries?.length ?? 0) > MAX_HISTORY_COUNTRIES
    || (changes.changedCountries?.length ?? 0) > MAX_HISTORY_COUNTRIES) return false;
  const validTier = (tier) => isPlainObject(tier) && canonicalTierDefinition(tier.id) !== null;
  const validListedTier = (tier) => hasExactKeys(tier, PUBLIC_HISTORY_LISTED_TIER_KEYS)
    && validTier(tier)
    && tier.label === canonicalTierDefinition(tier.id).label;
  const validCountry = (country) => hasAllowedKeys(
    country,
    PUBLIC_HISTORY_LISTED_COUNTRY_KEYS,
    ['country']
  ) && hasSafeText(country.country, 160)
    && (country.nameZh === undefined || hasSafeText(country.nameZh, 160));
  const validChangedTier = (tier) => hasExactKeys(tier, PUBLIC_HISTORY_CHANGED_TIER_KEYS)
    && validTier(tier)
    && (tier.from === null || (Number.isFinite(tier.from) && tier.from > 0))
    && (tier.from === null || tier.from <= Number.MAX_SAFE_INTEGER)
    && (tier.to === null || (Number.isFinite(tier.to) && tier.to > 0))
    && (tier.to === null || tier.to <= Number.MAX_SAFE_INTEGER)
    && (tier.from !== null || tier.to !== null);
  const validCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
  const validRegion = (value) => hasSafeText(value, 160);
  if ((changes.addedTiers ?? []).some((tier) => !validListedTier(tier))) return false;
  if ((changes.removedTiers ?? []).some((tier) => !validListedTier(tier))) return false;
  if ((changes.addedCountries ?? []).some((country) => !validCountry(country))) return false;
  if ((changes.removedCountries ?? []).some((country) => !validCountry(country))) return false;
  return (changes.changedCountries ?? []).every((country) => hasAllowedKeys(
    country,
    PUBLIC_HISTORY_CHANGED_COUNTRY_KEYS,
    ['country', 'fromCurrency', 'toCurrency', 'fromRegion', 'toRegion', 'tiers']
  )
    && hasSafeText(country.country, 160)
    && (country.nameZh === undefined || hasSafeText(country.nameZh, 160))
    && validCurrency(country.fromCurrency)
    && validCurrency(country.toCurrency)
    && validRegion(country.fromRegion)
    && validRegion(country.toRegion)
    && Array.isArray(country.tiers)
    && country.tiers.length <= MAX_PUBLIC_TIERS
    && (country.tiers.length > 0
      || country.fromCurrency !== country.toCurrency
      || country.fromRegion !== country.toRegion)
    && country.tiers.every(validChangedTier));
}

function formatBeijingDate(value) {
  const parts = BEIJING_DATE_FORMATTER.formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function isValidObservationMetadata(value) {
  const hasUtc = value.observedAtUtc != null;
  const hasBeijing = value.observedAtBeijing != null;
  return hasUtc === hasBeijing && (!hasUtc || (
    isValidIsoTimestamp(value.observedAtUtc)
    && value.observedAtBeijing === value.observedAt
    && formatBeijingDate(value.observedAtUtc) === value.observedAt
  ));
}

export function validatePricePayload(payload, { minCountries = 1 } = {}) {
  if (!isPlainObject(payload)
    || ![1, 2, 3, PUBLIC_PRICE_SCHEMA_VERSION].includes(payload.schemaVersion)
    || !Array.isArray(payload.tiers)
    || payload.tiers.length > MAX_PUBLIC_TIERS
    || !Array.isArray(payload.countries)
    || payload.countries.length > MAX_PUBLIC_COUNTRIES
    || !isValidIsoTimestamp(payload.generatedAt)
    || !isPlainObject(payload.source)
    || payload.source.url !== APPLE_SUPPORT_URL
    || !hasSafeText(payload.source.publishedDate, 100)
    || !isValidPublishedDate(payload.source.publishedDate)
    || (payload.source.parser != null && !ALLOWED_PARSERS.has(payload.source.parser))
    || !isPlainObject(payload.fx)
    || !ALLOWED_FX_SOURCE_URLS.has(payload.fx.sourceUrl)
    || payload.fx.base !== 'USD'
    || typeof payload.fx.stale !== 'boolean'
    || !isValidIsoTimestamp(payload.fx.fetchedAt)) {
    throw new Error('prices.json has an unsupported or unsafe structure');
  }
  const usesDerivedCnyPrices = payload.schemaVersion >= 3;
  const usesMarketIds = payload.schemaVersion === PUBLIC_PRICE_SCHEMA_VERSION;
  if (usesDerivedCnyPrices) {
    const sourceModeMatchesUrl = (payload.fx.sourceMode === 'api-key' && payload.fx.sourceUrl === 'https://v6.exchangerate-api.com/v6/latest/USD')
      || (payload.fx.sourceMode === 'open-access' && payload.fx.sourceUrl === 'https://open.er-api.com/v6/latest/USD');
    const fallbackReasonRequired = payload.fx.stale || payload.fx.fallbackUsed;
    const fallbackMetadataConsistent = fallbackReasonRequired
      ? typeof payload.fx.fallbackReason === 'string' && isPublicFxFallbackReason(payload.fx.fallbackReason)
      : payload.fx.fallbackReason === null;
    const fallbackSourceConsistent = payload.fx.stale
      || !payload.fx.fallbackUsed
      || payload.fx.sourceMode === 'open-access';
    const generatedAtMs = Date.parse(payload.generatedAt);
    const fxFetchedAtMs = Date.parse(payload.fx.fetchedAt);
    const fxTimestampPlausible = fxFetchedAtMs <= generatedAtMs + MAX_FX_FUTURE_SKEW_MS
      && generatedAtMs - fxFetchedAtMs <= MAX_FX_ARTIFACT_AGE_MS;
    if (!hasExactKeys(payload, PUBLIC_PRICE_TOP_LEVEL_KEYS)
      || !hasExactKeys(payload.source, PUBLIC_PRICE_SOURCE_KEYS)
      || payload.source.name !== 'Apple Support'
      || payload.source.parser !== 'cross-checked'
      || !hasSafeText(payload.source.parserStatus, 512)
      || !hasExactKeys(payload.run, PUBLIC_PRICE_RUN_KEYS)
      || !hasExactKeys(payload.fx, PUBLIC_PRICE_FX_KEYS)
      || !sourceModeMatchesUrl
      || typeof payload.fx.fallbackUsed !== 'boolean'
      || !isPublicFxFallbackReason(payload.fx.fallbackReason)
      || !fallbackMetadataConsistent
      || !fallbackSourceConsistent
      || !fxTimestampPlausible
      || payload.fx.derivedCurrency !== 'CNY') {
      throw new Error('prices.json current public schema has unexpected or invalid fields');
    }
  } else if (!isPlainObject(payload.fx.rates)
    || payload.fx.rates.USD !== 1
    || !Number.isFinite(payload.fx.rates.CNY)
    || payload.fx.rates.CNY <= 0) {
    throw new Error('prices.json has invalid legacy exchange rates');
  }

  const tierIds = new Set();
  const tierCapacities = new Set();
  let previousTierCapacity = 0;
  for (const tier of payload.tiers) {
    if (!isPlainObject(tier)
      || (usesDerivedCnyPrices && !hasExactKeys(tier, PUBLIC_PRICE_TIER_KEYS))
      || !isCanonicalTier(tier)
      || tierIds.has(tier.id)
      || tierCapacities.has(tier.capacityGb)
      || tier.capacityGb <= previousTierCapacity) {
      throw new Error('prices.json has invalid or duplicate tiers');
    }
    tierIds.add(tier.id);
    tierCapacities.add(tier.capacityGb);
    previousTierCapacity = tier.capacityGb;
  }
  if (!tierIds.size || payload.countries.length < minCountries) {
    throw new Error('prices.json has incomplete tiers or countries');
  }
  const publishedDate = publicationDateKey(payload.source.publishedDate);
  const observedAt = payload.run?.observedAtBeijing ?? formatBeijingDate(payload.generatedAt);
  if (!isValidDateOnly(observedAt) || publishedDate > observedAt) {
    throw new Error('prices.json has an impossible publication date');
  }

  const countryNames = new Set();
  const marketIds = new Set();
  const requiredCurrencies = usesDerivedCnyPrices ? null : new Set(['USD', 'CNY']);
  for (const country of payload.countries) {
    if (!isPlainObject(country)
      || (usesMarketIds && !hasExactKeys(country, PUBLIC_PRICE_COUNTRY_KEYS))
      || (payload.schemaVersion === 3 && !hasExactKeys(country, PUBLIC_PRICE_V3_COUNTRY_KEYS))
      || (usesMarketIds && (!hasSafeText(country.marketId, 160) || !MARKET_ID_PATTERN.test(country.marketId) || UNSAFE_OBJECT_KEYS.has(country.marketId)))
      || (usesMarketIds && marketIds.has(country.marketId))
      || !hasSafeText(country.country, 160)
      || countryNames.has(country.country)
      || UNSAFE_OBJECT_KEYS.has(country.country)
      || !hasSafeText(country.nameZh, 160)
      || !hasSafeText(country.region, 160)
      || typeof country.currency !== 'string'
      || !/^[A-Z]{3}$/.test(country.currency)
      || !isPlainObject(country.plans)) {
      throw new Error('prices.json has an invalid country entry');
    }
    countryNames.add(country.country);
    if (usesMarketIds) marketIds.add(country.marketId);
    requiredCurrencies?.add(country.currency);
    const actualPlanIds = new Set(Object.keys(country.plans));
    if (actualPlanIds.size !== tierIds.size || [...tierIds].some((tierId) => !actualPlanIds.has(tierId))) {
      throw new Error(`prices.json has plans that do not match declared tiers for ${country.country}`);
    }
    if (!usesDerivedCnyPrices) {
      const currencyRate = payload.fx.rates[country.currency];
      if (!Number.isFinite(currencyRate) || currencyRate <= 0) {
        throw new Error(`prices.json has an invalid ${country.currency} exchange rate`);
      }
    }
    for (const tierId of tierIds) {
      const plan = country.plans[tierId];
      const cnyPriceIsValid = !usesDerivedCnyPrices || (
        Number.isFinite(plan?.cnyPrice)
        && plan.cnyPrice > 0
        && plan.cnyPrice <= Number.MAX_SAFE_INTEGER
        && Math.abs(plan.cnyPrice * 100 - Math.round(plan.cnyPrice * 100)) < 1e-7
      );
      if (!isPlainObject(plan)
        || (usesMarketIds && !hasExactKeys(plan, PUBLIC_PRICE_PLAN_KEYS))
        || (payload.schemaVersion === 3 && !hasExactKeys(plan, PUBLIC_PRICE_V3_PLAN_KEYS))
        || !Number.isFinite(plan.price)
        || plan.price <= 0
        || plan.price > Number.MAX_SAFE_INTEGER
        || !hasSafeText(plan.formattedPrice, 100)
        || formattedPriceNumber(plan.formattedPrice) !== plan.price
        || !cnyPriceIsValid
        || (usesMarketIds && (!Number.isInteger(plan.cnyRank) || plan.cnyRank < 1 || plan.cnyRank > payload.countries.length))) {
        throw new Error(`prices.json has invalid ${tierId} pricing for ${country.country}`);
      }
    }
  }

  if (usesMarketIds) {
    for (const tierId of tierIds) {
      const ordered = payload.countries
        .map((country) => ({ price: country.plans[tierId].cnyPrice, rank: country.plans[tierId].cnyRank }))
        .sort((first, second) => first.rank - second.rank || first.price - second.price);
      const ranks = [...new Set(ordered.map(({ rank }) => rank))];
      if (ranks[0] !== 1 || ranks.some((rank, index) => rank !== index + 1)) {
        throw new Error(`prices.json has non-dense CNY ranks for ${tierId}`);
      }
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].rank > ordered[index - 1].rank && ordered[index].price < ordered[index - 1].price) {
          throw new Error(`prices.json has CNY ranks inconsistent with public prices for ${tierId}`);
        }
      }
    }
  }

  if (!usesDerivedCnyPrices) {
    const actualCurrencies = Object.keys(payload.fx.rates);
    if (actualCurrencies.length !== requiredCurrencies.size
      || actualCurrencies.some((currency) => !/^[A-Z]{3}$/.test(currency) || !requiredCurrencies.has(currency))) {
      throw new Error('prices.json exchange rates do not exactly match the currencies in use');
    }
  }

  if (payload.schemaVersion >= 2) {
    if (!isPlainObject(payload.run)
      || !isValidIsoTimestamp(payload.run.startedAtUtc)
      || !isValidIsoTimestamp(payload.run.finishedAtUtc)
      || !isValidIsoTimestamp(payload.run.observedAtUtc)
      || !isValidDateOnly(payload.run.observedAtBeijing)
      || payload.run.finishedAtUtc < payload.run.startedAtUtc
      || payload.generatedAt !== payload.run.finishedAtUtc
      || payload.run.observedAtUtc !== payload.run.finishedAtUtc
      || payload.run.observedAtBeijing !== formatBeijingDate(payload.run.finishedAtUtc)
      || payload.run.countries !== payload.countries.length
      || payload.run.pricePoints !== payload.countries.length * payload.tiers.length) {
      throw new Error('prices.json has inconsistent run metadata');
    }
  }
  return payload;
}

export function validateHistoryPayload(payload) {
  const usesMarketIds = payload?.schemaVersion === 4;
  const records = usesMarketIds ? payload?.markets : payload?.countries;
  if (!isPlainObject(payload)
    || !(usesMarketIds
      ? hasExactKeys(payload, PUBLIC_HISTORY_TOP_LEVEL_KEYS)
      : hasAllowedKeys(payload, PUBLIC_HISTORY_LEGACY_TOP_LEVEL_KEYS, ['schemaVersion', 'countries', 'sourcePublishedDates']))
    || ![1, 2, 4].includes(payload.schemaVersion)
    || !isPlainObject(records)
    || !Object.keys(records).length
    || Object.keys(records).length > MAX_HISTORY_COUNTRIES
    || !Array.isArray(payload.sourcePublishedDates)
    || !payload.sourcePublishedDates.length
    || payload.sourcePublishedDates.length > MAX_PUBLICATION_HISTORY_ENTRIES
    || ([2, 4].includes(payload.schemaVersion) && !isValidIsoTimestamp(payload.updatedAt))
    || (payload.schemaVersion === 1 && payload.updatedAt != null && !isValidIsoTimestamp(payload.updatedAt))) {
    throw new Error('history.json has an unsupported structure');
  }

  const latestHistoryDate = payload.updatedAt?.slice(0, 10) ?? null;

  for (const [recordKey, record] of Object.entries(records)) {
    if (UNSAFE_OBJECT_KEYS.has(recordKey)
      || !hasSafeText(recordKey, 160)
      || (usesMarketIds && !MARKET_ID_PATTERN.test(recordKey))
      || !hasExactKeys(record, usesMarketIds ? PUBLIC_HISTORY_RECORD_KEYS : PUBLIC_HISTORY_LEGACY_RECORD_KEYS)
      || (usesMarketIds && !hasSafeText(record.country, 160))
      || !hasSafeText(record.nameZh, 160)
      || !hasSafeText(record.region, 160)
      || !Array.isArray(record.events)
      || !record.events.length
      || record.events.length > MAX_HISTORY_EVENTS_PER_COUNTRY) {
      throw new Error(`history.json has an invalid record for ${recordKey}`);
    }
    let previousObservedAt = '';
    for (const event of record.events) {
      if (!hasAllowedKeys(event, PUBLIC_HISTORY_EVENT_KEYS, ['observedAt', 'currency', 'plans'])
        || !isValidDateOnly(event.observedAt)
        || event.observedAt < previousObservedAt
        || (latestHistoryDate !== null && event.observedAt > latestHistoryDate)
        || typeof event.currency !== 'string'
        || !/^[A-Z]{3}$/.test(event.currency)
        || !isPlainObject(event.plans)
        || !Object.keys(event.plans).length
        || Object.keys(event.plans).some((tierId) => canonicalTierDefinition(tierId) === null)
        || Object.values(event.plans).some((price) => !Number.isFinite(price) || price <= 0 || price > Number.MAX_SAFE_INTEGER)
        || !isValidObservationMetadata(event)) {
        throw new Error(`history.json has an invalid event for ${recordKey}`);
      }
      previousObservedAt = event.observedAt;
    }
  }

  const publishedDates = new Set();
  let previousPublishedDate = '';
  let previousObservedAt = '';
  for (const entry of payload.sourcePublishedDates) {
    const publishedDate = publicationDateKey(entry?.publishedDate);
    if (!hasAllowedKeys(entry, PUBLIC_HISTORY_PUBLICATION_KEYS, ['publishedDate', 'observedAt'])
      || !hasSafeText(entry.publishedDate, 100)
      || !isValidDateOnly(publishedDate)
      || publishedDates.has(publishedDate)
      || publishedDate < previousPublishedDate
      || !isValidDateOnly(entry.observedAt)
      || publishedDate > entry.observedAt
      || entry.observedAt < previousObservedAt
      || (latestHistoryDate !== null && entry.observedAt > latestHistoryDate)
      || !isValidObservationMetadata(entry)
      || (entry.kind !== undefined && !['initial', 'change'].includes(entry.kind))
      || !isValidPublicationChanges(entry.changes)) {
      throw new Error('history.json has an invalid publication history');
    }
    publishedDates.add(publishedDate);
    previousPublishedDate = publishedDate;
    previousObservedAt = entry.observedAt;
  }
  return payload;
}

export function validatePriceHistoryConsistency(prices, history) {
  validatePricePayload(prices);
  validateHistoryPayload(history);
  if (history.schemaVersion < 4 && history.schemaVersion >= 2 && history.updatedAt !== prices.generatedAt) {
    throw new Error('prices.json and legacy history.json have different update timestamps');
  }
  if (history.schemaVersion === 4 && history.updatedAt > prices.generatedAt) {
    throw new Error('history.json was updated after prices.json was generated');
  }
  const currentPublishedDate = publicationDateKey(prices.source.publishedDate);
  const latestPublishedDate = publicationDateKey(history.sourcePublishedDates.at(-1)?.publishedDate);
  if (latestPublishedDate !== currentPublishedDate) {
    throw new Error('prices.json and history.json have different latest publication dates');
  }
  const tierIds = new Set(prices.tiers.map(({ id }) => id));
  for (const country of prices.countries) {
    const record = history.schemaVersion === 4
      ? history.markets[country.marketId]
      : history.countries[country.country];
    const latestEvent = record?.events?.at(-1);
    const eventTierIds = new Set(Object.keys(latestEvent?.plans ?? {}));
    if (!record
      || (history.schemaVersion === 4 && record.country !== country.country)
      || record.nameZh !== country.nameZh
      || record.region !== country.region
      || latestEvent?.currency !== country.currency
      || eventTierIds.size !== tierIds.size
      || [...tierIds].some((id) => !eventTierIds.has(id)
        || latestEvent.plans[id] !== country.plans[id].price)) {
      throw new Error('Existing history.json latest values do not match ' + country.country + '; prices.json and history.json are inconsistent');
    }
  }
  return history;
}

export function validatePayload(fileName, payload) {
  if (fileName === 'history.json') {
    if (payload?.schemaVersion !== 4) throw new Error('history.json must use the current public schema');
    return validateHistoryPayload(payload);
  }
  if (payload?.schemaVersion !== PUBLIC_PRICE_SCHEMA_VERSION) {
    throw new Error('prices.json must use the current public schema');
  }
  return validatePricePayload(payload, { minCountries: 60 });
}
