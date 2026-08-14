import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publicationDateKey, snapshotFileSha256 } from '../scripts/update-prices.mjs';

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

  assert.equal(data.schemaVersion, 4);
  assert.match(data.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(data.source.url, 'https://support.apple.com/en-us/108047');
  assert.ok(data.tiers.length > 0);
  assert.equal(new Set(data.tiers.map(({ id }) => id)).size, data.tiers.length);
  assert.ok(data.countries.length >= 60);
  assert.equal(data.fx.derivedCurrency, 'CNY');
  assert.equal(Object.hasOwn(data.fx, 'rates'), false);
  assert.equal(Object.hasOwn(data.fx, 'apiKeyStatus'), false);
  assert.ok([
    'https://v6.exchangerate-api.com/v6/latest/USD',
    'https://open.er-api.com/v6/latest/USD'
  ].includes(data.fx.sourceUrl), 'exchange-rate credentials must never be stored in the source URL');
  {
    if (data.source.parser != null) {
      assert.equal(data.source.parser, 'cross-checked');
      assert.equal(typeof data.source.parserStatus, 'string');
    }
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
  assert.equal(history.schemaVersion, 4);
  assert.ok(history.updatedAt <= data.generatedAt);
  assert.equal(runLog.schemaVersion, 1);
  assert.ok(Array.isArray(runLog.runs));
  for (const run of runLog.runs) {
    assert.equal(
      Object.keys(run.source ?? {}).some((key) => /api.?key/i.test(key)),
      false,
      'public run-log.json must not expose API-key configuration or status metadata'
    );
  }
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
    assert.equal(latestRun.finishedAtUtc, data.run.finishedAtUtc);
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
  const seenMarketIds = new Set();
  for (const country of data.countries) {
    assert.ok(!seen.has(country.country), `duplicate country: ${country.country}`);
    seen.add(country.country);
    assert.ok(!seenMarketIds.has(country.marketId), `duplicate marketId: ${country.marketId}`);
    seenMarketIds.add(country.marketId);
    assert.equal(country.nameZh, names[country.country] ?? country.country);
    for (const { id } of data.tiers) {
      const plan = country.plans[id];
      assert.ok(plan && Number.isFinite(plan.price) && plan.price > 0, `invalid ${id}: ${country.country}`);
      assert.ok(typeof plan.formattedPrice === 'string' && plan.formattedPrice.length > 0,
        `missing formatted ${id}: ${country.country}`);
      assert.ok(Number.isFinite(plan.cnyPrice) && plan.cnyPrice > 0,
        `missing derived CNY ${id}: ${country.country}`);
      assert.ok(Math.abs(plan.cnyPrice * 100 - Math.round(plan.cnyPrice * 100)) < 1e-7,
        `derived CNY has more than two decimals: ${country.country} ${id}`);
      assert.ok(Number.isInteger(plan.cnyRank) && plan.cnyRank > 0, `invalid CNY rank: ${country.country} ${id}`);
    }

    const record = history.markets[country.marketId];
    assert.ok(record?.events?.length, `missing history: ${country.country}`);
    assert.equal(record.country, country.country, `history source name mismatch: ${country.country}`);
    assert.equal(record.nameZh, country.nameZh, `history name mismatch: ${country.country}`);
    assert.equal(record.region, country.region, `history region mismatch: ${country.country}`);
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
    assert.equal(latestEvent.currency, country.currency, `latest history currency mismatch: ${country.country}`);
    for (const { id } of data.tiers) {
      assert.ok(Number.isFinite(latestEvent.plans[id]) && latestEvent.plans[id] > 0,
        `latest history is missing ${id}: ${country.country}`);
      assert.equal(latestEvent.plans[id], country.plans[id].price, `latest history price mismatch: ${country.country} ${id}`);
    }
  }
});

test('committed public prices expose only allowlisted FX metadata and complete derived CNY values', async () => {
  const data = await readJson('../data/prices.json');
  assert.deepEqual(Object.keys(data.fx).sort(), [
    'base',
    'derivedCurrency',
    'fallbackReason',
    'fallbackUsed',
    'fetchedAt',
    'sourceMode',
    'sourceUrl',
    'stale'
  ]);
  assert.equal(data.fx.derivedCurrency, 'CNY');
  assert.equal(data.countries.flatMap(({ plans }) => Object.values(plans)).length, data.run.pricePoints);
  assert.ok(data.countries.every(({ plans }) => Object.values(plans).every(({ cnyPrice }) => (
    Number.isFinite(cnyPrice) && cnyPrice > 0
  ))));
});

test('committed Apple snapshot index has unique dates and existing revision files', async () => {
  const [index, history] = await Promise.all([
    readJson('../data/apple-snapshots/index.json'),
    readJson('../data/history.json')
  ]);
  assert.equal(index.schemaVersion, 2);
  const dates = new Set();
  for (const snapshot of index.snapshots) {
    assert.match(snapshot.publishedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!dates.has(snapshot.publishedDate), `duplicate snapshot date: ${snapshot.publishedDate}`);
    dates.add(snapshot.publishedDate);
    assert.ok(snapshot.revisions.length >= 1);
    assert.equal(snapshot.activeDataFile, snapshot.revisions.at(-1).dataFile);
    assert.equal(snapshot.activeContentHash, snapshot.revisions.at(-1).contentHash);
    const publicationRecord = history.sourcePublishedDates.find(
      ({ publishedDate }) => publicationDateKey(publishedDate) === snapshot.publishedDate
    );
    assert.ok(publicationRecord, `missing publication history for ${snapshot.publishedDate}`);
    assert.equal(
      snapshot.revisions[0].firstConfirmedDate,
      publicationRecord.observedAt,
      `earliest confirmation date mismatch for ${snapshot.publishedDate}`
    );
    for (const revision of snapshot.revisions) {
      assert.match(revision.contentHash, /^[a-f0-9]{64}$/);
      assert.match(revision.dataSha256, /^[a-f0-9]{64}$/);
      assert.match(revision.firstConfirmedDate, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal('capturedAtUtc' in revision, false);
      assert.equal('file' in revision, false);
      assert.equal('htmlSha256' in revision, false);
      const normalized = await readFile(new URL(`../data/apple-snapshots/${revision.dataFile}`, import.meta.url));
      assert.equal(snapshotFileSha256(normalized), revision.dataSha256);
    }
  }
});
