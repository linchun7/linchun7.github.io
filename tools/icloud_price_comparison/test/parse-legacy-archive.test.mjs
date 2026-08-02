import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLegacyAppleArchive } from '../scripts/parse-legacy-archive.mjs';

const regions = [
  ['nasalac', 'North America', 'Alpha', 'USD'],
  ['emea', 'Europe', 'Beta', 'EUR'],
  ['ap', 'Asia Pacific', 'Gamma', 'JPY']
];

function fixture() {
  const countries = regions.flatMap(([id, heading, prefix, currency]) => [
    `<h3 id="${id}">${heading}</h3>`,
    ...Array.from({ length: 20 }, (_, index) => `
      <p>${prefix} ${index + 1} (${currency})</p>
      <p><b>50GB:</b> $0.99</p>
      <p><b>200GB</b>: $2.99</p>
      <p><b>2TB</b>: $9.99</p>`)
  ]).join('');
  return `<div id="sections">${countries}<p><span>Published Date:</span> May 12, 2025</p></div>`;
}

test('cross-checks the legacy flat paragraph layout', () => {
  const parsed = parseLegacyAppleArchive(fixture());
  assert.equal(parsed.parser, 'legacy-archive-cross-checked');
  assert.equal(parsed.countries.length, 60);
  assert.deepEqual(parsed.tiers.map(({ id }) => id), ['50GB', '200GB', '2TB']);
  assert.equal(parsed.sourcePublishedDate, 'May 12, 2025');
});
