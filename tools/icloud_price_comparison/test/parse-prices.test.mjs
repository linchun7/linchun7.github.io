import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  getMissingExchangeRates,
  parseApplePrices,
  validatePriceChangeAnomalies,
  validatePrices
} from '../scripts/parse-prices.mjs';

const fixtureUrl = new URL('./fixtures/apple-prices.html', import.meta.url);

test('parses footnotes, currencies, and all storage tiers', async () => {
  const result = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  assert.equal(result.parser, 'cross-checked');
  assert.match(result.parserStatus, /Both independent parser paths agreed/);
  assert.equal(result.countries.length, 5);
  assert.equal(result.sourcePublishedDate, 'July 17, 2026');
  assert.equal(result.countries[0].country, 'United States');
  assert.equal(result.countries[0].plans['200GB'].price, 2.99);
  assert.equal(result.countries[2].currency, 'EUR');
  assert.equal(result.countries[3].country, 'Euro Zone');
  assert.equal(result.countries[4].plans['200GB'].formattedPrice, 'HK$ 23');
  assert.equal(validatePrices(result.countries, { minCountries: 5 }), true);
});

test('discovers a newly published storage tier from Apple markup', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const expanded = parseApplePrices(fixture.replaceAll('</ul>', '<li>1 TB: $5.99</li></ul>'));
  assert.ok(expanded.tiers.some(({ id, label }) => id === '1TB' && label === '1 TB'));
  assert.equal(expanded.countries[0].plans['1TB'].price, 5.99);
  assert.equal(validatePrices(expanded.countries, { minCountries: 5, tiers: expanded.tiers }), true);
});

test('tolerates small heading, wrapper, and publication-date markup changes', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture
    .replace('<h3 id="nasalac">Americas</h3>', '<h2>North America and the Caribbean</h2>')
    .replace('<h3 id="emea">Europe</h3>', '<h2>Europe, the Middle East, and Africa</h2>')
    .replace('<ul><li><b>50 GB</b>: $0.99</li>', '<h5>Monthly plans</h5><ul><li>Taxes may apply</li></ul><section><ul><li><b>50 GB</b>: $0.99</li>')
    .replace('</li></ul>\n    <h3 id="emea">', '</li></ul></section>\n    <h3 id="emea">')
    .replace('<time>July 17, 2026</time>', 'July 17, 2026');
  const result = parseApplePrices(adjusted);
  assert.equal(result.countries.length, 5);
  assert.equal(result.sourcePublishedDate, 'July 17, 2026');
  assert.equal(validatePrices(result.countries, { minCountries: 5, tiers: result.tiers }), true);
});

test('falls back to the Apple marker parser when semantic region headings change', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture
    .replace('<h3 id="nasalac">Americas</h3>', '<div id="nasalac">Americas</div>')
    .replace('<h3 id="emea">Europe</h3>', '<div id="emea">Europe</div>')
    .replace('<h3 id="ap">Asia Pacific</h3>', '<div id="ap">Asia Pacific</div>');
  const result = parseApplePrices(adjusted);
  assert.equal(result.parser, 'apple-markers-fallback');
  assert.match(result.parserStatus, /Document-order parser unavailable/);
  assert.equal(result.countries.length, 5);
});

test('keeps the document-order parser when Apple marker classes disappear', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const result = parseApplePrices(fixture.replaceAll(' class="gb-header"', ''));
  assert.equal(result.parser, 'document-order');
  assert.match(result.parserStatus, /Apple marker parser unavailable/);
  assert.equal(result.countries.length, 5);
});

test('does not mistake an unrelated time element for the Apple publication date', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace(
    '<p>Published Date: <time>July 17, 2026</time></p>',
    '<p>Last reviewed: <time>July 16, 2026</time></p>'
  );
  assert.equal(parseApplePrices(adjusted).sourcePublishedDate, null);
});

test('rejects incomplete pricing data', () => {
  assert.throws(
    () => validatePrices([{ country: 'Example', currency: 'USD', plans: {} }], { minCountries: 1 }),
    /Invalid 50GB price/
  );
});

test('rejects implausible changes against the last valid snapshot', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  const changed = structuredClone(parsed.countries);
  changed[0].plans['200GB'].price *= 11;

  assert.throws(
    () => validatePrices(changed, { minCountries: 5, previousCountries: parsed.countries }),
    /Suspicious 200GB price change/
  );
});

test('rejects a change only when local and exchange-rate-isolated thresholds all agree', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  const previousData = {
    countries: parsed.countries,
    fx: { rates: { USD: 1, GBP: 0.8, EUR: 0.9, HKD: 7.8, CNY: 7 } }
  };
  const changed = structuredClone(parsed.countries);
  changed[0].plans['200GB'].price = 9.99;

  assert.throws(
    () => validatePriceChangeAnomalies(changed, {
      previousData,
      currentRates: previousData.fx.rates,
      tiers: parsed.tiers
    }),
    /Suspicious combined 200GB price change/
  );

  const moderate = structuredClone(parsed.countries);
  moderate[0].plans['200GB'].price = 7.99;
  assert.equal(validatePriceChangeAnomalies(moderate, {
    previousData,
    currentRates: previousData.fx.rates,
    tiers: parsed.tiers
  }), true);

  const lowCnyPrevious = {
    countries: [{ country: 'Example', currency: 'JPY', plans: { '50GB': { price: 100 } } }],
    fx: { rates: { JPY: 150, CNY: 7 } }
  };
  const lowCnyCurrent = [{ country: 'Example', currency: 'JPY', plans: { '50GB': { price: 200 } } }];
  assert.equal(validatePriceChangeAnomalies(lowCnyCurrent, {
    previousData: lowCnyPrevious,
    currentRates: lowCnyPrevious.fx.rates,
    tiers: [{ id: '50GB' }]
  }), true);
});

test('does not flag an Apple repricing that offsets a large currency move', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const repriced = [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 30 } } }];

  assert.equal(validatePriceChangeAnomalies(repriced, {
    previousData,
    currentRates: { XYZ: 3, CNY: 7 },
    tiers: [{ id: '50GB' }]
  }), true);
});

test('allows a rounded currency-driven repricing whose real value stays close', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '12TB': { price: 100 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const repriced = [{ country: 'Example', currency: 'XYZ', plans: { '12TB': { price: 300 } } }];

  assert.equal(validatePriceChangeAnomalies(repriced, {
    previousData,
    currentRates: { XYZ: 2.5, CNY: 7 },
    tiers: [{ id: '12TB' }]
  }), true);
});

test('does not treat a large exchange-rate move without an Apple price change as an anomaly', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const unchanged = [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }];

  assert.equal(validatePriceChangeAnomalies(unchanged, {
    previousData,
    currentRates: { XYZ: 100, CNY: 7 },
    tiers: [{ id: '50GB' }]
  }), true);
});

test('scales the CNY threshold with the previous plan value', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '12TB': { price: 100 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const changed = [{ country: 'Example', currency: 'XYZ', plans: { '12TB': { price: 120 } } }];

  assert.equal(validatePriceChangeAnomalies(changed, {
    previousData,
    currentRates: previousData.fx.rates,
    tiers: [{ id: '12TB' }],
    thresholds: {
      percentage: 0.01,
      localRelative: 0,
      localMinimum: 0,
      cnyMinimum: 15,
      cnyRelative: 0.5,
      marketRelative: 0.5
    }
  }), true);
});

test('still rejects a very large price move when exchange rates do not explain it', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const repriced = [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 35 } } }];

  assert.throws(
    () => validatePriceChangeAnomalies(repriced, {
      previousData,
      currentRates: previousData.fx.rates,
      tiers: [{ id: '50GB' }]
    }),
    /fixed-rate CNY 175.00\/35.00, market-adjusted CNY 175.00\/35.00/
  );
});

test('accepts a newly added country with complete pricing', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  const expanded = structuredClone(parsed.countries);
  expanded.push({
    ...structuredClone(parsed.countries[0]),
    country: 'New Market'
  });

  assert.equal(validatePrices(expanded, {
    minCountries: 5,
    previousCountries: parsed.countries
  }), true);
});

test('rejects duplicate countries and an excessive country-count drop', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  const duplicate = [...parsed.countries, structuredClone(parsed.countries[0])];
  assert.throws(
    () => validatePrices(duplicate, { minCountries: 5 }),
    /Duplicate country entry/
  );

  assert.throws(
    () => validatePrices(parsed.countries.slice(0, 1), {
      minCountries: 1,
      previousCountries: parsed.countries
    }),
    /Country count dropped/
  );
});

test('reports currencies without a usable exchange rate', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  assert.deepEqual(
    getMissingExchangeRates(parsed.countries, { USD: 1, GBP: 0.8, EUR: 0.9, HKD: 0 }),
    ['HKD']
  );
  assert.deepEqual(
    getMissingExchangeRates(parsed.countries, { USD: 1, GBP: 0.8, EUR: 0.9, HKD: 7.8 }),
    []
  );
});
