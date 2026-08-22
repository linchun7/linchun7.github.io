import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePricePayload } from '../data-contract.js';
import { validateExistingPrices } from '../scripts/update-prices.mjs';
import { canonicalPriceStateFixture } from './helpers/canonical-price-state-fixture.mjs';

function validateBoth(payload) {
  assert.doesNotThrow(() => validatePricePayload(payload));
  assert.doesNotThrow(() => validateExistingPrices(payload));
}

function rejectBoth(payload) {
  assert.throws(() => validatePricePayload(payload));
  assert.throws(() => validateExistingPrices(payload));
}

test('canonical price state fixture stays valid independently of live production state', async () => {
  const payload = await canonicalPriceStateFixture();
  assert.equal(payload.source.parser, 'cross-checked');
  assert.equal(payload.fx.sourceMode, 'api-key');
  assert.equal(payload.fx.fallbackUsed, false);
  assert.equal(payload.fx.fallbackReason, null);
  assert.equal(payload.fx.stale, false);
  validateBoth(payload);
});

test('validates FX fallback and stale state transitions from a canonical baseline', async () => {
  const baseline = await canonicalPriceStateFixture();
  const validVariants = [
    (payload) => {
      payload.fx.sourceUrl = 'https://open.er-api.com/v6/latest/USD';
      payload.fx.sourceMode = 'open-access';
      payload.fx.fallbackUsed = true;
      payload.fx.fallbackReason = 'request-failed';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackReason = 'request-failed';
    },
    (payload) => {
      payload.fx.stale = true;
      payload.fx.fallbackUsed = true;
      payload.fx.fallbackReason = 'source-unavailable';
    }
  ];

  for (const mutate of validVariants) {
    const payload = structuredClone(baseline);
    mutate(payload);
    validateBoth(payload);
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
    const payload = structuredClone(baseline);
    mutate(payload);
    rejectBoth(payload);
  }
});

test('validates parser state independently of the committed production parser metadata', async () => {
  const baseline = await canonicalPriceStateFixture();
  for (const parser of ['document-order', 'apple-markers-fallback']) {
    const payload = structuredClone(baseline);
    payload.source.parser = parser;
    payload.source.parserStatus = 'only one parser succeeded';
    rejectBoth(payload);
  }
});

test('validates FX timestamp boundaries relative to the canonical generatedAt state', async () => {
  const baseline = await canonicalPriceStateFixture();
  const generatedAtMs = Date.parse(baseline.generatedAt);

  const future = structuredClone(baseline);
  future.fx.fetchedAt = new Date(generatedAtMs + (5 * 60 * 1_000) + 1).toISOString();
  rejectBoth(future);

  const tooOld = structuredClone(baseline);
  tooOld.fx.fetchedAt = new Date(generatedAtMs - (36 * 60 * 60 * 1_000) - (5 * 60 * 1_000) - 1).toISOString();
  rejectBoth(tooOld);
});
