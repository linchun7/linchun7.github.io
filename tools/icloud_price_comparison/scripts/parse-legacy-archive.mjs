import * as cheerio from 'cheerio';

const REGIONS = {
  nasalac: 'Americas',
  emea: 'Europe, Middle East & Africa',
  ap: 'Asia Pacific'
};

const CURRENCY_ALIASES = { Euro: 'EUR' };
const COUNTRY_ALIASES = { Euro: 'Euro Zone' };

function cleanText(value) {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseTier(value) {
  const match = cleanText(value).match(/^(\d+(?:\.\d+)?)\s*(GB|TB)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toUpperCase();
  return {
    id: `${amount}${unit}`,
    label: `${amount} ${unit}`,
    capacityGb: amount * (unit === 'TB' ? 1024 : 1)
  };
}

function parsePrice(value) {
  const match = value.match(/[0-9][0-9.,\s']*/);
  if (!match) return Number.NaN;
  const compact = match[0].replace(/[\s']/g, '');
  const comma = compact.lastIndexOf(',');
  const dot = compact.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const grouping = decimal === ',' ? '.' : ',';
    return Number(compact.replaceAll(grouping, '').replace(decimal, '.'));
  }
  if (comma >= 0) {
    const groups = compact.split(',');
    return Number(groups.length === 2 && groups[1].length <= 2 ? groups.join('.') : groups.join(''));
  }
  return Number(compact);
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
  const first = parseByFlatDocumentOrder($);
  const second = parseByRegionMarkers($);
  if (comparable(first) !== comparable(second)) {
    throw new Error('Legacy Apple archive parsers returned different pricing data');
  }
  return {
    ...first,
    parser: 'legacy-archive-cross-checked',
    parserStatus: 'Both independent legacy archive parser paths agreed'
  };
}
