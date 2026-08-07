export const APPLE_SUPPORT_URL = 'https://support.apple.com/en-us/108047';

const ALLOWED_FX_SOURCE_URLS = new Set([
  'https://v6.exchangerate-api.com/v6/latest/USD',
  'https://open.er-api.com/v6/latest/USD'
]);
const ALLOWED_PARSERS = new Set(['cross-checked', 'document-order', 'apple-markers-fallback']);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
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
  if (!isPlainObject(changes)) return false;
  const arrays = ['addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries'];
  if (arrays.some((key) => changes[key] !== undefined && !Array.isArray(changes[key]))) return false;
  const validTier = (tier) => isPlainObject(tier) && typeof tier.id === 'string' && tier.id.trim();
  const validCountry = (country) => isPlainObject(country) && typeof country.country === 'string' && country.country.trim();
  const validChangedTier = (tier) => validTier(tier)
    && (tier.from === null || (Number.isFinite(tier.from) && tier.from > 0))
    && (tier.to === null || (Number.isFinite(tier.to) && tier.to > 0))
    && (tier.from !== null || tier.to !== null);
  const validCurrency = (value) => typeof value === 'string' && /^[A-Z]{3}$/.test(value);
  const validRegion = (value) => typeof value === 'string' && value.trim();
  if ((changes.addedTiers ?? []).some((tier) => !validTier(tier))) return false;
  if ((changes.removedTiers ?? []).some((tier) => !validTier(tier))) return false;
  if ((changes.addedCountries ?? []).some((country) => !validCountry(country))) return false;
  if ((changes.removedCountries ?? []).some((country) => !validCountry(country))) return false;
  return (changes.changedCountries ?? []).every((country) => validCountry(country)
    && validCurrency(country.fromCurrency)
    && validCurrency(country.toCurrency)
    && validRegion(country.fromRegion)
    && validRegion(country.toRegion)
    && Array.isArray(country.tiers)
    && country.tiers.length > 0
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
    || ![1, 2].includes(payload.schemaVersion)
    || !Array.isArray(payload.tiers)
    || !Array.isArray(payload.countries)
    || !isValidIsoTimestamp(payload.generatedAt)
    || !isPlainObject(payload.source)
    || payload.source.url !== APPLE_SUPPORT_URL
    || !isValidPublishedDate(payload.source.publishedDate)
    || (payload.source.parser != null && !ALLOWED_PARSERS.has(payload.source.parser))
    || !isPlainObject(payload.fx)
    || !ALLOWED_FX_SOURCE_URLS.has(payload.fx.sourceUrl)
    || payload.fx.base !== 'USD'
    || typeof payload.fx.stale !== 'boolean'
    || !isValidIsoTimestamp(payload.fx.fetchedAt)
    || !isPlainObject(payload.fx.rates)
    || payload.fx.rates.USD !== 1
    || !Number.isFinite(payload.fx.rates.CNY)
    || payload.fx.rates.CNY <= 0) {
    throw new Error('prices.json has an unsupported or unsafe structure');
  }

  const tierIds = new Set();
  const tierCapacities = new Set();
  for (const tier of payload.tiers) {
    if (!isPlainObject(tier)
      || typeof tier.id !== 'string'
      || !tier.id.trim()
      || typeof tier.label !== 'string'
      || !tier.label.trim()
      || !Number.isFinite(tier.capacityGb)
      || tier.capacityGb <= 0
      || tierIds.has(tier.id)
      || tierCapacities.has(tier.capacityGb)) {
      throw new Error('prices.json has invalid or duplicate tiers');
    }
    tierIds.add(tier.id);
    tierCapacities.add(tier.capacityGb);
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
  for (const country of payload.countries) {
    if (!isPlainObject(country)
      || typeof country.country !== 'string'
      || !country.country.trim()
      || countryNames.has(country.country)
      || UNSAFE_OBJECT_KEYS.has(country.country)
      || typeof country.nameZh !== 'string'
      || !country.nameZh.trim()
      || typeof country.region !== 'string'
      || !country.region.trim()
      || typeof country.currency !== 'string'
      || !/^[A-Z]{3}$/.test(country.currency)
      || !isPlainObject(country.plans)) {
      throw new Error('prices.json has an invalid country entry');
    }
    countryNames.add(country.country);
    const currencyRate = payload.fx.rates[country.currency];
    if (!Number.isFinite(currencyRate) || currencyRate <= 0) {
      throw new Error(`prices.json has an invalid ${country.currency} exchange rate`);
    }
    for (const tierId of tierIds) {
      const plan = country.plans[tierId];
      if (!isPlainObject(plan)
        || !Number.isFinite(plan.price)
        || plan.price <= 0
        || typeof plan.formattedPrice !== 'string'
        || !plan.formattedPrice.trim()) {
        throw new Error(`prices.json has invalid ${tierId} pricing for ${country.country}`);
      }
    }
  }

  if (payload.schemaVersion === 2) {
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
  if (!isPlainObject(payload)
    || ![1, 2].includes(payload.schemaVersion)
    || !isPlainObject(payload.countries)
    || !Object.keys(payload.countries).length
    || !Array.isArray(payload.sourcePublishedDates)
    || !payload.sourcePublishedDates.length
    || (payload.updatedAt != null && !isValidIsoTimestamp(payload.updatedAt))) {
    throw new Error('history.json has an unsupported structure');
  }

  for (const [countryName, record] of Object.entries(payload.countries)) {
    if (UNSAFE_OBJECT_KEYS.has(countryName)
      || !isPlainObject(record)
      || typeof record.nameZh !== 'string'
      || !record.nameZh.trim()
      || typeof record.region !== 'string'
      || !record.region.trim()
      || !Array.isArray(record.events)
      || !record.events.length) {
      throw new Error(`history.json has an invalid record for ${countryName}`);
    }
    let previousObservedAt = '';
    for (const event of record.events) {
      if (!isPlainObject(event)
        || !isValidDateOnly(event.observedAt)
        || event.observedAt < previousObservedAt
        || typeof event.currency !== 'string'
        || !/^[A-Z]{3}$/.test(event.currency)
        || !isPlainObject(event.plans)
        || !Object.keys(event.plans).length
        || Object.values(event.plans).some((price) => !Number.isFinite(price) || price <= 0)
        || !isValidObservationMetadata(event)) {
        throw new Error(`history.json has an invalid event for ${countryName}`);
      }
      previousObservedAt = event.observedAt;
    }
  }

  const publishedDates = new Set();
  let previousPublishedDate = '';
  let previousObservedAt = '';
  for (const entry of payload.sourcePublishedDates) {
    const publishedDate = publicationDateKey(entry?.publishedDate);
    if (!isPlainObject(entry)
      || !isValidDateOnly(publishedDate)
      || publishedDates.has(publishedDate)
      || publishedDate < previousPublishedDate
      || !isValidDateOnly(entry.observedAt)
      || publishedDate > entry.observedAt
      || entry.observedAt < previousObservedAt
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
  const currentPublishedDate = publicationDateKey(prices.source.publishedDate);
  const latestPublishedDate = publicationDateKey(history.sourcePublishedDates.at(-1)?.publishedDate);
  if (latestPublishedDate !== currentPublishedDate) {
    throw new Error('prices.json and history.json have different latest publication dates');
  }
  const tierIds = new Set(prices.tiers.map(({ id }) => id));
  for (const country of prices.countries) {
    const record = history.countries[country.country];
    const latestEvent = record?.events?.at(-1);
    const eventTierIds = new Set(Object.keys(latestEvent?.plans ?? {}));
    if (!record
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
  return fileName === 'history.json'
    ? validateHistoryPayload(payload)
    : validatePricePayload(payload);
}
