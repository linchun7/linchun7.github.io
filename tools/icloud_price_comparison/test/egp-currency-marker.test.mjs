import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApplePrices } from '../scripts/parse-prices.mjs';

const HTML = `<!doctype html>
<html lang="en">
  <body>
    <h3 id="nasalac">North America, South America, Latin America, and the Caribbean</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th></tr></thead>
      <tbody><tr><td>Bahamas (USD)</td><td>$0.99</td></tr></tbody>
    </table>
    <h3 id="emea">Europe, the Middle East, and Africa</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th></tr></thead>
      <tbody><tr><td>Egypt (EGP)</td><td>£49.99</td></tr></tbody>
    </table>
    <h3 id="ap">Asia Pacific</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th></tr></thead>
      <tbody><tr><td>China mainland (CNY)</td><td>¥6</td></tr></tbody>
    </table>
  </body>
</html>`;

function egyptPrice(html) {
  const parsed = parseApplePrices(html);
  assert.equal(parsed.parser, 'cross-checked');
  const egypt = parsed.countries.find(({ country }) => country === 'Egypt');
  assert.ok(egypt);
  assert.equal(egypt.currency, 'EGP');
  return egypt.plans['50GB'];
}

test('keeps the current Apple EGP pound-sign format unchanged', () => {
  const plan = egyptPrice(HTML);
  assert.equal(plan.price, 49.99);
  assert.equal(plan.formattedPrice, '£49.99');
});

test('accepts ISO-qualified variants of the already-known EGP currency symbol', () => {
  for (const marker of ['E£', 'EG£', 'EGP£', '£E', '£EG', '£EGP']) {
    const plan = egyptPrice(HTML.replace('£49.99', `${marker}49.99`));
    assert.equal(plan.price, 49.99);
    assert.equal(plan.formattedPrice, `${marker}49.99`);
  }
});

test('does not accept arbitrary or wrong-currency decorations', () => {
  for (const marker of ['X£', 'E€', 'USD£', 'EGPX£']) {
    const malformed = HTML.replace('£49.99', `${marker}49.99`);
    assert.throws(() => parseApplePrices(malformed), /Unable to parse table price/);
  }
});
