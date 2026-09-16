import assert from 'node:assert/strict';
import test from 'node:test';
import { parseApplePrices } from '../scripts/parse-prices.mjs';

const CURRENT_TABLE_HTML = `<!doctype html>
<html lang="en">
  <body>
    <h3 id="nasalac">North America, South America, Latin America, and the Caribbean</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th><th>200 GB</th><th>2 TB</th><th>6 TB</th><th>12 TB</th></tr></thead>
      <tbody>
        <tr><td>Bahamas²𝄒³ (USD)</td><td>$0.99</td><td>$3.49</td><td>$10.99</td><td>$32.99</td><td>$64.99</td></tr>
      </tbody>
    </table>
    <h3 id="emea">Europe, the Middle East, and Africa</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th><th>200 GB</th><th>2 TB</th><th>6 TB</th><th>12 TB</th></tr></thead>
      <tbody>
        <tr><td>Euro<sup>3</sup> (Euro)</td><td>0.99 €</td><td>2.99 €</td><td>9.99 €</td><td>29.99 €</td><td>59.99 €</td></tr>
      </tbody>
    </table>
    <h3 id="ap">Asia Pacific</h3>
    <table>
      <thead><tr><th>Country (Currency)</th><th>50 GB</th><th>200 GB</th><th>2 TB</th><th>6 TB</th><th>12 TB</th></tr></thead>
      <tbody>
        <tr><td>China mainland<sup>3</sup> (CNY)</td><td>¥6</td><td>¥21</td><td>¥68</td><td>¥198</td><td>¥398</td></tr>
      </tbody>
    </table>
    <p>Published Date: September 15, 2026</p>
  </body>
</html>`;

test('parses Apple September 2026 table pricing through both association paths', () => {
  const parsed = parseApplePrices(CURRENT_TABLE_HTML);
  assert.equal(parsed.parser, 'cross-checked');
  assert.equal(parsed.parserStatus, 'Both DOM association paths agreed');
  assert.equal(parsed.sourcePublishedDate, 'September 15, 2026');
  assert.deepEqual(parsed.tiers.map(({ id }) => id), ['50GB', '200GB', '2TB', '6TB', '12TB']);
  assert.deepEqual(parsed.countries.map(({ country }) => country), ['Bahamas', 'Euro Zone', 'China mainland']);
  assert.equal(parsed.countries[0].plans['2TB'].price, 10.99);
  assert.equal(parsed.countries[1].currency, 'EUR');
  assert.equal(parsed.countries[2].plans['12TB'].price, 398);
});

test('keeps explicit confirmation mode for newly published table markets', () => {
  const html = CURRENT_TABLE_HTML.replace('Bahamas²𝄒³ (USD)', 'New Market² (USD)');
  assert.throws(() => parseApplePrices(html), /Unknown Apple country heading/);
  const parsed = parseApplePrices(html, { allowUnknownCountries: true });
  assert.equal(parsed.parser, 'cross-checked');
  assert.equal(parsed.countries[0].country, 'New Market');
});

test('fails closed on malformed table prices', () => {
  const html = CURRENT_TABLE_HTML.replace('<td>¥6</td>', '<td>¥-6</td>');
  assert.throws(() => parseApplePrices(html), /Unable to parse table price/);
});

test('fails closed on unsupported table storage units', () => {
  const html = CURRENT_TABLE_HTML.replaceAll('<th>12 TB</th>', '<th>12 PB</th>');
  assert.throws(() => parseApplePrices(html), /Unsupported Apple table storage tier/);
});

test('rejects incomplete regions, non-rectangular cells and changing interior headers', async (t) => {
  const { load } = await import('cheerio');
  const mutations = {
    'missing entire region table': ($) => $('table').first().remove(),
    'unrecognized region header': ($) => $('table').first().find('th').first().text('Market (Currency)'),
    'colspan changes physical meaning': ($) => $('table').first().find('td').eq(1).attr('colspan', '2'),
    'rowspan changes physical meaning': ($) => $('table').first().find('td').first().attr('rowspan', '0'),
    'missing price cell': ($) => $('table').first().find('td').last().remove(),
    'extra price cell': ($) => $('table').first().find('tbody tr').append('<td>$1</td>'),
    'duplicate country': ($) => $('table').first().find('tbody').append($('table').first().find('tbody tr').clone()),
    'changed interior tier header': ($) => {
      const header = $('table').first().find('thead tr').clone();
      header.children().eq(1).text('100 GB');
      $('table').first().find('tbody tr').after(header);
    },
    'reordered interior header': ($) => {
      const header = $('table').first().find('thead tr').clone();
      header.children().eq(1).before(header.children().eq(2));
      $('table').first().find('tbody tr').after(header);
    },
    'nested table': ($) => $('table').first().find('td').eq(1).append('<table><tr><td>$0.99</td></tr></table>')
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, () => {
      const $ = load(CURRENT_TABLE_HTML); mutate($);
      assert.throws(() => parseApplePrices($.html()), /table|Duplicate/);
    });
  }
});

test('independent row and column decoders preserve prices under wrappers, column permutations, footnotes and added tiers', async () => {
  const { load } = await import('cheerio');
  const baseline = parseApplePrices(CURRENT_TABLE_HTML);
  for (const order of [[1, 0, 4, 2, 3], [4, 3, 2, 1, 0], [0, 2, 4, 3, 1]]) {
    const $ = load(CURRENT_TABLE_HTML);
    $('table tr').each((_, row) => {
      const cells = $(row).children().toArray();
      $(row).empty().append(cells[0], ...order.map((i) => cells[i + 1]));
    });
    $('td, th').wrapInner('<div><span></span></div>');
    const result = parseApplePrices($.html());
    assert.equal(result.parser, 'cross-checked');
    for (const country of baseline.countries) {
      assert.deepEqual(result.countries.find((c) => c.country === country.country), country);
    }
    assert.deepEqual(result.tiers, baseline.tiers);
  }
  const $ = load(CURRENT_TABLE_HTML);
  $('table thead tr').append('<th>24 TB</th>');
  $('table tbody tr').append('<td>999.99<sup>3</sup></td>');
  $('table').each((_, table) => $(table).find('tbody tr').after($(table).find('thead tr').clone()));
  const result = parseApplePrices($.html());
  assert.equal(result.parser, 'cross-checked');
  assert.equal(result.tiers.at(-1).id, '24TB');
  assert.ok(result.countries.every((c) => c.plans['24TB'].price === 999.99));
});
