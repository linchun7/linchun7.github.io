import { canonicalTierDefinition } from '../data-contract.js';
import { VALID_REGIONS } from '../data-model.js';
import { MARKET_REGISTRY } from './market-registry.mjs';

const REGIONS = {
  nasalac: VALID_REGIONS[0],
  emea: VALID_REGIONS[1],
  ap: VALID_REGIONS[2]
};

const OFFICIAL_COUNTRIES = new Set(Object.values(MARKET_REGISTRY).flatMap((market) => (
  [market.canonicalName, ...(market.aliases ?? [])]
)));

const CURRENCY_ALIASES = {
  Euro: 'EUR'
};

const COUNTRY_ALIASES = {
  Euro: 'Euro Zone'
};

const PRICE_CURRENCY_MARKERS = {
  AED: ['AED'], AUD: ['$'], BGN: ['лв'], BRL: ['R$'], CAD: ['$'], CHF: ['CHF'],
  CLP: ['$'], CNY: ['¥'], COP: ['$'], CZK: ['Kč'], DKK: ['kr'], EGP: ['£'],
  EUR: ['€', 'Euro'], GBP: ['£'], HKD: ['HK$'], HUF: ['Ft'], IDR: ['Rp'], ILS: ['₪'],
  INR: ['Rs'], JPY: ['¥'], KRW: ['₩'], KZT: ['₸'], MXN: ['$'], MYR: ['RM'], NGN: ['₦'],
  NOK: ['kr'], NZD: ['$'], PEN: ['S/.'], PHP: ['₱'], PKR: ['Rs'], PLN: ['zł'], QAR: ['﷼'],
  RON: ['lei'], RUB: ['p.'], SAR: ['﷼'], SEK: ['kr'], SGD: ['S$'], THB: ['฿'],
  TRY: ['TL'], TWD: ['NT$'], TZS: ['TSh'], USD: ['$'], VND: ['₫'], ZAR: ['R']
};

const FOOTNOTE_SUFFIX_PATTERN = /(?:[¹²³⁰⁴⁵⁶⁷⁸⁹]|\u{1D112})+$/gu;

function cleanText(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function nodeText($, node) {
  const copy = $(node).clone();
  copy.find('sup').remove();
  return cleanText(copy.text());
}

function cleanPublishedDate(value) {
  return cleanText(value).replace(/^published\s+date\s*:?\s*/i, '');
}

function extractPublishedDate($) {
  const publishedTime = $('time').toArray().reverse().find((node) => (
    /published\s+date/i.test(cleanText($(node).parent().text()))
  ));
  if (publishedTime) {
    const datetime = cleanPublishedDate($(publishedTime).attr('datetime') ?? '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(datetime)) return datetime;
    return cleanPublishedDate($(publishedTime).text()) || datetime;
  }

  const pageText = cleanText($.root().text());
  const match = pageText.match(/published\s+date\s*:?\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  return match ? cleanText(match[1]) : null;
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
  if (!decimal.test(normalized) && !grouped.test(normalized) && !plain.test(normalized)) return Number.NaN;

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
  if (!isCurrencyDecoration(prefix, currency) || !isCurrencyDecoration(suffix, currency)) return Number.NaN;
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

function parseCountryText(text, { allowUnknownCountries = false } = {}) {
  const match = cleanText(text).match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) throw new Error(`Unable to parse Apple table country cell: ${cleanText(text)}`);

  const rawCountry = cleanText(match[1]).replace(FOOTNOTE_SUFFIX_PATTERN, '').trim();
  const currencyLabel = cleanText(match[2]);
  if (!rawCountry) throw new Error(`Apple table country cell is missing a country name: ${cleanText(text)}`);
  const country = COUNTRY_ALIASES[rawCountry] ?? rawCountry;
  if (!allowUnknownCountries && !OFFICIAL_COUNTRIES.has(country)) {
    throw new Error(`Unknown Apple country heading "${rawCountry}"`);
  }
  const currency = /^[A-Z]{3}$/.test(currencyLabel)
    ? currencyLabel
    : CURRENCY_ALIASES[currencyLabel];
  if (!currency) throw new Error(`Unknown currency label "${currencyLabel}" for ${country}`);
  return { country, currency };
}

function rowCells($, row) {
  return $(row).children('th, td').toArray();
}

function potentialPricingHeader($, row) {
  const cells = rowCells($, row);
  if (cells.length < 2) return false;
  return /^country\s*\(currency\)$/i.test(nodeText($, cells[0]));
}

function findHeader($, table) {
  return $(table).find('tr').toArray().find((row) => potentialPricingHeader($, row)) ?? null;
}

function parseTableHeader($, table) {
  const row = findHeader($, table);
  if (!row) return null;
  const cells = rowCells($, row);
  const tiers = cells.slice(1).map((cell) => {
    const label = nodeText($, cell);
    const tier = parseTierLabel(label);
    if (!tier) throw new Error(`Unsupported Apple table storage tier "${label}"`);
    return tier;
  });
  if (!tiers.length) throw new Error('Apple pricing table has no storage tiers');
  const ids = new Set(tiers.map(({ id }) => id));
  if (ids.size !== tiers.length) throw new Error('Apple pricing table has duplicate storage tiers');
  return { row, tiers };
}

function isPotentialPricingTable($, table) {
  return Boolean(findHeader($, table));
}

function assertSimpleTable($, table) {
  if ($(table).find('table').length) throw new Error('Nested Apple pricing tables are unsupported');
  for (const cell of $(table).find('th, td').toArray()) {
    for (const attribute of ['rowspan', 'colspan']) {
      const value = $(cell).attr(attribute);
      if (value !== undefined && value !== '1') {
        throw new Error(`Unsupported Apple pricing cell ${attribute}=${value}`);
      }
    }
  }
}

function parsePricingTable($, table, region, options) {
  assertSimpleTable($, table);
  const header = parseTableHeader($, table);
  if (!header) throw new Error('Apple pricing table header was not found');
  const rows = $(table).find('tr').toArray();
  const headerIndex = rows.indexOf(header.row);
  const countries = [];
  if (rows.slice(0, headerIndex).some((row) => rowCells($, row).length)) {
    throw new Error('Unexpected rows before Apple pricing table header');
  }

  for (const row of rows.slice(headerIndex + 1)) {
    const cells = rowCells($, row);
    if (!cells.length) continue;
    if (potentialPricingHeader($, row)) {
      const repeatedIds = cells.slice(1).map((cell) => parseTierLabel(nodeText($, cell))?.id);
      if (JSON.stringify(repeatedIds) !== JSON.stringify(header.tiers.map(({ id }) => id))) {
        throw new Error('Apple pricing table changes its header inside the table');
      }
      continue;
    }
    const countryText = nodeText($, cells[0]);
    if (!/\([^)]+\)\s*$/.test(countryText)) {
      throw new Error(`Unexpected row in Apple pricing table: ${countryText || '<empty>'}`);
    }
    if (cells.length !== header.tiers.length + 1) {
      throw new Error(`Apple pricing table row for ${countryText} has ${cells.length - 1} prices; expected ${header.tiers.length}`);
    }

    const { country, currency } = parseCountryText(countryText, options);
    const plans = {};
    const detectedTiers = [];
    for (let index = 0; index < header.tiers.length; index += 1) {
      const tier = header.tiers[index];
      const formattedPrice = nodeText($, cells[index + 1]);
      const price = parsePriceNumber(formattedPrice, currency);
      if (!Number.isFinite(price)) {
        throw new Error(`Unable to parse table price "${formattedPrice}" for ${country} ${tier.label}`);
      }
      plans[tier.id] = { price, formattedPrice };
      detectedTiers.push(tier);
    }
    countries.push({ country, region, currency, plans, detectedTiers });
  }

  if (!countries.length) throw new Error(`Apple pricing table for ${region} contains no country rows`);
  return countries;
}


// The marker path decodes a column-oriented rectangular grid, not the row parser's
// header search / row skipping. Only lexical country, tier and price grammar is shared.
function parsePricingColumns($, table, region, options) {
  assertSimpleTable($, table);
  const grid = $(table).find('tr').toArray()
    .map((row) => $(row).children('th, td').toArray().map((cell) => nodeText($, cell)))
    .filter((cells) => cells.length);
  const labels = grid.shift();
  if (!labels || !/^country\s*\(currency\)$/i.test(labels[0])) {
    throw new Error('Apple marker table must start with its pricing header');
  }
  const tiers = labels.slice(1).map(parseTierLabel);
  if (!tiers.length || tiers.some((tier) => !tier) || new Set(tiers.map((tier) => tier.id)).size !== tiers.length) {
    throw new Error('Unsupported or duplicate Apple marker table storage tiers');
  }
  const rows = [];
  for (const cells of grid) {
    if (cells.length !== labels.length) throw new Error('Apple marker table is not rectangular');
    if (/^country\s*\(currency\)$/i.test(cells[0])) {
      if (cells.slice(1).some((label, index) => parseTierLabel(label)?.id !== tiers[index].id)) {
        throw new Error('Apple marker table changes its header inside the table');
      }
    } else {
      rows.push(cells);
    }
  }
  if (!rows.length) throw new Error(`Apple marker pricing table for ${region} contains no country rows`);
  const countries = rows.map(([label]) => ({
    ...parseCountryText(label, options), region, plans: {}, detectedTiers: tiers
  }));
  for (let column = 1; column < labels.length; column += 1) {
    const tier = tiers[column - 1];
    for (let row = 0; row < rows.length; row += 1) {
      const formattedPrice = rows[row][column];
      const country = countries[row];
      const price = parsePriceNumber(formattedPrice, country.currency);
      if (!Number.isFinite(price)) throw new Error(`Unable to parse table price "${formattedPrice}" for ${country.country} ${tier.label}`);
      country.plans[tier.id] = { price, formattedPrice };
    }
  }
  // Keep the public field order identical to the document-order decoder.
  return countries.map(({ country, region: area, currency, plans, detectedTiers }) => ({
    country, region: area, currency, plans, detectedTiers
  }));
}

function resolveRegionByDocumentOrder($, node) {
  const sectionId = $(node).attr('id');
  if (REGIONS[sectionId]) return { sectionId, region: REGIONS[sectionId] };
  const text = nodeText($, node).toLowerCase();
  if (text.includes('north america') && text.includes('caribbean')) return { sectionId: 'nasalac', region: REGIONS.nasalac };
  if (text.includes('europe') && text.includes('middle east') && text.includes('africa')) return { sectionId: 'emea', region: REGIONS.emea };
  if (text.includes('asia pacific')) return { sectionId: 'ap', region: REGIONS.ap };
  return null;
}

function finalize($, countries, foundRegions, seenTables) {
  for (const sectionId of Object.keys(REGIONS)) {
    if (!foundRegions.has(sectionId)) throw new Error(`Apple pricing section #${sectionId} was not found`);
    if (!seenTables.has(sectionId)) throw new Error(`Apple pricing section #${sectionId} has no interpretable pricing table`);
  }
  const sourceNames = new Set();
  const tierMap = new Map();
  for (const country of countries) {
    const name = country.country.normalize('NFKC').toLocaleLowerCase('en-US');
    if (sourceNames.has(name)) throw new Error(`Duplicate Apple table country: ${country.country}`);
    sourceNames.add(name);
    for (const tier of country.detectedTiers) tierMap.set(tier.id, tier);
  }
  const tiers = [...tierMap.values()].sort((a, b) => a.capacityGb - b.capacityGb);
  if (!tiers.length) throw new Error('No storage tiers were found in Apple pricing tables');
  return {
    countries: countries.map(({ detectedTiers, ...country }) => country),
    tiers,
    sourcePublishedDate: extractPublishedDate($)
  };
}

function parseByDocumentOrder($, options) {
  const countries = [];
  const foundRegions = new Set();
  const seenTables = new Set();
  const nodes = $('h2, h3, h4, h5, table').toArray();
  let currentRegion = null;
  let currentSectionId = null;

  for (const node of nodes) {
    if ($(node).is('table')) {
      if (!isPotentialPricingTable($, node)) {
        if (currentRegion) throw new Error(`Unrecognized table inside Apple pricing section #${currentSectionId}`);
        continue;
      }
      if (!currentRegion || !currentSectionId) throw new Error('Apple pricing table was found before a region heading');
      if (seenTables.has(currentSectionId)) throw new Error(`Multiple Apple pricing tables found for #${currentSectionId}`);
      countries.push(...parsePricingTable($, node, currentRegion, options));
      seenTables.add(currentSectionId);
      continue;
    }

    const resolved = resolveRegionByDocumentOrder($, node);
    if (resolved) {
      currentRegion = resolved.region;
      currentSectionId = resolved.sectionId;
      foundRegions.add(resolved.sectionId);
      continue;
    }
    if ($(node).is('h2, h3')) {
      currentRegion = null;
      currentSectionId = null;
    }
  }
  return finalize($, countries, foundRegions, seenTables);
}

function parseByAppleMarkers($, options) {
  const countries = [];
  const foundRegions = new Set();
  const seenTables = new Set();
  const nodes = $('#nasalac, #emea, #ap, h2, h3, table').toArray();
  let currentRegion = null;
  let currentSectionId = null;

  for (const node of nodes) {
    if ($(node).is('table')) {
      if (!isPotentialPricingTable($, node)) {
        if (currentRegion) throw new Error(`Unrecognized table inside Apple marker pricing section #${currentSectionId}`);
        continue;
      }
      if (!currentRegion || !currentSectionId) throw new Error('Apple marker parser found a pricing table before a region marker');
      if (seenTables.has(currentSectionId)) throw new Error(`Multiple Apple marker pricing tables found for #${currentSectionId}`);
      countries.push(...parsePricingColumns($, node, currentRegion, options));
      seenTables.add(currentSectionId);
      continue;
    }
    const sectionId = $(node).attr('id');
    if (!REGIONS[sectionId]) {
      if ($(node).is('h2, h3')) {
        currentRegion = null;
        currentSectionId = null;
      }
      continue;
    }
    currentRegion = REGIONS[sectionId];
    currentSectionId = sectionId;
    foundRegions.add(sectionId);
  }
  return finalize($, countries, foundRegions, seenTables);
}

function comparable(result) {
  return JSON.stringify({
    sourcePublishedDate: result.sourcePublishedDate,
    tiers: result.tiers,
    countries: result.countries
  });
}

export function parseApplePriceTables($, options = {}) {
  const potentialTables = $('table').toArray().filter((table) => isPotentialPricingTable($, table));
  if (!potentialTables.length) return null;

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
    if (comparable(documentOrderResult) !== comparable(appleMarkerResult)) {
      throw new Error('Apple table parser disagreement: document-order and marker paths returned different pricing data');
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
      parserStatus: `Apple table marker parser unavailable: ${appleMarkerError?.message ?? 'unknown error'}`
    };
  }
  if (appleMarkerResult) {
    return {
      ...appleMarkerResult,
      parser: 'apple-markers-fallback',
      parserStatus: `Document-order table parser unavailable: ${documentOrderError?.message ?? 'unknown error'}`
    };
  }
  throw new Error(`Both Apple table parsers failed; document-order: ${documentOrderError?.message}; apple-markers: ${appleMarkerError?.message}`);
}
