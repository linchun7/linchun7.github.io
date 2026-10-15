import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { load } from 'cheerio';
import { validatePricePayload } from '../data-contract.js';
import { renderStaticFragments } from '../scripts/static-page.mjs';
import { attachDerivedCnyPrices } from '../scripts/update-prices.mjs';

const country = (price = 0.99, currency = 'USD') => ({
  country: 'United States', marketId: 'us', nameZh: '美国', region: 'Americas', currency,
  plans: { '50GB': { price, formattedPrice: '$' + price } }
});

test('CNY display conversion rounds exact decimal half-cents without binary drift', () => {
  // Synthetic valid FX boundary, not a claim about any live exchange-rate quote.
  // The local amount is Apple's public 50GB USD amount. Exact arithmetic gives
  // 0.99 / 1 * 7.5 = 7.425 CNY, whose half-up cent value is 7.43.
  const output = attachDerivedCnyPrices([country()], { fx: { rates: { USD: 1, CNY: 7.5 } } });
  assert.equal(output[0].plans['50GB'].cnyPrice, 7.43);
  assert.equal(output[0].plans['50GB'].cnyRank, 1);
  assert.equal(output[0].plans['50GB'].price, 0.99);
});

test('CNY conversion preserves values on both sides of the midpoint', () => {
  for (const [rate, expected] of [[7.499999999999999, 7.42], [7.5, 7.43], [7.500000000000001, 7.43]]) {
    const output = attachDerivedCnyPrices([country()], { fx: { rates: { USD: 1, CNY: rate } } });
    assert.equal(output[0].plans['50GB'].cnyPrice, expected, String(rate));
  }
});

test('CNY conversion divides before rounding and retains original-rank semantics', () => {
  const rows = [country(0.99), { ...country(0.9900000001), marketId: 'ca', country: 'Canada' }];
  const output = attachDerivedCnyPrices(rows, { fx: { rates: { USD: 3, CNY: 22.5 } } });
  assert.deepEqual(output.map(row => row.plans['50GB'].cnyPrice), [7.43, 7.43]);
  assert.deepEqual(output.map(row => row.plans['50GB'].cnyRank), [1, 1],
    'the pre-existing full-precision epsilon rank contract remains unchanged');
});

test('retained derived prices are reused verbatim, without recasting old publications', () => {
  const previous = country();
  previous.plans['50GB'] = { ...previous.plans['50GB'], cnyPrice: 7.42, cnyRank: 1 };
  const output = attachDerivedCnyPrices([country()], {
    fx: { reusePreviousCny: true },
    previousData: { countries: [previous] }
  });
  assert.equal(output[0].plans['50GB'].cnyPrice, 7.42);
  assert.equal(output[0].plans['50GB'].cnyRank, 1);
});

test('scientific decimal operands and large final values do not round intermediates', () => {
  const vectors = [
    { price: 1e7, rate: 1e9, cny: 7.5, expected: 0.08 },
    // Operand-level scientific boundaries, not claims about live provider FX.
    { price: 0.99, rate: 1e21, cny: 7.5e21, expected: 7.43 },
    { price: Number.MIN_VALUE, rate: Number.MIN_VALUE, cny: 7.425, expected: 7.43 },
    { price: 0.01, rate: 1e-7, cny: 7.5, expected: 750000 },
    { price: 0.01, rate: 3, cny: 7, expected: 0.02 },
    { price: 1.13, rate: 1, cny: 1.5, expected: 1.7 },
    { price: 0.29, rate: 1, cny: 1.5, expected: 0.44 },
    { price: Number.MAX_SAFE_INTEGER, rate: 1, cny: 1, expected: Number.MAX_SAFE_INTEGER }
  ];
  for (const vector of vectors) {
    const input = country(vector.price, 'JPY');
    const before = structuredClone(input);
    const fx = Object.freeze({ rates: Object.freeze({ JPY: vector.rate, CNY: vector.cny }) });
    const output = attachDerivedCnyPrices([input], { fx });
    assert.equal(output[0].plans['50GB'].cnyPrice, vector.expected, JSON.stringify(vector));
    assert.deepEqual(input, before, 'source local price and operands are immutable');
  }
});

test('sub-half-cent results keep the existing positive-public-price gate', async () => {
  const production = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
  for (const [rate, expected] of [[2.000000000000001, 0], [2, 0.01], [1.999999999999999, 0.01]]) {
    const payload = structuredClone(production);
    payload.tiers = payload.tiers.filter(tier => tier.id === '50GB');
    payload.countries = attachDerivedCnyPrices([country(0.01)], { fx: { rates: { USD: rate, CNY: 1 } } });
    payload.run.countries = 1;
    payload.run.pricePoints = 1;
    assert.equal(payload.countries[0].plans['50GB'].cnyPrice, expected);
    if (expected === 0) {
      assert.throws(() => validatePricePayload(payload), /invalid 50GB pricing for United States/,
        'a rounded zero is still rejected before publication, rather than expanding the data contract');
    } else {
      assert.equal(validatePricePayload(payload), payload);
    }
  }
});

test('corrected reference cents reach both readable HTML and embedded browser data', async () => {
  const payload = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
  payload.tiers = payload.tiers.filter(tier => tier.id === '50GB');
  payload.countries = attachDerivedCnyPrices([country()], { fx: { rates: { USD: 1, CNY: 7.5 } } });
  payload.run.countries = 1;
  payload.run.pricePoints = 1;
  assert.equal(validatePricePayload(payload), payload);
  const fragments = renderStaticFragments(payload);
  assert.equal(load(fragments.TABLE_BODY)('.price-amount').text(), '7.43');
  const embedded = JSON.parse(load(fragments.META)('#icloud-price-data').text());
  assert.equal(embedded.prices.countries[0].plans['50GB'].cnyPrice, 7.43);
  assert.equal(validatePricePayload(embedded.prices).countries[0].plans['50GB'].cnyRank, 1);
});

test('invalid operands and the pre-existing full-precision overflow boundary fail closed', () => {
  for (const rates of [
    { USD: 0, CNY: 7.5 }, { USD: -1, CNY: 7.5 },
    { USD: NaN, CNY: 7.5 }, { USD: Infinity, CNY: 7.5 },
    { USD: 1, CNY: 0 }, { USD: 1, CNY: Infinity },
    { USD: Number.MIN_VALUE, CNY: Number.MIN_VALUE }
  ]) {
    assert.throws(() => attachDerivedCnyPrices([country()], { fx: { rates } }), /Cannot derive/);
  }
});

test('unrepresentable exact fractional cents fail before publication, without a numeric cap', () => {
  // These operand-level boundaries were reproduced against the previous
  // Number return in Actions. They are not current official price/FX claims.
  for (const example of [
    { local: 0.99, currency: 'USD', rates: { USD: 1, CNY: 90981810653949.4 } },
    { local: Number.MAX_SAFE_INTEGER, currency: 'JPY', rates: { JPY: 750, CNY: 7.5 } }
  ]) {
    // Exact half-up cents are 90071992547409.91; its Number spelling would be
    // 90071992547409.9. The new candidate must fail, rather than publish that loss.
    const input = country(example.local, example.currency);
    const before = structuredClone(input);
    assert.throws(() => attachDerivedCnyPrices([input], { fx: { rates: example.rates } }),
      /CNY cents cannot be represented exactly/);
    assert.deepEqual(input, before);
  }
});

test('a retained large fractional Number bypasses the new-derivation precision gate', () => {
  const input = country(Number.MAX_SAFE_INTEGER, 'JPY');
  const previous = structuredClone(input);
  previous.plans['50GB'] = {
    ...previous.plans['50GB'], cnyPrice: 90071992547409.9, cnyRank: 1
  };
  const output = attachDerivedCnyPrices([input], {
    fx: { reusePreviousCny: true, rates: { JPY: 750, CNY: 7.5 } },
    previousData: { countries: [previous] }
  });
  assert.equal(output[0].plans['50GB'].cnyPrice, previous.plans['50GB'].cnyPrice);
  assert.equal(output[0].plans['50GB'].cnyRank, 1);
});
