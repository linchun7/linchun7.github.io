import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApplePrices } from '../scripts/parse-prices.mjs';

const TABLE_HTML = `<!doctype html>
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

const LIST_HTML = `<!doctype html>
<html lang="en">
  <body>
    <h3 id="nasalac">North America, South America, Latin America, and the Caribbean</h3>
    <h4 class="gb-header">Bahamas (USD)</h4>
    <ul><li><strong>50 GB</strong>: $0.99</li></ul>
    <h3 id="emea">Europe, the Middle East, and Africa</h3>
    <h4 class="gb-header">Egypt (EGP)</h4>
    <ul><li><strong>50 GB</strong>: £49.99</li></ul>
    <h3 id="ap">Asia Pacific</h3>
    <h4 class="gb-header">China mainland (CNY)</h4>
    <ul><li><strong>50 GB</strong>: ¥6</li></ul>
  </body>
</html>`;

const LAYOUTS = [
  ['table', TABLE_HTML],
  ['legacy-list', LIST_HTML]
];

function egyptPrice(html) {
  const parsed = parseApplePrices(html);
  assert.equal(parsed.parser, 'cross-checked');
  const egypt = parsed.countries.find(({ country }) => country === 'Egypt');
  assert.ok(egypt);
  assert.equal(egypt.currency, 'EGP');
  return egypt.plans['50GB'];
}

test('keeps the current Apple EGP pound-sign format unchanged across supported layouts', () => {
  for (const [layout, html] of LAYOUTS) {
    const plan = egyptPrice(html);
    assert.equal(plan.price, 49.99, layout);
    assert.equal(plan.formattedPrice, '£49.99', layout);
  }
});

test('accepts bounded ISO-qualified EGP symbol variants across supported layouts', () => {
  for (const [layout, html] of LAYOUTS) {
    for (const marker of ['E£', 'EG£', 'EGP£', '£E', '£EG', '£EGP']) {
      const plan = egyptPrice(html.replace('£49.99', `${marker}49.99`));
      assert.equal(plan.price, 49.99, `${layout}: ${marker}`);
      assert.equal(plan.formattedPrice, `${marker}49.99`, `${layout}: ${marker}`);
    }
  }
});

test('rejects arbitrary or wrong-currency decorations across supported layouts', () => {
  for (const [layout, html] of LAYOUTS) {
    for (const marker of ['X£', 'E€', 'USD£', 'EGPX£']) {
      const malformed = html.replace('£49.99', `${marker}49.99`);
      assert.throws(() => parseApplePrices(malformed), /Unable to parse/, `${layout}: ${marker}`);
    }
  }
});
