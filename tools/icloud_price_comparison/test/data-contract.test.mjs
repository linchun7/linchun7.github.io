import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateHistoryPayload, validatePricePayload } from '../data-contract.js';
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
