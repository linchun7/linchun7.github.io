import * as cheerio from 'cheerio';
import { canonicalTierDefinition } from '../data-contract.js';
import { VALID_REGIONS } from '../data-model.js';
import { MARKET_REGISTRY } from './market-registry.mjs';

const OFFICIAL_COUNTRIES = new Set(Object.values(MARKET_REGISTRY).flatMap((market) => (
  [market.canonicalName, ...(market.aliases ?? [])]
)));

export const TIERS = [
  { id: '50GB', label: '50 GB', capacityGb: 50 },
  { id: '200GB', label: '200 GB', capacityGb: 200 },
  { id: '2TB', label: '2 TB', capacityGb: 2048 },
  { id: '6TB', label: '6 TB', capacityGb: 6144 },
  { id: '12TB', label: '12 TB', capacityGb: 12288 }
];

const REGIONS = {
  nasalac: VALID_REGIONS[0],
  emea: VALID_REGIONS[1],
  ap: VALID_REGIONS[2]
};
const EXPECTED_REGIONS = new Set(VALID_REGIONS);
const MAX_PRICE_TIERS = 20;
const MAX_PRICE_COUNTRIES = 250;
const UNSAFE_COUNTRY_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_COUNTRY_TEXT_PATTERN = /[\0-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ud800-\udfff\ufeff\ufffd]/u;
const STORAGE_TIER_PREFIX_PATTERN = /^\d+(?:\.\d+)?\s*(?:KB|MB|GB|TB|PB|EB|KiB|MiB|GiB|TiB|PiB|EiB)\b/i;

const CURRENCY_ALIASES = {
  Euro: 'EUR'
};

const COUNTRY_ALIASES = {
  Euro: 'Euro Zone'
};

const PRICE_CURRENCY_MARKERS = {
  AED: ['AED'],
  AUD: ['$'],
  BGN: ['лв'],
  BRL: ['R$'],
  CAD: ['$'],
  CHF: ['CHF'],
  CLP: ['$'],
  CNY: ['¥'],
  COP: ['$'],
  CZK: ['Kč'],
  DKK: ['kr'],
  EGP: ['£'],
  EUR: ['€', 'Euro'],
  GBP: ['£'],
  HKD: ['HK$'],
  HUF: ['Ft'],
  IDR: ['Rp'],
  ILS: ['₪'],
  INR: ['Rs'],
  JPY: ['¥'],
  KRW: ['₩'],
  KZT: ['₸'],
  MXN: ['$'],
  MYR: ['RM'],
  NGN: ['₦'],
  NOK: ['kr'],
  NZD: ['$'],
  PEN: ['S/.'],
  PHP: ['₱'],
  PKR: ['Rs'],
  PLN: ['zł'],
  QAR: ['﷼'],
  RON: ['lei'],
  RUB: ['p.'],
  SAR: ['﷼'],
  SEK: ['kr'],
  SGD: ['S$'],
  THB: ['฿'],
  TRY: ['TL'],
  TWD: ['NT$'],
  TZS: ['TSh'],
  USD: ['$'],
  VND: ['₫'],
  ZAR: ['R']
};

export const PRICE_CHANGE_THRESHOLDS = {
  percentage: 2,
  localRelative: 0.5,
  localMinimum: 1,
  cnyMinimum: 15,
  cnyRelative: 0.5,
  marketRelative: 0.5,
  fxRelative: 0.5,
  marketOutlierRatio: 20
};

function cleanText(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanPublishedDate(value) {
  return cleanText(value).replace(/^published\s+date\s*:?\s*/i, '');
}

function headingText($, heading) {
  const $heading = $(heading).clone();
  $heading.find('sup').remove();
  return cleanText($heading.text());
}

function resolveRegion($, heading) {
  const sectionId = $(heading).attr('id');
  if (REGIONS[sectionId]) return { sectionId, region: REGIONS[sectionId] };

  const text = headingText($, heading).toLowerCase();
  if (text.includes('north america') && text.includes('caribbean')) {
    return { sectionId: 'nasalac', region: REGIONS.nasalac };
  }
  if (text.includes('europe') && text.includes('middle east') && text.includes('africa')) {
    return { sectionId: 'emea', region: REGIONS.emea };
  }
  if (text.includes('asia pacific')) {
    return { sectionId: 'ap', region: REGIONS.ap };
  }
  return null;
}

function normalizeCurrencyMarker(value) {
  return cleanText(value).replace(/\s+/g, '');
}

function isCurrencyDecoration(value, currency) {
  const normalized = normalizeCurrencyMarker(value);
  if (!normalized) return true;
  const allowed = new Set([
    currency,
    ...(PRICE_CURRENCY_MARKERS[currency] ?? [])
  ].map(normalizeCurrencyMarker));
  return allowed.has(normalized);
}

function parseNumericToken(token) {
  const normalized = token
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/’/g, "'")
    .trim();
  const groupedInteger = /[1-9]\d{0,2}(?:[.,' ]\d{3})+/;
  const decimal = new RegExp(`^(?:${groupedInteger.source}|\\d+)[.,]\\d{1,2}$`);
  const grouped = new RegExp(`^${groupedInteger.source}$`);
  const plain = /^\d+$/;
  if (!decimal.test(normalized) && !grouped.test(normalized) && !plain.test(normalized)) {
    return Number.NaN;
  }

  if (decimal.test(normalized)) {
    const decimalIndex = Math.max(normalized.lastIndexOf(','), normalized.lastIndexOf('.'));
    if (normalized.slice(0, decimalIndex).includes(normalized[decimalIndex])) return Number.NaN;
    const integerPart = normalized.slice(0, decimalIndex).replace(/[.,' ]/g, '');
    const fractionPart = normalized.slice(decimalIndex + 1);
    return Number(`${integerPart}.${fractionPart}`);
  }
  return Number(normalized.replace(/[.,' ]/g, ''));
}

function parsePriceNumber(value, currency) {
  const text = cleanText(value);
  const firstDigit = text.search(/\d/);
  const sign = text.search(/[+−-]/);
  if (sign >= 0 && (firstDigit < 0 || sign < firstDigit)) return Number.NaN;
  if (/[()]/.test(text)) return Number.NaN;

  const matches = [...text.matchAll(/[0-9][0-9.,\s'’]*/g)];
  if (matches.length !== 1) return Number.NaN;
  const match = matches[0];
  const rawToken = match[0];
  const token = rawToken.trim();
  const tokenStart = match.index + rawToken.search(/\S/);
  const tokenEnd = tokenStart + token.length;
  const prefix = text.slice(0, tokenStart).trim();
  const suffix = text.slice(tokenEnd).trim();
  if (!isCurrencyDecoration(prefix, currency) || !isCurrencyDecoration(suffix, currency)) {
    return Number.NaN;
  }
  const price = parseNumericToken(token);
  return Number.isFinite(price) ? price : Number.NaN;
}

function parseTierLabel(label) {
  const match = cleanText(label).match(/^(\d+(?:\.\d+)?)\s*(GB|TB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const normalizedAmount = String(amount).replace(/\.0+$/, '');
  return canonicalTierDefinition(`${normalizedAmount}${unit}`);
}

function rejectUnsupportedStorageTier(text, country) {
  if (STORAGE_TIER_PREFIX_PATTERN.test(cleanText(text))) {
    throw new Error(`Unsupported storage tier "${cleanText(text)}" for ${country}`);
  }
}

function isPriceList($, node) {
  return $(node).find('li').toArray().some((item) => (
    /^\d+(?:\.\d+)?\s*(?:GB|TB)\s*:?\s*\S+/i.test(cleanText($(item).text()))
  ));
}

function itemText($, item) {
  const $item = $(item).clone();
  $item.find('sup').remove();
  return cleanText($item.text());
}

function isCountryHeading($, node) {
  return /\([^)]+\)\s*$/.test(headingText($, node));
}

function extractPublishedDate($) {
  // Accept Apple publication dates with or without a <time> element.
  const publishedTime = $('time').toArray().reverse().find((node) => (
    /published\s+date/i.test(cleanText($(node).parent().text()))
  ));
  if (publishedTime) {
    const datetime = cleanPublishedDate($(publishedTime).attr('datetime') ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(datetime)) return datetime;
    return cleanPublishedDate($(publishedTime).text()) || datetime;
  }

  const pageText = cleanText($.root().text());
  const textMatch = pageText.match(/published\s+date\s*:?\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (textMatch) return cleanText(textMatch[1]);
  return null;
}

function parseCountryHeading($, heading, { allowUnknownCountries = false } = {}) {
  const title = headingText($, heading);
  const titleMatch = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);

  if (!titleMatch) throw new Error(`Unable to parse country heading: ${title}`);

  const [, countryLabel, currencyLabel] = titleMatch;
  const normalizedCountryLabel = cleanText(countryLabel);
  if (!normalizedCountryLabel) throw new Error(`Country heading is missing a country name: ${title}`);
  const country = COUNTRY_ALIASES[normalizedCountryLabel] ?? normalizedCountryLabel;
  if (!allowUnknownCountries && !OFFICIAL_COUNTRIES.has(country)) {
    throw new Error(`Unknown Apple country heading "${normalizedCountryLabel}"`);
  }
  const currency = /^[A-Z]{3}$/.test(currencyLabel)
    ? currencyLabel
    : CURRENCY_ALIASES[currencyLabel];
  if (!currency) throw new Error(`Unknown currency label "${currencyLabel}" for ${country}`);
  return { country: cleanText(country), currency };
}

function parseCountry($, heading, priceList, region, options) {
  const { country, currency } = parseCountryHeading($, heading, options);
  const $prices = $(priceList);

  const plans = {};
  const detectedTiers = new Map();
  $prices.find('li').each((_, item) => {
    const text = itemText($, item);
    const match = text.match(/^(\d+(?:\.\d+)?\s*(?:GB|TB))\s*:?\s*(.+)$/i);
    if (!match) {
      rejectUnsupportedStorageTier(text, country);
      return;
    }

    const tier = parseTierLabel(match[1]);
    const formattedPrice = cleanText(match[2]).replace(/^:\s*/, '');
    const price = parsePriceNumber(formattedPrice, currency);
    if (!tier || !Number.isFinite(price)) {
      throw new Error(`Unable to parse price "${text}" for ${country}`);
    }
    if (detectedTiers.has(tier.id) || plans[tier.id]) {
      throw new Error(`Duplicate ${tier.label} price for ${country}`);
    }
    detectedTiers.set(tier.id, tier);
    plans[tier.id] = { price, formattedPrice };
  });

  return { country, region, currency, plans, detectedTiers: [...detectedTiers.values()] };
}

function parseCountryByAppleMarkers($, heading, priceList, region, options) {
  const { country, currency } = parseCountryHeading($, heading, options);
  const plans = {};
  const detectedTiers = new Map();
  const tierItems = $(priceList).find('li').toArray().filter((item) => (
    STORAGE_TIER_PREFIX_PATTERN.test(itemText($, item))
  ));

  $(priceList).find('li').each((_, item) => {
    const $item = $(item).clone();
    $item.find('sup').remove();
    const labelNode = $item.find('b, strong').first();
    if (!labelNode.length) {
      rejectUnsupportedStorageTier(itemText($, item), country);
      return;
    }
    const rawLabel = cleanText(labelNode.text());
    const tier = parseTierLabel(rawLabel.replace(/:\s*$/, ''));
    if (!tier) {
      rejectUnsupportedStorageTier(rawLabel, country);
      return;
    }

    const markedItemText = cleanText($item.text());
    const formattedPrice = cleanText(markedItemText.slice(rawLabel.length)).replace(/^:\s*/, '');
    const price = parsePriceNumber(formattedPrice, currency);
    if (!Number.isFinite(price)) {
      throw new Error(`Unable to parse marked price "${markedItemText}" for ${country}`);
    }
    if (detectedTiers.has(tier.id) || plans[tier.id]) {
      throw new Error(`Duplicate marked ${tier.label} price for ${country}`);
    }
    detectedTiers.set(tier.id, tier);
    plans[tier.id] = { price, formattedPrice };
  });

  if (!detectedTiers.size) throw new Error(`No marked prices found for ${country}`);
  if (detectedTiers.size !== tierItems.length) {
    throw new Error(`Marked parser missed ${tierItems.length - detectedTiers.size} price item(s) for ${country}`);
  }
  return { country, region, currency, plans, detectedTiers: [...detectedTiers.values()] };
}

function finalizeParsedResult($, parsedCountries, foundRegions) {
  for (const sectionId of Object.keys(REGIONS)) {
    if (!foundRegions.has(sectionId)) {
      throw new Error(`Apple pricing section #${sectionId} was not found`);
    }
  }

  const tierMap = new Map();
  const capacityMap = new Map();
  for (const country of parsedCountries) {
    for (const tier of country.detectedTiers) {
      if (!Number.isFinite(tier.capacityGb) || tier.capacityGb <= 0) {
        throw new Error(`Invalid storage capacity for ${tier.label}`);
      }
      const equivalent = capacityMap.get(tier.capacityGb);
      if (equivalent && equivalent.id !== tier.id) {
        throw new Error(`Duplicate storage capacity ${tier.capacityGb} GB: ${equivalent.label} and ${tier.label}`);
      }
      capacityMap.set(tier.capacityGb, tier);
      tierMap.set(tier.id, tier);
    }
  }
  const tiers = [...tierMap.values()].sort((first, second) => first.capacityGb - second.capacityGb);
  if (!tiers.length) throw new Error('No storage tiers were found in Apple pricing data');

  const countries = parsedCountries.map(({ detectedTiers, ...country }) => country);
  return { countries, tiers, sourcePublishedDate: extractPublishedDate($) };
}

function parseByDocumentOrder($, options) {
  const parsedCountries = [];
  const foundRegions = new Set();
  const nodes = $('h2, h3, h4, h5, .gb-header, ul').toArray();
  let currentRegion = null;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if ($(node).is('ul')) continue;

    const resolvedRegion = resolveRegion($, node);
    if (resolvedRegion) {
      currentRegion = resolvedRegion.region;
      foundRegions.add(resolvedRegion.sectionId);
      continue;
    }
    if (!currentRegion || !isCountryHeading($, node)) {
      if ($(node).is('h2, h3')) currentRegion = null;
      continue;
    }

    // Validate the heading before rejecting ambiguous neighboring lists so pseudo-country headings fail closed.
    parseCountryHeading($, node, options);
    const priceLists = [];
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const candidate = nodes[nextIndex];
      if (resolveRegion($, candidate) || isCountryHeading($, candidate)) break;
      if ($(candidate).is('h2, h3, h4, h5')) {
        continue;
      }
      if ($(candidate).is('ul') && isPriceList($, candidate)) {
        priceLists.push(candidate);
      }
    }
    if (!priceLists.length) throw new Error(`Price list not found after ${headingText($, node)}`);
    if (priceLists.length > 1) throw new Error(`Ambiguous price lists found after ${headingText($, node)}`);
    parsedCountries.push(parseCountry($, node, priceLists[0], currentRegion, options));
  }

  return finalizeParsedResult($, parsedCountries, foundRegions);
}

function parseByAppleMarkers($, options) {
  const parsedCountries = [];
  const foundRegions = new Set();
  const nodes = $('#nasalac, #emea, #ap, h2, h3, h4, h5, .gb-header, ul').toArray();
  let currentRegion = null;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const sectionId = $(node).attr('id');
    if (REGIONS[sectionId]) {
      currentRegion = REGIONS[sectionId];
      foundRegions.add(sectionId);
      continue;
    }
    if (!$(node).hasClass('gb-header') || !isCountryHeading($, node)) continue;
    if (!currentRegion) throw new Error(`Apple marker parser found a country before a region: ${headingText($, node)}`);

    // Validate the heading before rejecting ambiguous neighboring lists so pseudo-country headings fail closed.
    parseCountryHeading($, node, options);
    const priceLists = [];
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const candidate = nodes[nextIndex];
      if (isCountryHeading($, candidate) || REGIONS[$(candidate).attr('id')]) break;
      if ($(candidate).is('ul') && isPriceList($, candidate)) {
        priceLists.push(candidate);
      }
    }
    if (!priceLists.length) throw new Error(`Apple marker price list not found after ${headingText($, node)}`);
    if (priceLists.length > 1) throw new Error(`Ambiguous Apple marker price lists after ${headingText($, node)}`);
    parsedCountries.push(parseCountryByAppleMarkers($, node, priceLists[0], currentRegion, options));
  }

  return finalizeParsedResult($, parsedCountries, foundRegions);
}

function comparableParseResult(result) {
  return JSON.stringify({
    sourcePublishedDate: result.sourcePublishedDate,
    tiers: result.tiers,
    countries: result.countries
  });
}

export function parseApplePrices(html, { allowUnknownCountries = false } = {}) {
  const $ = cheerio.load(html);
  const options = { allowUnknownCountries };
  let documentOrderResult = null;
  let appleMarkerResult = null;
  let documentOrderError = null;
  let appleMarkerError = null;

  try {
    documentOrderResult = parseByDocumentOrder($, options);
  } catch (error) {
    documentOrderError = error;
  }
  try {
    appleMarkerResult = parseByAppleMarkers($, options);
  } catch (error) {
    appleMarkerError = error;
  }

  if (documentOrderResult && appleMarkerResult) {
    if (comparableParseResult(documentOrderResult) !== comparableParseResult(appleMarkerResult)) {
      throw new Error('Apple parser disagreement: document-order and marker paths returned different pricing data');
    }
    return {
      ...documentOrderResult,
      parser: 'cross-checked',
      parserStatus: 'Both DOM association paths agreed'
    };
  }
  if (documentOrderResult) {
    return {
      ...documentOrderResult,
      parser: 'document-order',
      parserStatus: `Apple marker parser unavailable: ${appleMarkerError?.message ?? 'unknown error'}`
    };
  }
  if (appleMarkerResult) {
    return {
      ...appleMarkerResult,
      parser: 'apple-markers-fallback',
      parserStatus: `Document-order parser unavailable: ${documentOrderError?.message ?? 'unknown error'}`
    };
  }
  throw new Error(`Both Apple parsers failed; document-order: ${documentOrderError?.message}; apple-markers: ${appleMarkerError?.message}`);
}

export function validatePrices(countries, {
  minCountries = 60,
  previousCountries = [],
  confirmedRemovedCountries = [],
  previousRates,
  currentRates,
  tiers = TIERS
} = {}) {
  if (!Array.isArray(countries)) throw new Error('Apple pricing countries have an unsupported structure');
  if (!Array.isArray(tiers) || !tiers.length || tiers.length > MAX_PRICE_TIERS) {
    throw new Error('Apple pricing tiers have an unsupported structure');
  }

  const tierIds = new Set();
  const tierCapacities = new Set();
  let previousTierCapacity = 0;
  for (const tier of tiers) {
    if (!tier
      || canonicalTierDefinition(tier.id)?.label !== tier.label
      || canonicalTierDefinition(tier.id)?.capacityGb !== tier.capacityGb
      || tierIds.has(tier.id)
      || tierCapacities.has(tier.capacityGb)
      || tier.capacityGb <= previousTierCapacity) {
      throw new Error('Apple pricing has invalid or duplicate tiers');
    }
    tierIds.add(tier.id);
    tierCapacities.add(tier.capacityGb);
    previousTierCapacity = tier.capacityGb;
  }

  if (countries.length < minCountries) {
    throw new Error(`Only ${countries.length} countries were parsed; expected at least ${minCountries}`);
  }
  if (countries.length > MAX_PRICE_COUNTRIES) {
    throw new Error(`Too many countries were parsed: ${countries.length}`);
  }

  const seen = new Set();
  for (const entry of countries) {
    if (!entry
      || typeof entry.country !== 'string'
      || !entry.country.trim()
      || entry.country.length > 160
      || UNSAFE_COUNTRY_NAMES.has(entry.country)
      || FORBIDDEN_COUNTRY_TEXT_PATTERN.test(entry.country)
      || typeof entry.region !== 'string'
      || !entry.region.trim()
      || !EXPECTED_REGIONS.has(entry.region)
      || typeof entry.currency !== 'string'
      || !/^[A-Z]{3}$/.test(entry.currency)
      || !entry.plans
      || typeof entry.plans !== 'object'
      || Array.isArray(entry.plans)) {
      throw new Error('Apple pricing contains an invalid country, region, currency, or plans entry');
    }
    const key = entry.country;
    if (seen.has(key)) throw new Error(`Duplicate country entry: ${key}`);
    seen.add(key);

    for (const tier of tiers) {
      const plan = entry.plans[tier.id];
      if (!plan || !Number.isFinite(plan.price) || plan.price <= 0 || plan.price > Number.MAX_SAFE_INTEGER) {
        throw new Error(`Invalid ${tier.id} price for ${entry.country}`);
      }
    }
    const planIds = Object.keys(entry.plans);
    if (planIds.length !== tierIds.size || [...tierIds].some((tierId) => !Object.hasOwn(entry.plans, tierId))) {
      throw new Error(`Apple pricing plans do not exactly match tiers for ${entry.country}`);
    }
  }

  if (previousCountries.length) {
    const previousCountryNames = new Set(previousCountries.map(({ country }) => country));
    const currentCountryNames = new Set(countries.map(({ country }) => country));
    const missingCountries = [...previousCountryNames].filter((country) => !currentCountryNames.has(country));
    if (missingCountries.length) {
      const confirmed = new Set(confirmedRemovedCountries);
      const unconfirmed = missingCountries.filter((country) => !confirmed.has(country));
      const unexpectedConfirmations = [...confirmed].filter((country) => !missingCountries.includes(country));
      if (unconfirmed.length || unexpectedConfirmations.length || confirmed.size !== missingCountries.length) {
        const details = [
          unconfirmed.length ? `unconfirmed: ${unconfirmed.join(', ')}` : null,
          unexpectedConfirmations.length ? `unexpected confirmations: ${unexpectedConfirmations.join(', ')}` : null
        ].filter(Boolean).join('; ');
        throw new Error(`Previously published countries are missing without exact confirmation: ${missingCountries.join(', ')}${details ? ` (${details})` : ''}`);
      }
    }

    const confirmed = new Set(confirmedRemovedCountries);
    const countByRegion = (entries) => entries.reduce((counts, entry) => {
      counts.set(entry.region, (counts.get(entry.region) ?? 0) + 1);
      return counts;
    }, new Map());
    const previousRegionCounts = countByRegion(previousCountries);
    const currentRegionCounts = countByRegion(countries);
    const confirmedRemovedByRegion = countByRegion(
      previousCountries.filter(({ country }) => confirmed.has(country))
    );
    for (const region of EXPECTED_REGIONS) {
      const previousCount = previousRegionCounts.get(region) ?? 0;
      const currentCount = currentRegionCounts.get(region) ?? 0;
      const confirmedRemovalCount = confirmedRemovedByRegion.get(region) ?? 0;
      if (currentCount < previousCount - confirmedRemovalCount - 3) {
        throw new Error(`Country count for ${region} dropped from ${previousCount} to ${currentCount} beyond confirmed removals`);
      }
    }
  }

  const previousByCountry = new Map(previousCountries.map((entry) => [entry.marketId ?? entry.country, entry]));
  for (const entry of countries) {
    const previous = previousByCountry.get(entry.marketId ?? entry.country);
    if (!previous) continue;
    for (const tier of tiers) {
      if (!previous.plans[tier.id]) continue;
      let ratio;
      if (previous.currency === entry.currency) {
        ratio = entry.plans[tier.id].price / previous.plans[tier.id].price;
      } else {
        const previousCny = planCnyPrice(previous.plans[tier.id], previous.currency, previousRates);
        const currentCny = planCnyPrice(entry.plans[tier.id], entry.currency, currentRates);
        if (previousCny == null || currentCny == null) {
          throw new Error(`Cannot validate ${tier.id} currency change for ${entry.country}: exchange rate is missing`);
        }
        ratio = currentCny / previousCny;
      }
      if (ratio < 0.1 || ratio > 10) {
        throw new Error(`Suspicious ${tier.id} price change for ${entry.country}: ratio ${ratio.toFixed(2)}`);
      }
    }
  }
  return true;
}

export function getMissingExchangeRates(countries, rates = {}) {
  return [...new Set(countries.map(({ currency }) => currency))]
    .filter((currency) => !Number.isFinite(rates[currency]) || rates[currency] <= 0);
}

function convertToCny(price, currency, rates) {
  const currencyRate = rates?.[currency];
  const cnyRate = rates?.CNY;
  if (!Number.isFinite(currencyRate) || currencyRate <= 0 || !Number.isFinite(cnyRate) || cnyRate <= 0) return null;
  return (price / currencyRate) * cnyRate;
}

function planCnyPrice(plan, currency, rates) {
  if (Number.isFinite(plan?.cnyPrice) && plan.cnyPrice > 0) return plan.cnyPrice;
  return convertToCny(plan?.price, currency, rates);
}

function symmetricPercentageChange(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0 || current <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(current / previous, previous / current) - 1;
}

function validateCurrentMarketOutliers(countries, tiers, currentRates, thresholds) {
  const ratioLimit = thresholds.marketOutlierRatio ?? PRICE_CHANGE_THRESHOLDS.marketOutlierRatio;
  for (const tier of tiers) {
    const values = countries.map((country) => ({
      country: country.country,
      value: planCnyPrice(country.plans[tier.id], country.currency, currentRates)
    })).filter(({ value }) => Number.isFinite(value) && value > 0);
    if (values.length < 10) continue;
    const sorted = values.map(({ value }) => value).sort((first, second) => first - second);
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
    for (const { country, value } of values) {
      if (value > median * ratioLimit || value * ratioLimit < median) {
        throw new Error(
          `Suspicious ${tier.id} CNY market outlier for ${country}: `
          + `${value.toFixed(2)} versus median ${median.toFixed(2)}`
        );
      }
    }
  }
}

export function validatePriceChangeAnomalies(countries, {
  previousData,
  currentRates,
  tiers = TIERS,
  thresholds = PRICE_CHANGE_THRESHOLDS,
  appleSemanticConfirmed = false,
  fxSanity = null
} = {}) {
  validateCurrentMarketOutliers(countries, tiers, currentRates, thresholds);
  if (!previousData?.countries?.length) return appleSemanticConfirmed || fxSanity ? [] : true;
  const previousByCountry = new Map(previousData.countries.map((entry) => [entry.marketId ?? entry.country, entry]));
  const warnings = [];
  const warningFor = (code, { type, entry, previous, tier, previousValue, currentValue, fxSanityStatus }) => {
    warnings.push({
      code,
      type,
      marketId: entry.marketId ?? previous.marketId ?? null,
      sourceName: entry.country,
      tier: tier.id,
      previous: previousValue,
      current: currentValue,
      ...(fxSanityStatus ? { currency: entry.currency, fxSanityStatus } : {})
    });
  };
  const currencySanityStatus = (currency) => (
    fxSanity?.checks?.find((check) => check.currency === currency)?.status ?? null
  );

  for (const entry of countries) {
    const previous = previousByCountry.get(entry.marketId ?? entry.country);
    if (!previous) continue;
    for (const tier of tiers) {
      const currentPlan = entry.plans[tier.id];
      const previousPlan = previous.plans[tier.id];
      const currencyChanged = previous.currency !== entry.currency;
      if (!currentPlan || !previousPlan) continue;

      const previousCnyAtPreviousRate = planCnyPrice(
        previousPlan,
        previous.currency,
        previousData.fx?.rates
      );
      const currentCnyAtCurrentRate = planCnyPrice(
        currentPlan,
        entry.currency,
        currentRates
      );
      if (previousCnyAtPreviousRate == null || currentCnyAtCurrentRate == null) {
        throw new Error(`Cannot validate combined ${tier.id} currency change for ${entry.country}: exchange rate is missing`);
      }

      if (!currencyChanged && currentPlan.price === previousPlan.price) {
        const cnyDelta = Math.abs(currentCnyAtCurrentRate - previousCnyAtPreviousRate);
        const percentageDelta = symmetricPercentageChange(currentCnyAtCurrentRate, previousCnyAtPreviousRate);
        const fxRelative = thresholds.fxRelative ?? PRICE_CHANGE_THRESHOLDS.fxRelative;
        const cnyThreshold = Math.max(thresholds.cnyMinimum, previousCnyAtPreviousRate * fxRelative);
        if (percentageDelta >= fxRelative && percentageDelta > 0 && cnyDelta >= cnyThreshold && cnyDelta > 0) {
          const message = `Suspicious FX-derived ${tier.id} CNY change for ${entry.country}: `
            + `${(percentageDelta * 100).toFixed(1)}%, CNY ${cnyDelta.toFixed(2)}/${cnyThreshold.toFixed(2)}`;
          if (!fxSanity) throw new Error(message);
          warningFor('FX_DERIVED_CHANGE_ANOMALY_ACCEPTED', {
            type: 'fx-derived-cny', entry, previous, tier,
            previousValue: previousCnyAtPreviousRate,
            currentValue: currentCnyAtCurrentRate,
            fxSanityStatus: currencySanityStatus(entry.currency) ?? fxSanity.status
          });
        }
        continue;
      }

      if (currencyChanged) {
        const cnyDelta = Math.abs(currentCnyAtCurrentRate - previousCnyAtPreviousRate);
        const percentageDelta = symmetricPercentageChange(currentCnyAtCurrentRate, previousCnyAtPreviousRate);
        const fixedRateThreshold = Math.max(
          thresholds.cnyMinimum,
          previousCnyAtPreviousRate * (thresholds.cnyRelative ?? PRICE_CHANGE_THRESHOLDS.cnyRelative)
        );
        const marketAdjustedThreshold = Math.max(
          thresholds.cnyMinimum,
          previousCnyAtPreviousRate * (thresholds.marketRelative ?? PRICE_CHANGE_THRESHOLDS.marketRelative)
        );
        if (percentageDelta >= thresholds.percentage
          && cnyDelta >= fixedRateThreshold
          && cnyDelta >= marketAdjustedThreshold) {
          const message = `Suspicious combined ${tier.id} price change for ${entry.country}: `
            + `${previous.currency} to ${entry.currency}, ${(percentageDelta * 100).toFixed(1)}%, `
            + `CNY ${cnyDelta.toFixed(2)}/${Math.max(fixedRateThreshold, marketAdjustedThreshold).toFixed(2)}`;
          const fxSanityStatus = entry.currency === 'CNY' ? 'not-required-cny' : currencySanityStatus(entry.currency);
          if (!appleSemanticConfirmed) throw new Error(message);
          if (entry.currency !== 'CNY' && fxSanityStatus !== 'passed') {
            const error = new Error(`CURRENCY_CHANGE_VALUE_REVIEW_REQUIRED: ${message}; FX sanity status ${fxSanityStatus ?? 'missing'}`);
            error.code = 'CURRENCY_CHANGE_VALUE_REVIEW_REQUIRED';
            throw error;
          }
          warningFor('CURRENCY_CHANGE_ANOMALY_ACCEPTED', {
            type: 'combined-currency', entry, previous, tier,
            previousValue: { currency: previous.currency, price: previousPlan.price },
            currentValue: { currency: entry.currency, price: currentPlan.price },
            fxSanityStatus
          });
        }
        continue;
      }

      const localDelta = Math.abs(currentPlan.price - previousPlan.price);
      const percentageDelta = symmetricPercentageChange(currentPlan.price, previousPlan.price);
      const currentCnyAtPreviousRate = previousPlan.price > 0
        ? currentPlan.price * (previousCnyAtPreviousRate / previousPlan.price)
        : null;
      if (currentCnyAtPreviousRate == null) continue;

      const fixedRateCnyDelta = Math.abs(currentCnyAtPreviousRate - previousCnyAtPreviousRate);
      const marketAdjustedCnyDelta = Math.abs(currentCnyAtCurrentRate - previousCnyAtPreviousRate);
      const fixedRateThreshold = Math.max(
        thresholds.cnyMinimum,
        previousCnyAtPreviousRate * (thresholds.cnyRelative ?? PRICE_CHANGE_THRESHOLDS.cnyRelative)
      );
      const marketAdjustedThreshold = Math.max(
        thresholds.cnyMinimum,
        previousCnyAtPreviousRate * (thresholds.marketRelative ?? PRICE_CHANGE_THRESHOLDS.marketRelative)
      );
      const localThreshold = Math.max(thresholds.localMinimum, previousPlan.price * thresholds.localRelative);

      if (percentageDelta >= thresholds.percentage
        && localDelta >= localThreshold
        && fixedRateCnyDelta >= fixedRateThreshold
        && marketAdjustedCnyDelta >= marketAdjustedThreshold) {
        const message = `Suspicious combined ${tier.id} price change for ${entry.country}: `
          + `${(percentageDelta * 100).toFixed(1)}%, local ${localDelta.toFixed(2)}, `
          + `fixed-rate CNY ${fixedRateCnyDelta.toFixed(2)}/${fixedRateThreshold.toFixed(2)}, `
          + `market-adjusted CNY ${marketAdjustedCnyDelta.toFixed(2)}/${marketAdjustedThreshold.toFixed(2)}`;
        if (!appleSemanticConfirmed) throw new Error(message);
        warningFor('PRICE_CHANGE_ANOMALY_CONFIRMED', {
          type: 'combined-local-price', entry, previous, tier,
          previousValue: previousPlan.price,
          currentValue: currentPlan.price
        });
      }
    }
  }
  return appleSemanticConfirmed || fxSanity ? warnings : true;
}
