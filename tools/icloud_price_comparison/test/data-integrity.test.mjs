import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8'));
}

test('committed prices and history form a complete usable snapshot', async () => {
  const [data, history, names, runLog] = await Promise.all([
    readJson('../data/prices.json'),
    readJson('../data/history.json'),
    readJson('../scripts/country-names.zh.json'),
    readJson('../data/run-log.json')
  ]);

  assert.ok([1, 2].includes(data.schemaVersion));
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(data.source.url, 'https://support.apple.com/en-us/108047');
  assert.ok(data.tiers.length > 0);
  assert.equal(new Set(data.tiers.map(({ id }) => id)).size, data.tiers.length);
  assert.ok(data.countries.length >= 60);
  assert.ok(Number.isFinite(data.fx.rates.CNY) && data.fx.rates.CNY > 0);
  if (data.schemaVersion === 2) {
    assert.match(data.source.parser, /^(cross-checked|document-order|apple-markers-fallback)$/);
    assert.equal(typeof data.source.parserStatus, 'string');
    assert.equal(data.run.countries, data.countries.length);
    assert.equal(data.run.pricePoints, data.countries.length * data.tiers.length);
    assert.match(data.run.startedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(data.run.finishedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(data.run.observedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(data.run.observedAtBeijing, /^\d{4}-\d{2}-\d{2}$/);
  }
  assert.equal(names['Euro Zone'], '欧盟');
  assert.equal(names['United Arab Emirates'], '阿拉伯联合酋长国');
  assert.ok(Array.isArray(history.sourcePublishedDates) && history.sourcePublishedDates.length);
  assert.ok([1, 2].includes(history.schemaVersion));
  assert.equal(runLog.schemaVersion, 1);
  assert.ok(Array.isArray(runLog.runs));
  if (runLog.runs.length) {
    const latestRun = runLog.runs.at(-1);
    assert.equal(latestRun.status, 'success');
    assert.equal(latestRun.counts.countries, data.countries.length);
    assert.equal(latestRun.counts.pricePoints, data.countries.length * data.tiers.length);
    assert.equal(latestRun.source.appleUrl, data.source.url);
    assert.match(latestRun.startedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(latestRun.finishedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(latestRun.finishedAtUtc >= latestRun.startedAtUtc);
    assert.ok(Array.isArray(latestRun.changes.addedCountries));
    assert.ok(Array.isArray(latestRun.changes.removedCountries));
    assert.ok(Array.isArray(latestRun.changes.changedCountries));
    if (data.schemaVersion === 2) assert.equal(latestRun.finishedAtUtc, data.run.finishedAtUtc);
  }
  const latestPublishedDate = history.sourcePublishedDates.at(-1);
  assert.equal(latestPublishedDate.publishedDate, data.source.publishedDate);
  assert.match(latestPublishedDate.observedAt, /^\d{4}-\d{2}-\d{2}$/);
  for (let index = 1; index < history.sourcePublishedDates.length; index += 1) {
    assert.notEqual(
      history.sourcePublishedDates[index].publishedDate,
      history.sourcePublishedDates[index - 1].publishedDate,
      'unchanged Apple publication dates should not be repeated'
    );
  }

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
      if (event.observedAtUtc) {
        assert.match(event.observedAtUtc, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(event.observedAtBeijing, event.observedAt);
      }
      assert.ok(event.observedAt >= previousDate, `unordered history: ${country.country}`);
      previousDate = event.observedAt;
      assert.ok(event.plans && Object.keys(event.plans).length > 0, `empty history plans: ${country.country}`);
      for (const [id, price] of Object.entries(event.plans)) {
        assert.ok(Number.isFinite(price) && price > 0, `invalid history ${id}: ${country.country}`);
      }
    }
    const latestEvent = record.events.at(-1);
    for (const { id } of data.tiers) {
      assert.ok(Number.isFinite(latestEvent.plans[id]) && latestEvent.plans[id] > 0,
        `latest history is missing ${id}: ${country.country}`);
    }
  }
});
