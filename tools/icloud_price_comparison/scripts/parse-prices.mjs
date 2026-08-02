import * as cheerio from 'cheerio';

export const TIERS = [
  { id: '50GB', label: '50 GB', capacityGb: 50 },
  { id: '200GB', label: '200 GB', capacityGb: 200 },
  { id: '2TB', label: '2 TB', capacityGb: 2048 },
  { id: '6TB', label: '6 TB', capacityGb: 6144 },
  { id: '12TB', label: '12 TB', capacityGb: 12288 }
];

const REGIONS = {
  nasalac: 'Americas',
  emea: 'Europe, Middle East & Africa',
  ap: 'Asia Pacific'
};

const CURRENCY_ALIASES = {
  Euro: 'EUR'
};

const COUNTRY_ALIASES = {
  Euro: 'Euro Zone'
};

export const PRICE_CHANGE_THRESHOLDS = {
  percentage: 2,
  localRelative: 0.5,
  localMinimum: 1,
  cnyMinimum: 15,
  cnyRelative: 0.5,
  marketRelative: 0.5
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

function parsePriceNumber(value) {
  const firstDigit = value.search(/\d/);
  const sign = value.search(/[−-]/);
  if (sign >= 0 && (firstDigit < 0 || sign < firstDigit)) return Number.NaN;
  const match = value.match(/[0-9][0-9.,\s'’]*/);
  if (!match) return Number.NaN;
  const compact = match[0].replace(/[\s'’]/g, '');
  const lastComma = compact.lastIndexOf(',');
  const lastDot = compact.lastIndexOf('.');
  let normalized = compact;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const groupingSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = compact.replaceAll(groupingSeparator, '').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    const groups = compact.split(',');
    normalized = groups.length === 2 && groups[1].length > 0 && groups[1].length <= 2
      ? `${groups[0]}.${groups[1]}`
      : groups.join('');
  }

  return Number(normalized);
}

function parseTierLabel(label) {
  const match = cleanText(label).match(/^(\d+(?:\.\d+)?)\s*(GB|TB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const capacityGb = amount * (unit === 'TB' ? 1024 : 1);
  const normalizedAmount = String(amount).replace(/\.0+$/, '');
  return {
    id: `${normalizedAmount}${unit}`,
    label: `${normalizedAmount} ${unit}`,
    capacityGb
  };
}

function isPriceList($, node) {
  return $(node).find('li').toArray().some((item) => (
    /^\d+(?:\.\d+)?\s*(?:GB|TB)\s*:?\s*\S+/i.test(cleanText($(item).text()))
  ));
}

function extractPublishedDate($) {
  // Accept Apple publication dates with or without a <time> element.
  const publishedTime = $('time').toArray().reverse().find((node) => (
    /published\s+date/i.test(cleanText($(node).parent().text()))
  ));
  if (publishedTime) {
    return cleanPublishedDate($(publishedTime).text()) || cleanPublishedDate($(publishedTime).attr('datetime') ?? '');
  }

  const pageText = cleanText($.root().text());
  const textMatch = pageText.match(/published\s+date\s*:?\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (textMatch) return cleanText(textMatch[1]);
  return null;
}

function parseCountryHeading($, heading) {
  const title = headingText($, heading);
  const titleMatch = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);

  if (!titleMatch) throw new Error(`Unable to parse country heading: ${title}`);

  const [, countryLabel, currencyLabel] = titleMatch;
  const country = COUNTRY_ALIASES[countryLabel] ?? countryLabel;
  const currency = /^[A-Z]{3}$/.test(currencyLabel)
    ? currencyLabel
    : CURRENCY_ALIASES[currencyLabel];
  if (!currency) throw new Error(`Unknown currency label "${currencyLabel}" for ${country}`);
  return { country: cleanText(country), currency };
}

function parseCountry($, heading, priceList, region) {
  const { country, currency } = parseCountryHeading($, heading);
  const $prices = $(priceList);

  const plans = {};
  const detectedTiers = new Map();
  $prices.find('li').each((_, item) => {
    const text = cleanText($(item).text());
    const match = text.match(/^(\d+(?:\.\d+)?\s*(?:GB|TB))\s*:?\s*(.+)$/i);
    if (!match) return;

    const tier = parseTierLabel(match[1]);
    const formattedPrice = cleanText(match[2]).replace(/^:\s*/, '');
    const price = parsePriceNumber(formattedPrice);
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

function parseCountryByAppleMarkers($, heading, priceList, region) {
  const { country, currency } = parseCountryHeading($, heading);
  const plans = {};
  const detectedTiers = new Map();
  const tierItems = $(priceList).find('li').toArray().filter((item) => (
    /^(?:\s*\d+(?:\.\d+)?\s*(?:GB|TB))/i.test(cleanText($(item).text()))
  ));

  $(priceList).find('li').each((_, item) => {
    const labelNode = $(item).find('b, strong').first();
    if (!labelNode.length) return;
    const rawLabel = cleanText(labelNode.text());
    const tier = parseTierLabel(rawLabel.replace(/:\s*$/, ''));
    if (!tier) return;

    const itemText = cleanText($(item).text());
    const formattedPrice = cleanText(itemText.slice(rawLabel.length)).replace(/^:\s*/, '');
    const price = parsePriceNumber(formattedPrice);
    if (!Number.isFinite(price)) {
      throw new Error(`Unable to parse marked price "${itemText}" for ${country}`);
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
  for (const country of parsedCountries) {
    for (const tier of country.detectedTiers) tierMap.set(tier.id, tier);
  }
  const tiers = [...tierMap.values()].sort((first, second) => first.capacityGb - second.capacityGb);
  if (!tiers.length) throw new Error('No storage tiers were found in Apple pricing data');

  const countries = parsedCountries.map(({ detectedTiers, ...country }) => country);
  return { countries, tiers, sourcePublishedDate: extractPublishedDate($) };
}

function parseByDocumentOrder($) {
  const parsedCountries = [];
  const foundRegions = new Set();
  const nodes = $('h2, h3, h4, h5, ul').toArray();
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
    if (!currentRegion || !/\([^)]+\)\s*$/.test(headingText($, node))) {
      if ($(node).is('h2, h3')) currentRegion = null;
      continue;
    }

    let priceList = null;
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const candidate = nodes[nextIndex];
      if ($(candidate).is('h2, h3, h4, h5')) {
        const candidateText = headingText($, candidate);
        if (resolveRegion($, candidate) || /\([^)]+\)\s*$/.test(candidateText)) break;
        continue;
      }
      if ($(candidate).is('ul') && isPriceList($, candidate)) {
        priceList = candidate;
        break;
      }
    }
    if (!priceList) throw new Error(`Price list not found after ${headingText($, node)}`);
    parsedCountries.push(parseCountry($, node, priceList, currentRegion));
  }

  return finalizeParsedResult($, parsedCountries, foundRegions);
}

function parseByAppleMarkers($) {
  const parsedCountries = [];
  const foundRegions = new Set();
  const nodes = $('#nasalac, #emea, #ap, h4.gb-header, ul').toArray();
  let currentRegion = null;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const sectionId = $(node).attr('id');
    if (REGIONS[sectionId]) {
      currentRegion = REGIONS[sectionId];
      foundRegions.add(sectionId);
      continue;
    }
    if (!$(node).is('h4.gb-header')) continue;
    if (!currentRegion) throw new Error(`Apple marker parser found a country before a region: ${headingText($, node)}`);

    let priceList = null;
    for (let nextIndex = index + 1; nextIndex < nodes.length; nextIndex += 1) {
      const candidate = nodes[nextIndex];
      if ($(candidate).is('h4.gb-header') || REGIONS[$(candidate).attr('id')]) break;
      if ($(candidate).is('ul') && isPriceList($, candidate)) {
        priceList = candidate;
        break;
      }
    }
    if (!priceList) throw new Error(`Apple marker price list not found after ${headingText($, node)}`);
    parsedCountries.push(parseCountryByAppleMarkers($, node, priceList, currentRegion));
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

export function parseApplePrices(html) {
  const $ = cheerio.load(html);
  let primary = null;
  let secondary = null;
  let primaryError = null;
  let secondaryError = null;

  try {
    primary = parseByDocumentOrder($);
  } catch (error) {
    primaryError = error;
  }
  try {
    secondary = parseByAppleMarkers($);
  } catch (error) {
    secondaryError = error;
  }

  if (primary && secondary) {
    if (comparableParseResult(primary) !== comparableParseResult(secondary)) {
      throw new Error('Apple parser disagreement: document-order and marker paths returned different pricing data');
    }
    return {
      ...primary,
      parser: 'cross-checked',
      parserStatus: 'Both independent parser paths agreed'
    };
  }
  if (primary) {
    return {
      ...primary,
      parser: 'document-order',
      parserStatus: `Apple marker parser unavailable: ${secondaryError?.message ?? 'unknown error'}`
    };
  }
  if (secondary) {
    return {
      ...secondary,
      parser: 'apple-markers-fallback',
      parserStatus: `Document-order parser unavailable: ${primaryError?.message ?? 'unknown error'}`
    };
  }
  throw new Error(`Both Apple parsers failed; document-order: ${primaryError?.message}; apple-markers: ${secondaryError?.message}`);
}

export function validatePrices(countries, { minCountries = 60, previousCountries = [], tiers = TIERS } = {}) {
  if (countries.length < minCountries) {
    throw new Error(`Only ${countries.length} countries were parsed; expected at least ${minCountries}`);
  }

  const seen = new Set();
  for (const entry of countries) {
    const key = entry.country;
    if (seen.has(key)) throw new Error(`Duplicate country entry: ${key}`);
    seen.add(key);

    for (const tier of tiers) {
      const plan = entry.plans[tier.id];
      if (!plan || !Number.isFinite(plan.price) || plan.price <= 0) {
        throw new Error(`Invalid ${tier.id} price for ${entry.country}`);
      }
    }
  }

  if (previousCountries.length && countries.length < previousCountries.length - 3) {
    throw new Error(`Country count dropped from ${previousCountries.length} to ${countries.length}`);
  }

  const previousByCountry = new Map(previousCountries.map((entry) => [entry.country, entry]));
  for (const entry of countries) {
    const previous = previousByCountry.get(entry.country);
    if (!previous || previous.currency !== entry.currency) continue;
    for (const tier of tiers) {
      if (!previous.plans[tier.id]) continue;
      const ratio = entry.plans[tier.id].price / previous.plans[tier.id].price;
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

export function validatePriceChangeAnomalies(countries, {
  previousData,
  currentRates,
  tiers = TIERS,
  thresholds = PRICE_CHANGE_THRESHOLDS
} = {}) {
  if (!previousData?.countries?.length || !previousData?.fx?.rates) return true;
  const previousByCountry = new Map(previousData.countries.map((entry) => [entry.country, entry]));

  for (const entry of countries) {
    const previous = previousByCountry.get(entry.country);
    if (!previous || previous.currency !== entry.currency) continue;
    for (const tier of tiers) {
      const currentPlan = entry.plans[tier.id];
      const previousPlan = previous.plans[tier.id];
      if (!currentPlan || !previousPlan || currentPlan.price === previousPlan.price) continue;

      const localDelta = Math.abs(currentPlan.price - previousPlan.price);
      const percentageDelta = localDelta / previousPlan.price;
      const previousCnyAtPreviousRate = convertToCny(
        previousPlan.price,
        entry.currency,
        previousData.fx.rates
      );
      const currentCnyAtPreviousRate = convertToCny(
        currentPlan.price,
        entry.currency,
        previousData.fx.rates
      );
      const currentCnyAtCurrentRate = convertToCny(
        currentPlan.price,
        entry.currency,
        currentRates
      );
      if ([
        previousCnyAtPreviousRate,
        currentCnyAtPreviousRate,
        currentCnyAtCurrentRate
      ].some((value) => value == null)) continue;

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
        throw new Error(
          `Suspicious combined ${tier.id} price change for ${entry.country}: `
          + `${(percentageDelta * 100).toFixed(1)}%, local ${localDelta.toFixed(2)}, `
          + `fixed-rate CNY ${fixedRateCnyDelta.toFixed(2)}/${fixedRateThreshold.toFixed(2)}, `
          + `market-adjusted CNY ${marketAdjustedCnyDelta.toFixed(2)}/${marketAdjustedThreshold.toFixed(2)}`
        );
      }
    }
  }
  return true;
}
