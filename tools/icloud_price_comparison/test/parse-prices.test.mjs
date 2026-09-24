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
const priceHistoryFixtureUrl = new URL('./fixtures/global-price-adjustments.json', import.meta.url);

function testTier(id) {
  const match = id.match(/^(\d+(?:\.\d+)?)(GB|TB)$/);
  const amount = Number(match?.[1]);
  const unit = match?.[2];
  return {
    id,
    label: `${amount} ${unit}`,
    capacityGb: amount * (unit === 'TB' ? 1024 : 1)
  };
}

function testCountry(plans, overrides = {}) {
  return {
    country: 'Example',
    region: 'Americas',
    currency: 'USD',
    plans,
    ...overrides
  };
}

test('parses footnotes, currencies, and all storage tiers', async () => {
  const result = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  assert.equal(result.parser, 'cross-checked');
  assert.match(result.parserStatus, /Both DOM association paths agreed/);
  assert.equal(result.countries.length, 5);
  assert.equal(result.sourcePublishedDate, 'July 17, 2026');
  assert.equal(result.countries[0].country, 'United States');
  assert.equal(result.countries[0].plans['200GB'].price, 2.99);
  assert.equal(result.countries[2].currency, 'EUR');
  assert.equal(result.countries[3].country, 'Euro Zone');
  assert.equal(result.countries[4].plans['200GB'].formattedPrice, 'HK$ 23');
  assert.equal(validatePrices(result.countries, { minCountries: 5 }), true);
});

test('parses decimal commas and common thousands separators without changing scale', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const cases = [
    { markup: '$2,99', expected: 2.99 },
    { markup: '$1,234.56', expected: 1234.56 },
    { markup: '$1.234,56', expected: 1234.56 },
    { markup: '$1,234', expected: 1234 },
    { markup: '$1.234', expected: 1234 },
    { markup: "$1'234.56", expected: 1234.56 },
    { markup: '$1’234,56', expected: 1234.56 }
  ];

  for (const { markup, expected } of cases) {
    const adjusted = fixture.replace('$2.99', markup);
    const parsed = parseApplePrices(adjusted);
    assert.equal(parsed.parser, 'cross-checked');
    assert.equal(parsed.countries[0].plans['200GB'].price, expected, markup);
  }
});

test('rejects mismatched currency symbols and codes', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  for (const markup of ['€0.99', '0.99 €', 'EUR 0.99', '0.99 EUR']) {
    assert.throws(
      () => parseApplePrices(fixture.replace('$0.99', markup)),
      /Unable to parse price|Apple parser disagreement|Both Apple parsers failed/,
      markup
    );
  }
});

test('accepts matching currency codes in either price position', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  for (const markup of ['USD 0.99', '0.99 USD']) {
    const parsed = parseApplePrices(fixture.replace('$0.99', markup));
    assert.equal(parsed.countries[0].plans['50GB'].price, 0.99, markup);
  }
});

test('strips price-item footnotes and rejects malformed full price tokens', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const footnoted = parseApplePrices(fixture.replace('$0.99', '$0.99<sup>1</sup>'));
  assert.equal(footnoted.countries[0].plans['50GB'].price, 0.99);

  for (const markup of ['$1e3', '$12abc', '$12 July 17, 2026', '($0.99)', '$1,2,3', '$1,234,56', '$1.2.3', '$0.999', '$.99']) {
    assert.throws(
      () => parseApplePrices(fixture.replace('$0.99', markup)),
      /Unable to parse price|Apple parser disagreement|Both Apple parsers failed/,
      markup
    );
  }
});

test('discovers a newly published storage tier from Apple markup', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const expanded = parseApplePrices(fixture.replaceAll('</ul>', '<li>1 TB: 5.99</li></ul>'));
  assert.ok(expanded.tiers.some(({ id, label }) => id === '1TB' && label === '1 TB'));
  assert.equal(expanded.countries[0].plans['1TB'].price, 5.99);
  assert.equal(validatePrices(expanded.countries, { minCountries: 5, tiers: expanded.tiers }), true);
});

test('rejects a full-price pseudo-country heading', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace(
    '<h4 class="gb-header">United States<sup>4</sup> (USD)</h4>',
    '<h4 class="gb-header">Monthly examples (USD)</h4><ul>'
      + '<li>50 GB: $0.99</li><li>200 GB: $2.99</li><li>2 TB: $9.99</li>'
      + '<li>6 TB: $29.99</li><li>12 TB: $59.99</li></ul>'
  );
  assert.throws(() => parseApplePrices(adjusted), /Unknown Apple country heading/);
});

test('rejects ambiguous full-tier decoy lists before a country price list', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const decoy = '<ul><li><b>50 GB</b>: $1.99</li><li><b>200 GB</b>: $5.99</li>'
    + '<li><b>2 TB</b>: $19.99</li><li><b>6 TB</b>: $59.99</li><li><b>12 TB</b>: $119.99</li></ul>';
  const adjusted = fixture.replace(
    '<h4 class="gb-header">United States<sup>4</sup> (USD)</h4>',
    '<h4 class="gb-header">United States<sup>4</sup> (USD)</h4>' + decoy
  );

  assert.throws(
    () => parseApplePrices(adjusted),
    /Ambiguous .*price lists/
  );
});

test('rejects equivalent storage capacities even when tier labels differ', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replaceAll(
    '<li><b>2 TB</b>',
    '<li><b>2048 GB</b>: 1</li><li><b>2 TB</b>'
  );

  assert.throws(
    () => parseApplePrices(adjusted),
    /Duplicate storage capacity/
  );
});

test('rejects zero and non-finite storage capacities', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const zero = fixture.replaceAll(
    '<li><b>12 TB</b>',
    '<li><b>0 GB</b>: 1</li><li><b>12 TB</b>'
  );
  const hugeLabel = `${'9'.repeat(400)} TB`;
  const huge = fixture.replaceAll(
    '<li><b>12 TB</b>',
    `<li><b>${hugeLabel}</b>: 1</li><li><b>12 TB</b>`
  );

  assert.throws(() => parseApplePrices(zero), /Unable to parse price/);
  assert.throws(() => parseApplePrices(huge), /Unable to parse price/);
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

test('parses the Apple plain-text Published Date label exactly as rendered', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const plainTextDate = fixture.replace(
    '<p>Published Date: <time>July 17, 2026</time></p>',
    '<p>Published Date: July 17, 2026</p>'
  );
  const result = parseApplePrices(plainTextDate);
  assert.equal(result.parser, 'cross-checked');
  assert.equal(result.sourcePublishedDate, 'July 17, 2026');
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

test('cross-checks country markers when their element changes but gb-header remains', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace(
    /<h4 class="gb-header">United States[\s\S]*?<\/h4>/,
    (heading) => heading.replace('<h4', '<div').replace('</h4>', '</div>')
  );
  const result = parseApplePrices(adjusted);
  assert.equal(result.parser, 'cross-checked');
  assert.equal(result.countries.length, 5);
  assert.equal(result.countries[0].country, 'United States');
});

test('keeps the document-order parser when Apple marker classes disappear', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const result = parseApplePrices(fixture.replaceAll(' class="gb-header"', ''));
  assert.equal(result.parser, 'document-order');
  assert.match(result.parserStatus, /Apple marker parser unavailable/);
  assert.equal(result.countries.length, 5);
});

test('rejects a storage-looking tier that uses an unsupported capacity unit', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace('<b>50 GB</b>', '<b>50 PB</b>');
  assert.throws(
    () => parseApplePrices(adjusted),
    /Unsupported storage tier/
  );
});

test('rejects disagreement when both independent parsers return different countries', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace(
    '    <h3 id="emea">Europe</h3>',
    '    <h5>Canada (USD)</h5>\n    <ul><li>50 GB: $0.99</li><li>200 GB: $2.99</li><li>2 TB: $9.99</li><li>6 TB: $29.99</li><li>12 TB: $59.99</li></ul>\n    <h3 id="emea">Europe</h3>'
  );
  assert.throws(
    () => parseApplePrices(adjusted),
    /Apple parser disagreement/
  );
});

test('rejects input when both independent parsers fail', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture
    .replace(' id="nasalac"', '')
    .replace(' id="emea"', '')
    .replace(' id="ap"', '')
    .replaceAll('<h3>Americas</h3>', '<div>Americas</div>')
    .replaceAll('<h3>Europe</h3>', '<div>Europe</div>')
    .replaceAll('<h3>Asia Pacific</h3>', '<div>Asia Pacific</div>');
  assert.throws(
    () => parseApplePrices(adjusted),
    /Both Apple parsers failed/
  );
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
    () => validatePrices([testCountry({})], { minCountries: 1 }),
    /Invalid 50GB price/
  );
});

test('rejects zero, negative, non-finite, and duplicate Apple prices', () => {
  const tiers = [testTier('50GB')];
  for (const price of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validatePrices([testCountry({ '50GB': { price } })], { minCountries: 1, tiers }),
      /Invalid 50GB price/
    );
  }
  const valid = testCountry({ '50GB': { price: 1 } });
  assert.throws(
    () => validatePrices([valid, structuredClone(valid)], { minCountries: 1, tiers }),
    /Duplicate country entry/
  );
});

test('rejects extra plans, non-canonical tier order, and oversized parsed collections', () => {
  const tiers = [testTier('50GB'), testTier('200GB')];
  const valid = testCountry({ '50GB': { price: 1 }, '200GB': { price: 2 } });
  const extraPlan = structuredClone(valid);
  extraPlan.plans.EXTRA = { price: 3 };
  assert.throws(
    () => validatePrices([extraPlan], { minCountries: 1, tiers }),
    /plans do not exactly match tiers/
  );
  assert.throws(
    () => validatePrices([valid], { minCountries: 1, tiers: [...tiers].reverse() }),
    /invalid or duplicate tiers/
  );
  assert.throws(
    () => validatePrices([valid], {
      minCountries: 1,
      tiers: Array.from({ length: 21 }, () => structuredClone(tiers[0]))
    }),
    /unsupported structure/
  );
  assert.throws(
    () => validatePrices(Array.from({ length: 251 }, () => structuredClone(valid)), { minCountries: 1, tiers }),
    /Too many countries/
  );
});

test('rejects unsafe country names before they reach mapping or history objects', () => {
  for (const unsafeName of ['__proto__', 'constructor', 'Alpha\u202e']) {
    assert.throws(
      () => validatePrices([
        testCountry({ '50GB': { price: 1 } }, { country: unsafeName })
      ], { minCountries: 1, tiers: [testTier('50GB')] }),
      /invalid country, region, currency, or plans entry/
    );
  }
});

test('rejects negative prices in Apple markup instead of stripping the sign', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace('$0.99', '-$0.99');
  assert.throws(() => parseApplePrices(adjusted), /Unable to parse price|Apple parser disagreement/);
});

test('rejects a large downward price change', () => {
  const tiers = [testTier('50GB')];
  const previousCountries = [testCountry({ '50GB': { price: 100 } })];
  const currentCountries = [testCountry({ '50GB': { price: 20 } })];
  assert.throws(
    () => validatePriceChangeAnomalies(currentCountries, {
      previousData: { countries: previousCountries, fx: { rates: { USD: 1, CNY: 7 } } },
      currentRates: { USD: 1, CNY: 7 },
      tiers,
      thresholds: { percentage: 0.5, localRelative: 0, localMinimum: 0, cnyMinimum: 0, cnyRelative: 0, marketRelative: 0 }
    }),
    /Suspicious combined 50GB price change/
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

test('rejects missing previous countries instead of applying a count tolerance', () => {
  const tiers = [testTier('50GB')];
  const previousCountries = [
    testCountry({ '50GB': { price: 10 } }, { country: 'Bahamas' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Albania' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Australia' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Example Two' })
  ];
  const currentCountries = previousCountries.slice(0, 1);
  assert.throws(
    () => validatePrices(currentCountries, { minCountries: 1, previousCountries, tiers }),
    /Previously published countries are missing/
  );
});

test('prefers a complete time datetime value over abbreviated visible text', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace(
    '<p>Published Date: <time>July 17, 2026</time></p>',
    '<p>Published Date: <time datetime="2026-07-17">Jul 17</time></p>'
  );
  assert.equal(parseApplePrices(adjusted).sourcePublishedDate, '2026-07-17');
});

test('allows a newly published Apple country only through the explicit confirmation mode', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace('United States<sup>4</sup> (USD)', 'New Market<sup>4</sup> (USD)');
  assert.throws(() => parseApplePrices(adjusted), /Unknown Apple country heading|Both Apple parsers failed/);
  const parsed = parseApplePrices(adjusted, { allowUnknownCountries: true });
  assert.equal(parsed.parser, 'cross-checked');
  assert.equal(parsed.countries[0].country, 'New Market');
});

test('rejects non-canonical or implausibly large storage tier identifiers', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replaceAll('50 GB', '1000000000000000000000 GB');
  assert.throws(() => parseApplePrices(adjusted), /Both Apple parsers failed/);
});

test('accepts any exact set of independently confirmed country removals', () => {
  const tiers = [testTier('50GB')];
  const previousCountries = [
    testCountry({ '50GB': { price: 10 } }, { country: 'Bahamas' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Albania' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Australia' }),
    testCountry({ '50GB': { price: 10 } }, { country: 'Example Two' })
  ];
  const currentCountries = previousCountries.slice(0, 1);
  assert.equal(validatePrices(currentCountries, {
    minCountries: 1,
    previousCountries,
    confirmedRemovedCountries: previousCountries.slice(1).map(({ country }) => country),
    tiers
  }), true);
  assert.throws(() => validatePrices(currentCountries, {
    minCountries: 1,
    previousCountries,
    confirmedRemovedCountries: ['Albania'],
    tiers
  }), /missing without exact confirmation/);
});

test('allows exact tenfold hard-limit boundaries but rejects either side', () => {
  const tiers = [testTier('50GB')];
  const previousCountries = [testCountry({ '50GB': { price: 10 } })];
  const atLowerBoundary = [testCountry({ '50GB': { price: 1 } })];
  const atUpperBoundary = [testCountry({ '50GB': { price: 100 } })];
  assert.equal(validatePrices(atLowerBoundary, { minCountries: 1, previousCountries, tiers }), true);
  assert.equal(validatePrices(atUpperBoundary, { minCountries: 1, previousCountries, tiers }), true);
  assert.throws(
    () => validatePrices([{ ...atLowerBoundary[0], plans: { '50GB': { price: 0.99 } } }], { minCountries: 1, previousCountries, tiers }),
    /Suspicious 50GB price change/
  );
  assert.throws(
    () => validatePrices([{ ...atUpperBoundary[0], plans: { '50GB': { price: 100.1 } } }], { minCountries: 1, previousCountries, tiers }),
    /Suspicious 50GB price change/
  );
});

test('validates hard limits across currency changes using old and new exchange rates', () => {
  const tiers = [testTier('50GB')];
  const previousCountries = [testCountry({ '50GB': { price: 10 } })];
  const changedCurrency = [testCountry(
    { '50GB': { price: 1_000_000_000 } },
    { currency: 'JPY' }
  )];

  assert.throws(
    () => validatePrices(changedCurrency, {
      minCountries: 1,
      previousCountries,
      previousRates: { USD: 1, CNY: 7 },
      currentRates: { JPY: 150, CNY: 7 },
      tiers
    }),
    /Suspicious 50GB price change/
  );
  assert.throws(
    () => validatePrices(changedCurrency, { minCountries: 1, previousCountries, tiers }),
    /exchange rate is missing/
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

test('rejects an extreme exchange-rate move even when Apple local prices are unchanged', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { XYZ: 1, CNY: 7 } }
  };
  const unchanged = [{ country: 'Example', currency: 'XYZ', plans: { '50GB': { price: 10 } } }];

  assert.throws(
    () => validatePriceChangeAnomalies(unchanged, {
      previousData,
      currentRates: { XYZ: 100, CNY: 7 },
      tiers: [{ id: '50GB' }]
    }),
    /Suspicious FX-derived 50GB CNY change/
  );
  assert.equal(validatePriceChangeAnomalies(unchanged, {
    previousData,
    currentRates: { XYZ: 1.1, CNY: 7 },
    tiers: [{ id: '50GB' }]
  }), true);
});

test('rejects an extreme derived-CNY outlier in a newly added market', () => {
  const normalCountries = Array.from({ length: 10 }, (_, index) => ({
    country: `Market ${index}`,
    currency: 'USD',
    plans: { '50GB': { price: 1, cnyPrice: 7 } }
  }));
  const countries = [...normalCountries, {
    country: 'New Outlier',
    currency: 'USD',
    plans: { '50GB': { price: 1_000, cnyPrice: 7_000 } }
  }];
  assert.throws(
    () => validatePriceChangeAnomalies(countries, {
      previousData: { countries: normalCountries, fx: {} },
      currentRates: null,
      tiers: [{ id: '50GB' }]
    }),
    /Suspicious 50GB CNY market outlier for New Outlier/
  );
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

test('accepts documented global iCloud+ adjustments below the extreme-change threshold', async () => {
  const fixture = JSON.parse(await readFile(priceHistoryFixtureUrl, 'utf8'));
  let adjustmentCount = 0;

  for (const batch of fixture.batches) {
    for (const adjustment of batch.adjustments) {
      const tierIds = Object.keys(adjustment.previous);
      assert.deepEqual(Object.keys(adjustment.current), tierIds, `${batch.label}: ${adjustment.country}`);
      const tiers = tierIds.map(testTier);
      const toCountry = (plans) => ({
        country: adjustment.country,
        region: 'Americas',
        currency: adjustment.currency,
        plans: Object.fromEntries(Object.entries(plans).map(([id, price]) => [id, { price }]))
      });
      const previous = toCountry(adjustment.previous);
      const current = toCountry(adjustment.current);

      assert.equal(validatePrices([current], {
        minCountries: 1,
        previousCountries: [previous],
        tiers
      }), true, `${batch.label}: ${adjustment.country} hard limit`);
      assert.equal(validatePriceChangeAnomalies([current], {
        previousData: {
          countries: [previous],
          fx: { rates: { [adjustment.currency]: 1, CNY: 7 } }
        },
        currentRates: { [adjustment.currency]: 1, CNY: 7 },
        tiers
      }), true, `${batch.label}: ${adjustment.country} combined limit`);
      adjustmentCount += 1;
    }
  }

  assert.equal(adjustmentCount, 25);
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

test('returns structured warnings for independently confirmed heuristic price anomalies', () => {
  const previousData = {
    countries: [{ marketId: 'example-id', country: 'Example', currency: 'USD', plans: { '50GB': { price: 1 } } }],
    fx: { rates: { USD: 1, CNY: 7 } }
  };
  const current = [{ marketId: 'example-id', country: 'Example', currency: 'USD', plans: { '50GB': { price: 3.5 } } }];
  const warnings = validatePriceChangeAnomalies(current, {
    previousData,
    currentRates: previousData.fx.rates,
    tiers: [{ id: '50GB' }],
    appleSemanticConfirmed: true
  });
  assert.deepEqual(warnings, [{
    code: 'PRICE_CHANGE_ANOMALY_CONFIRMED',
    type: 'combined-local-price',
    marketId: 'example-id',
    sourceName: 'Example',
    tier: '50GB',
    previous: 1,
    current: 3.5
  }]);
});

test('classifies FX-only anomalies by FX authority instead of Apple confirmation', () => {
  const previousData = {
    countries: [{ marketId: 'example-id', country: 'Example', currency: 'USD', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { USD: 1, CNY: 4 } }
  };
  const current = [{ marketId: 'example-id', country: 'Example', currency: 'USD', plans: { '50GB': { price: 10 } } }];
  const warnings = validatePriceChangeAnomalies(current, {
    previousData,
    currentRates: { USD: 1, CNY: 7 },
    tiers: [{ id: '50GB' }],
    appleSemanticConfirmed: true,
    fxSanity: { status: 'passed', checks: [{ currency: 'USD', status: 'passed' }] }
  });
  assert.equal(warnings[0].code, 'FX_DERIVED_CHANGE_ANOMALY_ACCEPTED');
  assert.equal(warnings[0].fxSanityStatus, 'passed');
  assert.ok(warnings.every(({ code }) => code !== 'PRICE_CHANGE_ANOMALY_CONFIRMED'));
});

test('requires validated FX authority for suspicious Apple currency changes', () => {
  const previousData = {
    countries: [{ marketId: 'example-id', country: 'Example', currency: 'USD', plans: { '50GB': { price: 10 } } }],
    fx: { rates: { USD: 1, EUR: 1, CNY: 7 } }
  };
  const changed = (currency, price) => [{ marketId: 'example-id', country: 'Example', currency, plans: { '50GB': { price } } }];
  const options = { previousData, tiers: [{ id: '50GB' }], appleSemanticConfirmed: true };

  assert.throws(
    () => validatePriceChangeAnomalies(changed('NEW', 100), {
      ...options,
      currentRates: { NEW: 1, CNY: 7 },
      fxSanity: { status: 'passed', checks: [{ currency: 'NEW', status: 'skipped-new-currency' }] }
    }),
    (error) => error.code === 'CURRENCY_CHANGE_VALUE_REVIEW_REQUIRED'
  );
  assert.throws(
    () => validatePriceChangeAnomalies(changed('NEW', 100), {
      ...options,
      currentRates: { NEW: 1, CNY: 7 },
      fxSanity: { status: 'passed', checks: [] }
    }),
    (error) => error.code === 'CURRENCY_CHANGE_VALUE_REVIEW_REQUIRED'
  );

  const existingCurrency = validatePriceChangeAnomalies(changed('EUR', 100), {
    ...options,
    currentRates: { EUR: 1, CNY: 7 },
    fxSanity: { status: 'passed', checks: [{ currency: 'EUR', status: 'passed' }] }
  });
  assert.equal(existingCurrency[0].code, 'CURRENCY_CHANGE_ANOMALY_ACCEPTED');
  assert.equal(existingCurrency[0].fxSanityStatus, 'passed');

  const cny = validatePriceChangeAnomalies(changed('CNY', 300), {
    ...options,
    currentRates: { CNY: 1 },
    fxSanity: { status: 'passed', checks: [{ currency: 'CNY', status: 'skipped-cny' }] }
  });
  assert.equal(cny[0].code, 'CURRENCY_CHANGE_ANOMALY_ACCEPTED');
  assert.equal(cny[0].fxSanityStatus, 'not-required-cny');
});

test('rejects a cross-currency price change when its converted value is implausible', () => {
  const previousData = {
    countries: [{ country: 'Example', currency: 'USD', plans: { '50GB': { price: 1 } } }],
    fx: { rates: { USD: 1, CNY: 7 } }
  };
  const changed = [{ country: 'Example', currency: 'JPY', plans: { '50GB': { price: 1_000_000_000 } } }];

  assert.throws(
    () => validatePriceChangeAnomalies(changed, {
      previousData,
      currentRates: { JPY: 150, CNY: 7 },
      tiers: [{ id: '50GB' }]
    }),
    /Suspicious combined 50GB price change.*USD to JPY/
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

test('rejects duplicate countries and an unconfirmed country-count drop', async () => {
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
    /missing without exact confirmation/
  );
});

test('rejects a country heading without a country name', async () => {
  const fixture = await readFile(fixtureUrl, 'utf8');
  const adjusted = fixture.replace('United States<sup>4</sup> (USD)', '<sup>4</sup> (USD)');
  assert.throws(
    () => parseApplePrices(adjusted),
    /missing a country name|Both Apple parsers failed/
  );
});

test('rejects a large regional drop even when the global country count is unchanged', async () => {
  const parsed = parseApplePrices(await readFile(fixtureUrl, 'utf8'));
  const previousCountries = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(parsed.countries[index % parsed.countries.length]),
    country: `Previous ${index + 1}`,
    region: index < 6 ? 'Americas' : index < 9 ? 'Europe, Middle East & Africa' : 'Asia Pacific'
  }));
  const currentCountries = previousCountries.map((country, index) => ({
    ...structuredClone(country),
    region: index < 4 ? 'Americas' : index < 9 ? 'Europe, Middle East & Africa' : 'Asia Pacific'
  }));
  currentCountries[0].region = 'Europe, Middle East & Africa';
  currentCountries[1].region = 'Europe, Middle East & Africa';

  assert.equal(currentCountries.length, previousCountries.length);
  assert.throws(
    () => validatePrices(currentCountries, {
      minCountries: 1,
      previousCountries,
      tiers: parsed.tiers
    }),
    /Country count for Americas dropped from 6 to 2 beyond confirmed removals/
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
