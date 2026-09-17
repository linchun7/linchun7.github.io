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
      <tbody><tr><td>Egypt (EGP)</td><td>E£49.99</td></tr></tbody>
    </table>
    <h3 id="ap">Asia Pacific</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th></tr></thead>
      <tbody><tr><td>China mainland (CNY)</td><td>¥6</td></tr></tbody>
    </table>
  </body>
</html>`;

test('accepts Apple E£ decoration for EGP while preserving the formatted source price', () => {
  const parsed = parseApplePrices(HTML);
  assert.equal(parsed.parser, 'cross-checked');
  const egypt = parsed.countries.find(({ country }) => country === 'Egypt');
  assert.ok(egypt);
  assert.equal(egypt.currency, 'EGP');
  assert.equal(egypt.plans['50GB'].price, 49.99);
  assert.equal(egypt.plans['50GB'].formattedPrice, 'E£49.99');
});

test('does not generalize the E£ exception to unrelated currency decorations', () => {
  const malformed = HTML.replace('E£49.99', 'EG£49.99');
  assert.throws(() => parseApplePrices(malformed), /Unable to parse table price/);
});
