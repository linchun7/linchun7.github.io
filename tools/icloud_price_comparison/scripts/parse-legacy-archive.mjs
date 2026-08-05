import * as cheerio from 'cheerio';

const REGIONS = {
  nasalac: 'Americas',
  emea: 'Europe, Middle East & Africa',
  ap: 'Asia Pacific'
};

const CURRENCY_ALIASES = { Euro: 'EUR' };
const COUNTRY_ALIASES = { Euro: 'Euro Zone' };
const PRICE_CURRENCY_MARKERS = new Set([
  '$', '€', '£', '¥', '₪', '₩', '₸', '₦', '₱', '฿', '₫', '﷼',
  'AED', 'CHF', 'Euro', 'HK$', 'R$', 'RM', 'Rp', 'Rs', 'S$', 'S/.', 'NT$', 'TSh', 'TL', 'Ft', 'Kč', 'kr', 'lei', 'p.', 'zł', 'R'
]);

function cleanText(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTier(value) {
  const match = cleanText(value).match(/^(\d+(?:\.\d+)?)\s*(GB|TB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  const capacityGb = amount * (unit === 'TB' ? 1024 : 1);
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isFinite(capacityGb) || capacityGb <= 0) return null;
  return {
    id: `${amount}${unit}`,
    label: `${amount} ${unit}`,
    capacityGb
  };
}

function isCurrencyDecoration(value) {
  const normalized = cleanText(value).replace(/\s+/g, '');
  if (!normalized) return true;
  return PRICE_CURRENCY_MARKERS.has(normalized)
    || /^[A-Z]{3}$/.test(normalized);
}

function parseNumericToken(token) {
  const normalized = token
    .replace(/[\u00a0\u202f]/g, ' ')
    .replace(/’/g, "'")
    .trim();
  const groupedInteger = /[1-9]\d{0,2}(?:[.,' ]\d{3})+/;
  const decimal = new RegExp('^(?:' + groupedInteger.source + '|\\d+)[.,]\\d{1,2}$');
  const grouped = new RegExp('^' + groupedInteger.source + '$');
  const plain = /^\d+$/;
  if (!decimal.test(normalized) && !grouped.test(normalized) && !plain.test(normalized)) return Number.NaN;
  if (decimal.test(normalized)) {
    const decimalIndex = Math.max(normalized.lastIndexOf(','), normalized.lastIndexOf('.'));
    if (normalized.slice(0, decimalIndex).includes(normalized[decimalIndex])) return Number.NaN;
    const integerPart = normalized.slice(0, decimalIndex).replace(/[.,' ]/g, '');
    const fractionPart = normalized.slice(decimalIndex + 1);
    return Number(integerPart + '.' + fractionPart);
  }
  return Number(normalized.replace(/[.,' ]/g, ''));
}

function parsePrice(value) {
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
  if (!isCurrencyDecoration(prefix) || !isCurrencyDecoration(suffix)) return Number.NaN;
  return parseNumericToken(token);
}

function parseCountryLabel($, node) {
  const clone = $(node).clone();
  clone.find('sup').remove();
  const match = cleanText(clone.text()).match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;
  const country = COUNTRY_ALIASES[match[1]] ?? match[1];
  const currency = /^[A-Z]{3}$/.test(match[2]) ? match[2] : CURRENCY_ALIASES[match[2]];
  if (!currency) return null;
  return { country, currency };
}

function parsePriceParagraph($, node) {
  const labelNode = $(node).find('b, strong').first();
  if (!labelNode.length) return null;
  const rawLabel = cleanText(labelNode.text());
  const tier = parseTier(rawLabel.replace(/:\s*$/, ''));
  if (!tier) return null;
  const text = cleanText($(node).text());
  const formattedPrice = cleanText(text.slice(rawLabel.length)).replace(/^:\s*/, '');
  const price = parsePrice(formattedPrice);
  if (!Number.isFinite(price)) throw new Error(`Unable to parse archived price: ${text}`);
  return { tier, value: { price, formattedPrice } };
}

function extractPublishedDate($) {
  const label = $('span').filter((_, node) => /Published Date:/i.test($(node).text())).first();
  const containerText = cleanText(label.parent().text());
  const match = containerText.match(/Published Date:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!match) throw new Error('Archived Apple published date was not found');
  return match[1];
}

function finalize(countries, tiers, sourcePublishedDate) {
  if (countries.length < 60) throw new Error(`Only ${countries.length} archived countries were parsed`);
  if (tiers.size < 3) throw new Error('Archived storage tiers are incomplete');
  const capacities = new Map();
  for (const tier of tiers.values()) {
    if (!Number.isFinite(tier.capacityGb) || tier.capacityGb <= 0) {
      throw new Error(`Invalid archived storage capacity: ${tier.label}`);
    }
    const existing = capacities.get(tier.capacityGb);
    if (existing && existing.id !== tier.id) {
      throw new Error(`Duplicate archived storage capacity ${tier.capacityGb} GB`);
    }
    capacities.set(tier.capacityGb, tier);
  }
  const parsedRegions = new Set(countries.map(({ region }) => region));
  const missingRegions = Object.values(REGIONS).filter((region) => !parsedRegions.has(region));
  if (missingRegions.length) {
    throw new Error(`Archived Apple regions are incomplete: ${missingRegions.join(', ')}`);
  }
  return {
    countries,
    tiers: [...tiers.values()].sort((a, b) => a.capacityGb - b.capacityGb),
    sourcePublishedDate
  };
}

function parseByFlatDocumentOrder($) {
  const nodes = $('#sections').children().toArray();
  const countries = [];
  const tiers = new Map();
  let region = null;
  let current = null;
  for (const node of nodes) {
    const id = $(node).attr('id');
    if (REGIONS[id]) {
      region = REGIONS[id];
      current = null;
      continue;
    }
    if (!region || !$(node).is('p')) continue;
    const country = parseCountryLabel($, node);
    if (country) {
      current = { ...country, region, plans: {} };
      countries.push(current);
      continue;
    }
    const plan = parsePriceParagraph($, node);
    if (current && plan) {
      if (current.plans[plan.tier.id]) throw new Error(`Duplicate archived tier ${plan.tier.id} for ${current.country}`);
      current.plans[plan.tier.id] = plan.value;
      tiers.set(plan.tier.id, plan.tier);
    }
  }
  return finalize(countries, tiers, extractPublishedDate($));
}

function parseByRegionMarkers($) {
  const countries = [];
  const tiers = new Map();
  for (const [id, region] of Object.entries(REGIONS)) {
    let node = $(`#${id}`).first().next();
    let current = null;
    while (node.length && !REGIONS[node.attr('id')]) {
      if (node.is('p')) {
        const country = parseCountryLabel($, node[0]);
        if (country) {
          current = { ...country, region, plans: {} };
          countries.push(current);
        } else {
          const plan = parsePriceParagraph($, node[0]);
          if (current && plan) {
            if (current.plans[plan.tier.id]) throw new Error(`Duplicate archived tier ${plan.tier.id} for ${current.country}`);
            current.plans[plan.tier.id] = plan.value;
            tiers.set(plan.tier.id, plan.tier);
          }
        }
      }
      node = node.next();
    }
  }
  return finalize(countries, tiers, extractPublishedDate($));
}

function comparable(value) {
  return JSON.stringify(value);
}

export function parseLegacyAppleArchive(html) {
  const $ = cheerio.load(html);
  const flatDocumentResult = parseByFlatDocumentOrder($);
  const regionMarkerResult = parseByRegionMarkers($);
  if (comparable(flatDocumentResult) !== comparable(regionMarkerResult)) {
    throw new Error('Legacy Apple archive parsers returned different pricing data');
  }
  return {
    ...flatDocumentResult,
    parser: 'legacy-archive-cross-checked',
    parserStatus: 'Both independent legacy archive parser paths agreed'
  };
}