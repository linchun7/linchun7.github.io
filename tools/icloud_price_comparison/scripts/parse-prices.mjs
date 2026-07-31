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
  const publishedTime = $('time').toArray().reverse().find((node) => (
    /published\s+date/i.test(cleanText($(node).parent().text()))
  ));
  if (publishedTime) {
    return cleanText($(publishedTime).text()) || cleanText($(publishedTime).attr('datetime') ?? '');
  }

  const pageText = cleanText($.root().text());
  const textMatch = pageText.match(/published\s+date\s*:?\s*([A-Za-z]+\s+\d{1,2},\s*\d{4})/i);
  if (textMatch) return cleanText(textMatch[1]);

  const lastTime = $('time').last();
  return cleanText(lastTime.text()) || cleanText(lastTime.attr('datetime') ?? '') || null;
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

  return { country: cleanText(country), region, currency, plans, detectedTiers: [...detectedTiers.values()] };
}

export function parseApplePrices(html) {
  const $ = cheerio.load(html);
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

  const countries = parsedCountries.map(({ detectedTiers, ...country }) => ({ ...country, plans: country.plans }));

  return {
    countries,
    tiers,
    sourcePublishedDate: extractPublishedDate($)
  };
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
