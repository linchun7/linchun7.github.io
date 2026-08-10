import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  publicFxFallbackReason,
  validateHistoryPayload,
  validatePayload,
  validatePriceHistoryConsistency,
  validatePricePayload
} from '../data-contract.js';
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
  assert.equal(validatePayload('history.json', history), history);
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

test('rejects tier labels or capacities that disagree with their canonical identifiers', async () => {
  const { prices } = await productionFixtures();
  for (const mutate of [
    (payload) => { payload.tiers[0].capacityGb += 1; },
    (payload) => { payload.tiers[0].label = 'Fifty GB'; },
    (payload) => { payload.tiers[0].id = '050GB'; },
    (payload) => { payload.tiers.reverse(); }
  ]) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload), /invalid or duplicate tiers/);
    assert.throws(() => validateExistingPrices(payload), /invalid or duplicate tiers/);
  }
});

test('rejects non-tier plan keys in every historical event', async () => {
  const { prices, history } = await productionFixtures();
  const payload = structuredClone(history);
  Object.values(payload.countries)[0].events[0].plans.EVIL = 1;
  assert.throws(() => validateHistoryPayload(payload), /invalid event/);
  assert.throws(() => validateExistingHistory(payload, prices), /invalid event/);
});

test('shared browser and updater contracts reject the same price schema divergences', async () => {
  const { prices } = await productionFixtures();
  const mutations = [
    (payload) => { delete payload.fx.stale; },
    (payload) => { payload.generatedAt = payload.generatedAt.replace(/\.\d{3}Z$/, 'Z'); },
    (payload) => { payload.fx.fetchedAt = payload.fx.fetchedAt.replace(/\.\d{3}Z$/, 'Z'); },
    (payload) => { payload.fx.fetchedAt = new Date(Date.parse(payload.generatedAt) + (5 * 60 * 1_000) + 1).toISOString(); },
    (payload) => { payload.fx.fetchedAt = new Date(Date.parse(payload.generatedAt) - (36 * 60 * 60 * 1_000) - (5 * 60 * 1_000) - 1).toISOString(); },
    (payload) => { payload.source.publishedDate = '2099-01-01'; },
    (payload) => { payload.countries[0].plans[payload.tiers[0].id].price = Number.MAX_SAFE_INTEGER + 1; }
  ];

  for (const mutate of mutations) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload));
    assert.throws(() => validateExistingPrices(payload));
  }
});

test('rejects raw exchange rates and every unexpected field in the current public schema', async () => {
  const { prices } = await productionFixtures();
  const mutations = [
    (payload) => { payload.fx.rates = { USD: 1, CNY: 7 }; },
    (payload) => { payload.fx.rateMap = { USD: 1, CNY: 7 }; },
    (payload) => { payload.fx.apiKeyStatus = 'valid'; },
    (payload) => { payload.countries[0].plans[payload.tiers[0].id].sourceRate = 1; },
    (payload) => { payload.unexpected = true; }
  ];
  for (const mutate of mutations) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload), /unexpected or invalid fields|invalid .* pricing/);
    assert.throws(() => validateExistingPrices(payload));
  }
});

test('rejects unsafe display text and Unicode controls in public data', async () => {
  const { prices, history } = await productionFixtures();
  for (const mutate of [
    (payload) => { payload.source.parserStatus = 'agreed\nspoofed'; },
    (payload) => { payload.countries[0].nameZh += '\u202e'; },
    (payload) => { payload.countries[0].region = '\ud800'; },
    (payload) => { payload.countries[0].plans[payload.tiers[0].id].formattedPrice += '\ufeff'; }
  ]) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload));
    assert.throws(() => validateExistingPrices(payload));
  }

  for (const mutate of [
    (payload) => { Object.values(payload.countries)[0].nameZh += '\u202e'; },
    (payload) => { Object.values(payload.countries)[0].region = '\ud800'; },
    (payload) => {
      payload.sourcePublishedDates.find((entry) => entry.changes.addedCountries.length)
        .changes.addedCountries[0].nameZh += '\ufeff';
    }
  ]) {
    const payload = structuredClone(history);
    mutate(payload);
    assert.throws(() => validateHistoryPayload(payload));
    assert.throws(() => validateExistingHistory(payload, prices));
  }
});

test('requires both independent Apple parsers for the current public schema', async () => {
  const { prices } = await productionFixtures();
  for (const parser of ['document-order', 'apple-markers-fallback']) {
    const payload = structuredClone(prices);
    payload.source.parser = parser;
    payload.source.parserStatus = 'only one parser succeeded';
    assert.throws(() => validatePricePayload(payload), /current public schema/);
  }
});

test('caps public arrays before rendering or retaining oversized evidence', async () => {
  const { prices, history } = await productionFixtures();
  for (const mutate of [
    (payload) => { payload.tiers = Array.from({ length: 21 }, () => structuredClone(payload.tiers[0])); },
    (payload) => { payload.countries = Array.from({ length: 251 }, () => structuredClone(payload.countries[0])); }
  ]) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.throws(() => validatePricePayload(payload));
  }

  for (const mutate of [
    (payload) => {
      const countryName = Object.keys(payload.countries)[0];
      payload.countries[countryName].events = Array.from(
        { length: 1001 },
        () => structuredClone(payload.countries[countryName].events[0])
      );
    },
    (payload) => {
      payload.sourcePublishedDates = Array.from(
        { length: 1001 },
        () => structuredClone(payload.sourcePublishedDates[0])
      );
    },
    (payload) => {
      payload.sourcePublishedDates[0].changes.addedCountries = Array.from(
        { length: 501 },
        () => ({ country: 'Example', nameZh: '示例' })
      );
    }
  ]) {
    const payload = structuredClone(history);
    mutate(payload);
    assert.throws(() => validateHistoryPayload(payload));
  }
});

test('enforces coherent stale and fallback exchange-rate metadata', async () => {
  const { prices } = await productionFixtures();
  const validVariants = [
    (payload) => {
      payload.fx.sourceUrl = 'https://open.er-api.com/v6/latest/USD';
      payload.fx.sourceMode = 'open-access';
      payload.fx.fallbackUsed = true;
      payload.fx.fallbackReason = 'request-failed';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackUsed = false;
      payload.fx.fallbackReason = 'request-failed';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackUsed = true;
      payload.fx.fallbackReason = 'source-unavailable';
    }
  ];
  for (const mutate of validVariants) {
    const payload = structuredClone(prices);
    mutate(payload);
    assert.doesNotThrow(() => validatePricePayload(payload));
    assert.doesNotThrow(() => validateExistingPrices(payload));
  }

  const invalidVariants = [
    (payload) => { payload.fx.fallbackReason = 'request-failed'; },
    (payload) => { payload.fx.fallbackUsed = true; },
    (payload) => {
      payload.fx.fallbackUsed = true;
      payload.fx.fallbackReason = 'request-failed';
    },
    (payload) => { payload.fx.stale = true; },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackReason = '';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackReason = 'invalid-key';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackReason = 'quota-reached';
    }
  ];
  for (const mutate of invalidVariants) {
    const payload = structuredClone(prices);
    // Keep the baseline on the authenticated source so fallbackUsed=true is
    // unambiguously invalid regardless of which live FX source refreshed the fixture.
    payload.fx.sourceUrl = 'https://v6.exchangerate-api.com/v6/latest/USD';
    payload.fx.sourceMode = 'api-key';
    mutate(payload);
    assert.throws(() => validatePricePayload(payload), /unexpected or invalid fields/);
    assert.throws(() => validateExistingPrices(payload));
  }
  assert.equal(publicFxFallbackReason('invalid-key'), 'source-unavailable');
  assert.equal(publicFxFallbackReason('quota-reached'), 'source-unavailable');
  assert.equal(publicFxFallbackReason('missing-rates'), 'missing-rates');
  assert.equal(publicFxFallbackReason(null), null);
});

test('requires complete two-decimal derived CNY prices in the public schema', async () => {
  const { prices } = await productionFixtures();
  const tierId = prices.tiers[0].id;
  for (const invalidValue of [undefined, 0, -1, Number.NaN, 1.234, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = structuredClone(prices);
    if (invalidValue === undefined) delete payload.countries[0].plans[tierId].cnyPrice;
    else payload.countries[0].plans[tierId].cnyPrice = invalidValue;
    assert.throws(() => validatePricePayload(payload));
    assert.throws(() => validateExistingPrices(payload));
  }
});

test('keeps legacy schema readable only for updater migration, never for the browser', async () => {
  const { prices } = await productionFixtures();
  const legacy = structuredClone(prices);
  legacy.schemaVersion = 2;
  delete legacy.fx.derivedCurrency;
  legacy.fx.apiKeyStatus = 'valid';
  legacy.fx.rates = Object.fromEntries(
    [...new Set(['USD', 'CNY', ...legacy.countries.map(({ currency }) => currency)])]
      .sort()
      .map((currency) => [currency, currency === 'USD' ? 1 : 1.5])
  );
  for (const country of legacy.countries) {
    for (const plan of Object.values(country.plans)) delete plan.cnyPrice;
  }
  assert.doesNotThrow(() => validatePricePayload(legacy));
  assert.doesNotThrow(() => validateExistingPrices(legacy));
  assert.throws(() => validatePayload('prices.json', legacy), /current public schema/);
});

test('keeps legacy history readable only for updater migration and binds current history to prices', async () => {
  const { prices, history } = await productionFixtures();
  const legacy = structuredClone(history);
  legacy.schemaVersion = 1;
  delete legacy.updatedAt;
  assert.doesNotThrow(() => validateHistoryPayload(legacy));
  assert.doesNotThrow(() => validateExistingHistory(legacy, prices));
  assert.throws(() => validatePayload('history.json', legacy), /current public schema/);

  const mismatched = structuredClone(history);
  mismatched.updatedAt = new Date(Date.parse(prices.generatedAt) - 1).toISOString();
  assert.doesNotThrow(() => validateHistoryPayload(mismatched));
  assert.throws(() => validatePriceHistoryConsistency(prices, mismatched), /different update timestamps/);
  assert.throws(() => validateExistingHistory(mismatched, prices), /different update timestamps/);
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

test('accepts a metadata-only country change without synthetic tier changes', async () => {
  const { prices, history } = await productionFixtures();
  const payload = structuredClone(history);
  const change = payload.sourcePublishedDates
    .flatMap((entry) => entry.changes?.changedCountries ?? [])[0];
  assert.ok(change, 'production history must include a changed-country fixture');
  change.tiers = [];
  change.toRegion = `${change.fromRegion} (renamed)`;
  assert.doesNotThrow(() => validateHistoryPayload(payload));
  assert.doesNotThrow(() => validateExistingHistory(payload, prices));
});

test('rejects every unexpected field in public history evidence', async () => {
  const { prices, history } = await productionFixtures();
  const firstRecord = (payload) => Object.values(payload.countries)[0];
  const firstPublicationWithAddedCountry = (payload) => payload.sourcePublishedDates
    .find((entry) => entry.changes?.addedCountries?.length);
  const firstPublicationWithRemovedCountry = (payload) => payload.sourcePublishedDates
    .find((entry) => entry.changes?.removedCountries?.length);
  const firstChangedCountry = (payload) => payload.sourcePublishedDates
    .flatMap((entry) => entry.changes?.changedCountries ?? [])[0];
  const mutations = [
    (payload) => { payload.debug = true; },
    (payload) => { firstRecord(payload).debug = true; },
    (payload) => { firstRecord(payload).events[0].rawSource = '<html>'; },
    (payload) => { payload.sourcePublishedDates[0].debug = true; },
    (payload) => { payload.sourcePublishedDates[0].changes.debug = true; },
    (payload) => {
      payload.sourcePublishedDates[0].changes.addedTiers.push({ id: '50GB', label: '50 GB', debug: true });
    },
    (payload) => {
      payload.sourcePublishedDates[0].changes.removedTiers.push({ id: '50GB', label: '50 GB', debug: true });
    },
    (payload) => { firstPublicationWithAddedCountry(payload).changes.addedCountries[0].debug = true; },
    (payload) => { firstPublicationWithRemovedCountry(payload).changes.removedCountries[0].debug = true; },
    (payload) => { firstChangedCountry(payload).debug = true; },
    (payload) => { firstChangedCountry(payload).tiers[0].debug = true; }
  ];

  for (const mutate of mutations) {
    const payload = structuredClone(history);
    mutate(payload);
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
