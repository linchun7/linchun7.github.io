import assert from 'node:assert/strict';
import test from 'node:test';
import { attachDerivedCnyPrices } from '../scripts/update-prices.mjs';

const country = (price = 0.99, currency = 'USD') => ({
  country: 'United States', marketId: 'us', region: 'Americas', currency,
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
