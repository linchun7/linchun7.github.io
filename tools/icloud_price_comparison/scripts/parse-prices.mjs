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

function cleanText(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
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
  const match = value.match(/[0-9][0-9.,\s]*/);
  if (!match) return Number.NaN;
  return Number(match[0].replace(/[\s,]/g, ''));
}

function tierIdFromLabel(label) {
  const normalized = label.toUpperCase().replace(/\s+/g, '');
  return TIERS.find((tier) => tier.id === normalized)?.id;
}

function parseCountry($, heading, priceList, region) {
  const title = headingText($, heading);
  const titleMatch = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);

  if (!titleMatch) throw new Error(`Unable to parse country heading: ${title}`);

  const [, countryLabel, currencyLabel] = titleMatch;
  const country = COUNTRY_ALIASES[countryLabel] ?? countryLabel;
  const currency = /^[A-Z]{3}$/.test(currencyLabel)
    ? currencyLabel
    : CURRENCY_ALIASES[currencyLabel];
  if (!currency) throw new Error(`Unknown currency label "${currencyLabel}" for ${country}`);
  const $prices = $(priceList);

  const plans = {};
  $prices.find('li').each((_, item) => {
    const text = cleanText($(item).text());
    const match = text.match(/^((?:50|200)\s*GB|(?:2|6|12)\s*TB)\s*:?\s*(.+)$/i);
    if (!match) return;

    const tierId = tierIdFromLabel(match[1]);
    const formattedPrice = cleanText(match[2]).replace(/^:\s*/, '');
    const price = parsePriceNumber(formattedPrice);
    if (!tierId || !Number.isFinite(price)) {
      throw new Error(`Unable to parse price "${text}" for ${country}`);
    }
    plans[tierId] = { price, formattedPrice };
  });

  return { country: cleanText(country), region, currency, plans };
}

export function parseApplePrices(html) {
  const $ = cheerio.load(html);
  const countries = [];
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
      if ($(candidate).is('h2, h3, h4, h5')) break;
      if ($(candidate).is('ul')) {
        priceList = candidate;
        break;
      }
    }
    if (!priceList) throw new Error(`Price list not found after ${headingText($, node)}`);
    countries.push(parseCountry($, node, priceList, currentRegion));
  }

  for (const sectionId of Object.keys(REGIONS)) {
    if (!foundRegions.has(sectionId)) {
      throw new Error(`Apple pricing section #${sectionId} was not found`);
    }
  }

  return {
    countries,
    sourcePublishedDate: cleanText($('time').last().text()) || null
  };
}

export function validatePrices(countries, { minCountries = 60, previousCountries = [] } = {}) {
  if (countries.length < minCountries) {
    throw new Error(`Only ${countries.length} countries were parsed; expected at least ${minCountries}`);
  }

  const seen = new Set();
  for (const entry of countries) {
    const key = entry.country;
    if (seen.has(key)) throw new Error(`Duplicate country entry: ${key}`);
    seen.add(key);

    for (const tier of TIERS) {
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
    for (const tier of TIERS) {
      const ratio = entry.plans[tier.id].price / previous.plans[tier.id].price;
      if (ratio < 0.2 || ratio > 5) {
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
