import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateHistoryPayload, validatePayload, validatePriceHistoryConsistency, validatePricePayload } from '../data-contract.js';
import { validateExistingHistory, validateExistingPrices } from '../scripts/update-prices.mjs';

const pricesUrl = new URL('../data/prices.json', import.meta.url);
const historyUrl = new URL('../data/history.json', import.meta.url);

async function productionFixtures() {
  const [prices, history] = await Promise.all([
    readFile(pricesUrl, 'utf8').then(JSON.parse),
    readFile(historyUrl, 'utf8').then(JSON.parse)
  ]);
  return { prices, history };
}

test('shared browser and updater contracts accept the committed production payloads', async () => {
  const { prices, history } = await productionFixtures();
  assert.equal(validatePricePayload(prices), prices);
  assert.equal(validateHistoryPayload(history), history);
  assert.doesNotThrow(() => validateExistingPrices(prices));
  assert.doesNotThrow(() => validateExistingHistory(history, prices));
});

test('rejects undeclared price tiers and truncated browser payloads', async () => {
  const { prices, history } = await productionFixtures();
  const extraTier = structuredClone(prices);
  extraTier.countries[0].plans.EXTRA = { price: 1, formattedPrice: '$1' };
  assert.throws(() => validatePricePayload(extraTier), /plans that do not match declared tiers/);
  assert.throws(() => validatePriceHistoryConsistency(extraTier, history), /plans that do not match declared tiers/);

  const truncated = structuredClone(prices);
  truncated.countries = truncated.countries.slice(0, 1);
  truncated.run.countries = truncated.countries.length;
  truncated.run.pricePoints = truncated.countries.length * truncated.tiers.length;
  assert.doesNotThrow(() => validatePricePayload(truncated), 'the low-level contract remains usable for isolated fixtures');
  assert.throws(() => validatePayload('prices.json', truncated), /incomplete tiers or countries/);
});

test('rejects unsafe or unsupported storage tier identifiers', async () => {
  const { prices } = await productionFixtures();
  for (const tierId of ['__proto__', 'constructor', 'prototype', '50 GB', '50GB\"]']) {
    const payload = structuredClone(prices);
    const previousTierId = payload.tiers[0].id;
    payload.tiers[0].id = tierId;
    for (const country of payload.countries) {
      country.plans = Object.fromEntries(Object.entries(country.plans).map(([id, plan]) => (
        [id === previousTierId ? tierId : id, plan]
      )));
    }
    assert.throws(() => validatePricePayload(payload), /invalid or duplicate tiers/);
    assert.throws(() => validateExistingPrices(payload), /invalid or duplicate tiers/);
  }
});

test('shared browser and updater contracts reject the same price schema divergences', async () => {
  const { prices } = await productionFixtures();
  const mutations = [
    (payload) => { delete payload.fx.stale; },
    (payload) => { payload.generatedAt = payload.generatedAt.replace(/\.\d{3}Z$/, 'Z'); },
    (payload) => { payload.fx.fetchedAt = payload.fx.fetchedAt.replace(/\.\d{3}Z$/, 'Z'); },
    (payload) => { payload.source.publishedDate = '2099-01-01'; }
  ];

  for (const mutate of mutations) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload));
    assert.throws(() => validateExistingPrices(payload));
  }
});

test('shared browser and updater contracts reject invalid publication kind and changes', async () => {
  const { prices, history } = await productionFixtures();
  const mutations = [
    (payload) => { payload.sourcePublishedDates[0].kind = 'unknown'; },
    (payload) => { payload.sourcePublishedDates[0].changes.addedCountries = {}; },
    (payload) => { payload.sourcePublishedDates[0].changes.addedTiers = [{ id: '__proto__' }]; },
    (payload) => { payload.sourcePublishedDates[0].observedAt = '2024-12-04'; },
    (payload) => {
      const event = Object.values(payload.countries)[0].events[0];
      const nextDay = new Date(`${event.observedAt}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      event.observedAtUtc = nextDay.toISOString();
      event.observedAtBeijing = event.observedAt;
    },
    (payload) => {
      const event = Object.values(payload.countries)[0].events[0];
      event.observedAtBeijing = event.observedAt;
    },
    (payload) => {
      const entry = payload.sourcePublishedDates[0];
      const nextDay = new Date(`${entry.observedAt}T00:00:00.000Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      entry.observedAtUtc = nextDay.toISOString();
      entry.observedAtBeijing = entry.observedAt;
    }
  ];

  for (const mutate of mutations) {
    const payload = structuredClone(history);
    mutate(payload);
    assert.throws(() => validateHistoryPayload(payload));
    assert.throws(() => validateExistingHistory(payload, prices));
  }
});

test('rejects malformed publication change details in both shared and updater history contracts', async () => {
  const { prices, history } = await productionFixtures();
  const mutations = [
    (change) => { delete change.fromCurrency; },
    (change) => { delete change.toCurrency; },
    (change) => { delete change.fromRegion; },
    (change) => { delete change.toRegion; },
    (change) => { change.tiers = []; },
    (change) => { delete change.tiers[0].from; },
    (change) => { delete change.tiers[0].to; },
    (change) => { change.tiers[0].from = 0; },
    (change) => { change.tiers[0].to = Number.NaN; },
    (change) => { change.tiers[0].from = '4.90'; },
    (change) => { change.tiers[0].from = null; change.tiers[0].to = null; }
  ];

  for (const mutate of mutations) {
    const payload = structuredClone(history);
    const change = payload.sourcePublishedDates
      .flatMap((entry) => entry.changes?.changedCountries ?? [])[0];
    assert.ok(change, 'production history must include a changed-country fixture');
    mutate(change);
    assert.throws(() => validateHistoryPayload(payload));
    assert.throws(() => validateExistingHistory(payload, prices));
  }
});

test('rejects structurally valid prices/history mismatches in the shared cross-file contract', async () => {
  const { prices, history } = await productionFixtures();
  const country = prices.countries[0];
  const tierId = prices.tiers[0].id;
  const mutations = [
    ({ prices: changedPrices }) => { changedPrices.source.publishedDate = 'July 18, 2026'; },
    ({ history: changedHistory }) => { delete changedHistory.countries[country.country]; },
    ({ history: changedHistory }) => { changedHistory.countries[country.country].nameZh += '（旧）'; },
    ({ history: changedHistory }) => { changedHistory.countries[country.country].region = 'Other'; },
    ({ history: changedHistory }) => { changedHistory.countries[country.country].events.at(-1).currency = 'EUR'; },
    ({ history: changedHistory }) => { delete changedHistory.countries[country.country].events.at(-1).plans[tierId]; },
    ({ history: changedHistory }) => { changedHistory.countries[country.country].events.at(-1).plans.EXTRA = 1; },
    ({ history: changedHistory }) => { changedHistory.countries[country.country].events.at(-1).plans[tierId] += 1; }
  ];

  for (const mutate of mutations) {
    const changedPrices = structuredClone(prices);
    const changedHistory = structuredClone(history);
    mutate({ prices: changedPrices, history: changedHistory });
    assert.throws(() => validatePriceHistoryConsistency(changedPrices, changedHistory));
    assert.throws(() => validateExistingHistory(changedHistory, changedPrices));
  }
});
