import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('committed prices and history form a complete usable snapshot', async () => {
  const [data, history, names] = await Promise.all([
    readJson('../data/prices.json'),
    readJson('../data/history.json'),
    readJson('../scripts/country-names.zh.json')
  ]);

  assert.equal(data.schemaVersion, 1);
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(data.source.url, 'https://support.apple.com/en-us/108047');
  assert.deepEqual(data.tiers.map(({ id }) => id), ['50GB', '200GB', '2TB', '6TB', '12TB']);
  assert.ok(data.countries.length >= 60);
  assert.ok(Number.isFinite(data.fx.rates.CNY) && data.fx.rates.CNY > 0);
  assert.equal(names['Euro Zone'], '欧盟');
  assert.equal(names['United Arab Emirates'], '阿拉伯联合酋长国');

  const seen = new Set();
  for (const country of data.countries) {
    assert.ok(!seen.has(country.country), `duplicate country: ${country.country}`);
    seen.add(country.country);
    assert.equal(country.nameZh, names[country.country] ?? country.country);
    assert.ok(Number.isFinite(data.fx.rates[country.currency]) && data.fx.rates[country.currency] > 0,
      `missing exchange rate: ${country.currency}`);

    for (const { id } of data.tiers) {
      const plan = country.plans[id];
      assert.ok(plan && Number.isFinite(plan.price) && plan.price > 0, `invalid ${id}: ${country.country}`);
      assert.ok(typeof plan.formattedPrice === 'string' && plan.formattedPrice.length > 0,
        `missing formatted ${id}: ${country.country}`);
    }

    const record = history.countries[country.country];
    assert.ok(record?.events?.length, `missing history: ${country.country}`);
    let previousDate = '';
    for (const event of record.events) {
      assert.match(event.observedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(event.observedAt >= previousDate, `unordered history: ${country.country}`);
      previousDate = event.observedAt;
      for (const { id } of data.tiers) {
        assert.ok(Number.isFinite(event.plans[id]) && event.plans[id] > 0,
          `invalid history ${id}: ${country.country}`);
      }
    }
  }
});
