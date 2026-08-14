import { appendFile, link, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder, TextEncoder } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  getMissingExchangeRates,
  parseApplePrices,
  validatePriceChangeAnomalies,
  validatePrices
} from './parse-prices.mjs';
import {
  publicFxFallbackReason,
  validateHistoryPayload,
  validatePriceHistoryConsistency,
  validatePricePayload
} from '../data-contract.js';
import { describeTriggerSource, formatBeijingDate, resolveTriggerSource } from './run-context.mjs';
import { attachMarketIdentity, validateMarketRegistry } from './market-registry.mjs';

const APPLE_URL = 'https://support.apple.com/en-us/108047';
const FX_AUTH_URL = 'https://v6.exchangerate-api.com/v6/latest/USD';
const FX_OPEN_URL = 'https://open.er-api.com/v6/latest/USD';
const ALLOWED_FX_SOURCE_URLS = new Set([FX_AUTH_URL, FX_OPEN_URL]);
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DATA_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const RUN_LOG_PATH = path.join(PROJECT_DIR, 'data/run-log.json');
const APPLE_SNAPSHOTS_DIR = path.join(PROJECT_DIR, 'data/apple-snapshots');
const APPLE_SNAPSHOT_INDEX_PATH = path.join(APPLE_SNAPSHOTS_DIR, 'index.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const DIAGNOSTICS_DIR = path.join(PROJECT_DIR, 'artifacts');
const RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000];
const REQUEST_TIMEOUT_MS = 45_000;
const NETWORK_BUDGET_MS = 5 * 60 * 1_000;
const MAX_APPLE_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_FX_RESPONSE_BYTES = 1024 * 1024;
const FX_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const FX_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const CNY_RANK_EPSILON = 1e-9;
export const MIN_FX_SANITY_POINTS = 3;
export const FX_SANITY_MAX_DAILY_CHANGE = 0.12;
const FX_SANITY_MAX_BASELINE_AGE_DAYS = 7;
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1_000;
const TEMPORARY_FILE_PATTERN = /\.tmp-\d+-\d+-[a-z0-9]+$/i;
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_MAPPING_TEXT_PATTERN = /[\0-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/u;
const PUBLIC_RUN_LOG_ENTRY_KEYS = ['schemaVersion', 'id', 'status', 'trigger', 'automaticRunDateBeijing', 'startedAtUtc', 'finishedAtUtc', 'durationMs', 'observedAtBeijing', 'source', 'counts', 'changes'];
const PUBLIC_RUN_LOG_SOURCE_KEYS = ['appleUrl', 'applePublishedDate', 'appleParser', 'appleParserStatus', 'exchangeRatesFetchedAtUtc', 'exchangeRatesStale', 'exchangeRatesSourceMode', 'exchangeRatesFallbackUsed', 'exchangeRatesFallbackReason'];
const PUBLIC_RUN_LOG_COUNT_KEYS = ['countries', 'pricePoints', 'currencies', 'tiers'];
const PUBLIC_RUN_LOG_CHANGE_KEYS = ['publishedDate', 'addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries'];
const DRY_RUN = process.argv.includes('--dry-run');
let lastAppleSnapshot = null;
let runStartedAt = new Date();

function transientHealthcheckError(message, { code = null, cause = null } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  if (code) error.code = code;
  error.healthcheckSeverity = 'transient';
  return error;
}

function appleConfirmationUnavailableError(cause) {
  return transientHealthcheckError(
    'Apple semantic-change confirmation is temporarily unavailable; stable data was preserved and the next run must retry',
    { code: 'APPLE_CONFIRMATION_UNAVAILABLE', cause }
  );
}

function appleConfirmationMismatchError(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'APPLE_CONFIRMATION_MISMATCH';
  return error;
}

export function classifyHealthcheckFailure(error) {
  return error?.healthcheckSeverity === 'transient' ? 'transient' : 'severe';
}

export function defaultUpdateLockPath(currentDataPath = CURRENT_DATA_PATH) {
  return path.join(path.dirname(path.dirname(currentDataPath)), '.icloud-price-update.lock');
}

export function defaultUpdateTransactionPath(currentDataPath = CURRENT_DATA_PATH) {
  return path.join(path.dirname(currentDataPath), '.icloud-price-update-transaction.json');
}

export function createNetworkBudget({
  budgetMs = NETWORK_BUDGET_MS,
  now = () => performance.now(),
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  createTimeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs)
} = {}) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Network budget must be a positive duration');
  if (typeof now !== 'function' || typeof sleep !== 'function' || typeof createTimeoutSignal !== 'function') {
    throw new Error('Network budget dependencies are invalid');
  }
  return { deadlineAt: now() + budgetMs, now, sleep, createTimeoutSignal };
}

function networkDeadlineError(resourceName) {
  return transientHealthcheckError(`Network deadline exceeded while fetching ${resourceName}`, {
    code: 'NETWORK_DEADLINE_EXCEEDED'
  });
}

function remainingNetworkBudget(networkBudget) {
  return Math.max(0, networkBudget.deadlineAt - networkBudget.now());
}

async function readBoundedResponseText(response, maxResponseBytes, resourceName) {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error('Response byte limit must be a positive safe integer');
  }

  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader != null && /^\d+$/.test(contentLengthHeader.trim())) {
    const declaredBytes = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maxResponseBytes) {
      throw new Error(`${resourceName} response exceeds ${maxResponseBytes} bytes`);
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxResponseBytes) {
      throw new Error(`${resourceName} response exceeds ${maxResponseBytes} bytes`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let receivedBytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxResponseBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`${resourceName} response exceeds ${maxResponseBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchResource(url, {
  json = false,
  attempts = RETRY_DELAYS_MS.length,
  cache,
  headers = {},
  resourceName = url,
  retryDelaysMs = RETRY_DELAYS_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = json ? MAX_FX_RESPONSE_BYTES : MAX_APPLE_RESPONSE_BYTES,
  networkBudget = createNetworkBudget()
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let remainingMs = remainingNetworkBudget(networkBudget);
    if (remainingMs <= 0) {
      lastError = networkDeadlineError(resourceName);
      break;
    }
    const delay = retryDelaysMs[attempt - 1] ?? retryDelaysMs.at(-1) ?? 0;
    if (delay) {
      const boundedDelay = Math.min(delay, remainingMs);
      await networkBudget.sleep(boundedDelay);
      remainingMs = remainingNetworkBudget(networkBudget);
      if (boundedDelay < delay || remainingMs <= 0) {
        lastError = networkDeadlineError(resourceName);
        break;
      }
    }
    try {
      const timeoutMs = Math.max(1, Math.min(requestTimeoutMs, remainingMs));
      const response = await fetch(url, {
        ...(cache ? { cache } : {}),
        headers: {
          accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': attempt === 1 ? 'max-age=0' : 'no-cache',
          'user-agent': 'Mozilla/5.0 (compatible; iCloud-Price-Comparison/2.0; +https://github.com/linchun7/linchun7.github.io)',
          ...headers
        },
        redirect: 'error',
        signal: networkBudget.createTimeoutSignal(timeoutMs)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = await readBoundedResponseText(response, maxResponseBytes, resourceName);
      if (!json && (body.length < 20_000 || !/50\s*GB/i.test(body))) {
        throw new Error(`Unexpected Apple response (${body.length} bytes)`);
      }
      return json ? JSON.parse(body) : body;
    } catch (error) {
      lastError = error;
      console.warn(`Fetch attempt ${attempt}/${attempts} failed for ${resourceName}: ${logInline(error.message)}`);
      if (remainingNetworkBudget(networkBudget) <= 0) {
        lastError = networkDeadlineError(resourceName);
        break;
      }
    }
  }
  if (lastError?.code === 'NETWORK_DEADLINE_EXCEEDED') throw lastError;
  throw transientHealthcheckError(`Failed to fetch ${resourceName}: ${lastError?.message}`, {
    code: 'NETWORK_FETCH_FAILED',
    cause: lastError
  });
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read valid JSON from ${path.basename(filePath)}: ${error.message}`);
  }
}

function exchangeRateError(message, reason = 'invalid-response') {
  const error = new Error(message);
  error.fxReason = reason;
  return error;
}

function fxSanityError(message) {
  const error = new Error(message);
  error.code = 'FX_SANITY_FAILURE';
  return error;
}

function parseExchangeRatePayload(payload, ratesField) {
  const serviceError = typeof payload?.['error-type'] === 'string' ? payload['error-type'] : null;
  if (payload?.result !== 'success') {
    throw exchangeRateError(
      serviceError ? `Exchange-rate service returned ${serviceError}` : 'Exchange-rate response is missing required fields',
      serviceError ?? 'invalid-response'
    );
  }
  const rates = payload?.[ratesField];
  if (payload.base_code !== 'USD'
    || !Number.isFinite(payload.time_last_update_unix)
    || payload.time_last_update_unix <= 0
    || rates?.USD !== 1
    || !Number.isFinite(rates?.CNY)
    || rates.CNY <= 0) {
    throw exchangeRateError('Exchange-rate response is missing required fields');
  }
  return {
    fetchedAt: new Date(payload.time_last_update_unix * 1000).toISOString(),
    rates
  };
}

export function selectRequiredRates(rates, requiredCurrencies = []) {
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    throw exchangeRateError('Exchange-rate response has an unsupported rates structure');
  }
  const currencies = [...new Set(['USD', 'CNY', ...requiredCurrencies])].sort();
  const selected = {};
  for (const currency of currencies) {
    const rate = rates[currency];
    if (!Number.isFinite(rate) || rate <= 0) {
      throw exchangeRateError(`Exchange rates are missing for: ${currency}`, 'missing-rates');
    }
    selected[currency] = rate;
  }
  return selected;
}

function median(values) {
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function validateFxSanity(previousData, fx, {
  now = new Date(),
  currentCurrencies = Object.keys(fx?.rates ?? {}),
  minPoints = MIN_FX_SANITY_POINTS,
  maxDailyChange = FX_SANITY_MAX_DAILY_CHANGE,
  maxBaselineAgeDays = FX_SANITY_MAX_BASELINE_AGE_DAYS
} = {}) {
  const warnings = [];
  const checks = [];
  const previousGeneratedAtMs = Date.parse(previousData?.generatedAt);
  const nowMs = now instanceof Date ? now.getTime() : Number.NaN;
  if (!previousData || !Number.isFinite(previousGeneratedAtMs) || !Number.isFinite(nowMs)) {
    warnings.push('FX_SANITY_SKIPPED_NO_BASELINE');
    return { status: 'skipped', warnings, checks };
  }

  const elapsedHours = Math.max(0, nowMs - previousGeneratedAtMs) / (60 * 60 * 1_000);
  if (elapsedHours > maxBaselineAgeDays * 24) {
    warnings.push('FX_SANITY_SKIPPED_OLD_BASELINE');
    return { status: 'skipped', warnings, checks };
  }
  if (fx?.stale || !fx?.rates) {
    warnings.push('FX_SANITY_SKIPPED_NO_CURRENT_RATES');
    return { status: 'skipped', warnings, checks };
  }

  const pointsByCurrency = new Map();
  for (const country of previousData.countries ?? []) {
    if (country.currency === 'CNY') continue;
    const points = pointsByCurrency.get(country.currency) ?? [];
    for (const plan of Object.values(country.plans ?? {})) {
      if (Number.isFinite(plan?.price) && plan.price > 0
        && Number.isFinite(plan.cnyPrice) && plan.cnyPrice > 0) {
        points.push(plan.cnyPrice / plan.price);
      }
    }
    pointsByCurrency.set(country.currency, points);
  }

  const days = Math.min(Math.max(1, elapsedHours / 24), maxBaselineAgeDays);
  const previousCurrencies = new Set((previousData.countries ?? []).map(({ currency }) => currency));
  const activeCurrencies = new Set(currentCurrencies);
  for (const currency of previousCurrencies) {
    if (currency !== 'CNY' && !activeCurrencies.has(currency)) {
      warnings.push(`FX_SANITY_SKIPPED_REMOVED_CURRENCY:${currency}`);
    }
  }
  const currencies = [...activeCurrencies].sort();
  for (const currency of currencies) {
    if (currency === 'CNY') {
      checks.push({ currency, status: 'skipped-cny' });
      continue;
    }
    if (!previousCurrencies.has(currency)) {
      checks.push({ currency, status: 'skipped-new-currency' });
      continue;
    }
    const points = pointsByCurrency.get(currency) ?? [];
    if (points.length < minPoints) {
      warnings.push(`FX_SANITY_SKIPPED_INSUFFICIENT_POINTS:${currency}:${points.length}`);
      checks.push({ currency, status: 'skipped-insufficient-points', points: points.length });
      continue;
    }
    const currentCurrencyRate = fx.rates[currency];
    const currentCnyRate = fx.rates.CNY;
    if (!Number.isFinite(currentCurrencyRate) || currentCurrencyRate <= 0
      || !Number.isFinite(currentCnyRate) || currentCnyRate <= 0) {
      throw fxSanityError(`FX sanity cannot calculate a current CNY/${currency} rate`);
    }
    const previousRate = median(points);
    const currentRate = currentCnyRate / currentCurrencyRate;
    const symmetricRatio = Math.max(currentRate / previousRate, previousRate / currentRate);
    const dailyizedChange = Math.pow(symmetricRatio, 1 / days) - 1;
    if (!Number.isFinite(dailyizedChange) || dailyizedChange > maxDailyChange) {
      throw fxSanityError(
        `FX sanity failed for ${currency}: dailyized symmetric change ${(dailyizedChange * 100).toFixed(2)}% exceeds ${(maxDailyChange * 100).toFixed(2)}%`
      );
    }
    checks.push({ currency, status: 'passed', points: points.length, previousRate, currentRate, dailyizedChange });
  }
  return { status: 'passed', warnings, checks };
}

function validateExchangeRateFreshness(fetchedAt, now = new Date()) {
  const fetchedAtMs = Date.parse(fetchedAt);
  const nowMs = now.getTime();
  if (!Number.isFinite(fetchedAtMs) || !Number.isFinite(nowMs)) {
    throw exchangeRateError('Exchange-rate timestamp is invalid', 'invalid-timestamp');
  }
  if (fetchedAtMs > nowMs + FX_MAX_FUTURE_SKEW_MS) {
    throw exchangeRateError('Exchange-rate timestamp is in the future', 'future-timestamp');
  }
  if (nowMs - fetchedAtMs > FX_MAX_AGE_MS) {
    throw exchangeRateError('Exchange-rate response is too old', 'stale-response');
  }
}

async function readJsonWithExistence(filePath, fallback = null) {
  try {
    const text = await readFile(filePath, 'utf8');
    return { value: JSON.parse(text), existed: true, text };
  } catch (error) {
    if (error.code === 'ENOENT') return { value: fallback, existed: false, text: null };
    throw new Error(`Unable to read valid JSON from ${path.basename(filePath)}: ${error.message}`);
  }
}

export async function getExchangeRates(previousData, {
  apiKey = process.env.EXCHANGE_RATE_API_KEY,
  requiredCurrencies = [],
  networkBudget = createNetworkBudget()
} = {}) {
  const normalizedApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const sources = [];
  if (normalizedApiKey) {
    sources.push({
      url: FX_AUTH_URL,
      resourceName: 'ExchangeRate-API authenticated endpoint',
      headers: { authorization: `Bearer ${normalizedApiKey}` },
      ratesField: 'conversion_rates',
      sourceMode: 'api-key',
      attempts: 2
    });
  }
  sources.push({
    url: FX_OPEN_URL,
    resourceName: 'ExchangeRate-API open endpoint',
    headers: {},
    ratesField: 'rates',
    sourceMode: 'open-access',
    attempts: 3
  });

  const failures = [];
  for (const source of sources) {
    try {
      const payload = await fetchResource(source.url, {
        json: true,
        attempts: source.attempts,
        headers: source.headers,
        resourceName: source.resourceName,
        networkBudget
      });
      const parsed = parseExchangeRatePayload(payload, source.ratesField);
      validateExchangeRateFreshness(parsed.fetchedAt);
      const missingRequiredRates = requiredCurrencies.filter(
        (currency) => !Number.isFinite(parsed.rates[currency]) || parsed.rates[currency] <= 0
      );
      if (missingRequiredRates.length) {
        throw exchangeRateError(
          `Exchange rates are missing for: ${missingRequiredRates.join(', ')}`,
          'missing-rates'
        );
      }
      const fallbackUsed = Boolean(normalizedApiKey && source.sourceMode === 'open-access');
      const fallbackReason = fallbackUsed ? failures[0]?.reason ?? 'request-failed' : null;
      const apiKeyStatus = normalizedApiKey
        ? (source.sourceMode === 'api-key' ? 'valid' : fallbackReason)
        : 'not-configured';
      if (fallbackUsed) {
        console.info('认证汇率来源不可用，已使用开放接口。');
      }
      return {
        sourceUrl: source.url,
        sourceMode: source.sourceMode,
        fallbackUsed,
        fallbackReason,
        apiKeyStatus,
        base: 'USD',
        fetchedAt: parsed.fetchedAt,
        stale: false,
        reusePreviousCny: false,
        rates: selectRequiredRates(parsed.rates, requiredCurrencies)
      };
    } catch (error) {
      failures.push({
        sourceMode: source.sourceMode,
        reason: error.fxReason ?? 'request-failed',
        message: error.message
      });
    }
  }

  const failureMessage = failures.map(({ sourceMode, message }) => `${sourceMode}: ${message}`).join('; ');
  try {
    validateExchangeRateFreshness(previousData?.fx?.fetchedAt);
  } catch (error) {
    throw transientHealthcheckError(`${failureMessage}; previous exchange-rate-derived prices are unusable: ${error.message}`, {
      code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE',
      cause: error
    });
  }

  const previousRates = previousData?.fx?.rates;
  if (previousRates?.USD === 1 && Number.isFinite(previousRates.CNY) && previousRates.CNY > 0) {
    const missingPreviousRates = requiredCurrencies.filter(
      (currency) => !Number.isFinite(previousRates[currency]) || previousRates[currency] <= 0
    );
    if (missingPreviousRates.length) {
      throw transientHealthcheckError(
        `${failureMessage}; previous exchange rates are missing for: ${missingPreviousRates.join(', ')}`,
        { code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE' }
      );
    }
    console.warn(`Exchange-rate update failed; keeping previous rates: ${logInline(failureMessage)}`);
    return {
      ...previousData.fx,
      stale: true,
      fallbackUsed: Boolean(normalizedApiKey),
      fallbackReason: failures[0]?.reason ?? 'request-failed',
      apiKeyStatus: normalizedApiKey ? failures[0]?.reason ?? 'request-failed' : 'not-configured',
      reusePreviousCny: false,
      rates: selectRequiredRates(previousRates, requiredCurrencies)
    };
  }

  if (previousData?.schemaVersion >= 3 && previousData.fx?.derivedCurrency === 'CNY') {
    console.warn(`Exchange-rate update failed; keeping previous derived CNY prices: ${logInline(failureMessage)}`);
    return {
      ...previousData.fx,
      stale: true,
      fallbackUsed: Boolean(normalizedApiKey),
      fallbackReason: failures[0]?.reason ?? 'request-failed',
      apiKeyStatus: normalizedApiKey ? failures[0]?.reason ?? 'request-failed' : 'not-configured',
      reusePreviousCny: true,
      rates: null
    };
  }

  throw transientHealthcheckError(failureMessage || 'Exchange-rate update failed', {
    code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE'
  });
}

function roundDerivedCnyPrice(value) {
  return Number(value.toFixed(2));
}

function convertToFullPrecisionCny(price, currency, rates) {
  const currencyRate = rates?.[currency];
  const cnyRate = rates?.CNY;
  if (!Number.isFinite(currencyRate) || currencyRate <= 0 || !Number.isFinite(cnyRate) || cnyRate <= 0) return null;
  return (price / currencyRate) * cnyRate;
}

export function attachDerivedCnyPrices(countries, { fx, previousData = null } = {}) {
  const previousByMarket = new Map((previousData?.countries ?? []).map((country) => [country.marketId, country]));
  if (fx?.reusePreviousCny) {
    return countries.map((country) => {
      const previousCountry = country.marketId ? previousByMarket.get(country.marketId) : null;
      if (!previousCountry || previousCountry.currency !== country.currency) {
        throw transientHealthcheckError(
          `Cannot reuse CNY prices for ${country.country}: stable marketId and currency must match`,
          { code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE' }
        );
      }
      return {
        ...country,
        plans: Object.fromEntries(Object.entries(country.plans).map(([tierId, plan]) => {
          const previousPlan = previousCountry.plans?.[tierId];
          if (previousPlan?.price !== plan.price
            || !Number.isFinite(previousPlan.cnyPrice) || previousPlan.cnyPrice <= 0
            || !Number.isSafeInteger(previousPlan.cnyRank) || previousPlan.cnyRank <= 0
            || previousPlan.cnyRank > previousData.countries.length) {
            throw transientHealthcheckError(
              `Cannot reuse ${tierId} CNY price and rank for ${country.country} while exchange-rate sources are unavailable`,
              { code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE' }
            );
          }
          return [tierId, {
            ...plan,
            cnyPrice: previousPlan.cnyPrice,
            cnyRank: previousPlan.cnyRank
          }];
        }))
      };
    });
  }
  const ranked = countries.map((country) => ({
    ...country,
    plans: Object.fromEntries(Object.entries(country.plans).map(([tierId, plan]) => {
      let fullPrecisionCnyPrice = convertToFullPrecisionCny(plan.price, country.currency, fx?.rates);
      if (!Number.isFinite(fullPrecisionCnyPrice) || fullPrecisionCnyPrice <= 0) {
        throw transientHealthcheckError(
          `Cannot derive ${tierId} CNY price for ${country.country} while exchange-rate sources are unavailable`,
          { code: 'EXCHANGE_RATE_SOURCES_UNAVAILABLE' }
        );
      }
      return [tierId, {
        ...plan,
        cnyPrice: roundDerivedCnyPrice(fullPrecisionCnyPrice),
        fullPrecisionCnyPrice
      }];
    }))
  }));

  const tierIds = Object.keys(ranked[0]?.plans ?? {});
  for (const tierId of tierIds) {
    const ordered = [...ranked].sort((first, second) => (
      first.plans[tierId].fullPrecisionCnyPrice - second.plans[tierId].fullPrecisionCnyPrice
      || String(first.marketId ?? first.country).localeCompare(String(second.marketId ?? second.country), 'en')
    ));
    let rank = 0;
    let previousPrice = null;
    for (const country of ordered) {
      const price = country.plans[tierId].fullPrecisionCnyPrice;
      if (previousPrice === null || Math.abs(price - previousPrice) > CNY_RANK_EPSILON) {
        rank += 1;
        previousPrice = price;
      }
      country.plans[tierId].cnyRank = rank;
    }
  }

  return ranked.map((country) => ({
    ...country,
    plans: Object.fromEntries(Object.entries(country.plans).map(([tierId, plan]) => {
      const { fullPrecisionCnyPrice: _internal, ...publicPlan } = plan;
      return [tierId, publicPlan];
    }))
  }));
}

export function publicExchangeRateMetadata(fx) {
  return {
    sourceUrl: fx.sourceUrl,
    sourceMode: fx.sourceMode,
    fallbackUsed: fx.fallbackUsed,
    fallbackReason: publicFxFallbackReason(fx.fallbackReason),
    base: fx.base,
    fetchedAt: fx.fetchedAt,
    stale: fx.stale,
    derivedCurrency: 'CNY'
  };
}

function formatBeijingDateTime(value) {
  if (!value) return 'unknown';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value));
}

export function logInline(value, maxCodePoints = 2_000) {
  const codePoints = [...String(value)];
  const bounded = codePoints.length > maxCodePoints
    ? `${codePoints.slice(0, maxCodePoints).join('')}…`
    : codePoints.join('');
  return bounded
    .replace(/[\0-\x1f\x7f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff\ufffd]+/gu, ' ')
    .replaceAll('::', ': :');
}

function markdownInline(value, maxCodePoints = 1_000) {
  return logInline(value, maxCodePoints)
    .replaceAll('\\', '\\\\')
    .replace(/([`*_{}\[\]()#+.!|<>])/g, '\\$1');
}

function snapshotPlans(country, tiers) {
  return Object.fromEntries(tiers.map(({ id }) => [id, country.plans[id].price]));
}

function hasPriceChange(previousEvent, country, tiers) {
  if (!previousEvent || previousEvent.currency !== country.currency) return true;
  const currentTierIds = tiers.map(({ id }) => id).sort();
  const previousTierIds = Object.keys(previousEvent.plans).sort();
  if (currentTierIds.length !== previousTierIds.length
    || currentTierIds.some((id, index) => id !== previousTierIds[index])) return true;
  return tiers.some(({ id }) => previousEvent.plans[id] !== country.plans[id].price);
}

function assertSafeHistoryCountryKey(country) {
  if (['__proto__', 'prototype', 'constructor'].includes(country)) {
    throw new Error(`Unsafe country key in price history: ${country}`);
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isSafeMappingText(value) {
  return typeof value === 'string'
    && value.length <= 160
    && Boolean(value.trim())
    && !FORBIDDEN_MAPPING_TEXT_PATTERN.test(value)
    && !hasUnpairedSurrogate(value);
}

export function validateCountryNameMapping(mapping) {
  if (!isPlainObject(mapping)) throw new Error('Chinese country-name mapping has an unsupported structure');
  const entries = Object.entries(mapping);
  if (entries.length < 60 || entries.length > 500) {
    throw new Error('Chinese country-name mapping is missing, incomplete, or oversized');
  }
  for (const [country, displayName] of entries) {
    if (UNSAFE_OBJECT_KEYS.has(country) || !isSafeMappingText(country) || !isSafeMappingText(displayName)) {
      throw new Error(`Chinese country-name mapping has an unsafe entry: ${logInline(country)}`);
    }
  }
  return mapping;
}

export function updateHistory(previousHistory, countries, observedAt, tiers, observedAtUtc = null) {
  const history = previousHistory ?? { schemaVersion: 4, markets: {} };
  const usesMarketIds = history.schemaVersion === 4;
  const targetSchemaVersion = usesMarketIds ? 4 : 2;
  const records = usesMarketIds ? history.markets : history.countries;
  if (!isPlainObject(history) || !isPlainObject(records)) {
    throw new Error('Price history has an unsupported market structure');
  }
  if (observedAtUtc !== null && !isIsoDateTime(observedAtUtc)) {
    throw new Error('Price history UTC observation timestamp is invalid');
  }
  let changed = history.schemaVersion !== targetSchemaVersion;
  history.schemaVersion = targetSchemaVersion;
  let changedCountries = 0;

  for (const country of countries) {
    const recordKey = usesMarketIds ? country.marketId : country.country;
    assertSafeHistoryCountryKey(recordKey);
    if (usesMarketIds && (typeof recordKey !== 'string' || !recordKey)) {
      throw new Error(`Price history is missing marketId for ${country.country}`);
    }
    const existingRecord = Object.hasOwn(records, recordKey) ? records[recordKey] : null;
    if (!existingRecord
      || (usesMarketIds && existingRecord.country !== country.country)
      || existingRecord?.nameZh !== country.nameZh
      || existingRecord?.region !== country.region) changed = true;
    const record = existingRecord ?? {
      ...(usesMarketIds ? { country: country.country } : {}),
      nameZh: country.nameZh,
      region: country.region,
      events: []
    };
    if (usesMarketIds) record.country = country.country;
    record.nameZh = country.nameZh;
    record.region = country.region;

    const previousEvent = record.events.at(-1);
    const priceChanged = hasPriceChange(previousEvent, country, tiers);
    if (priceChanged && previousEvent?.observedAt && observedAt < previousEvent.observedAt) {
      throw new Error(`Price history observation date moved backwards for ${country.country}`);
    }
    if (priceChanged) {
      changed = true;
      changedCountries += 1;
      record.events.push({
        observedAt,
        ...(observedAtUtc ? { observedAtBeijing: observedAt } : {}),
        ...(observedAtUtc ? { observedAtUtc } : {}),
        currency: country.currency,
        plans: snapshotPlans(country, tiers)
      });
    }
    records[recordKey] = record;
  }
  if (changed) history.updatedAt = observedAtUtc ?? new Date().toISOString();
  return { history, changedCountries, changed };
}

export function publicationDateKey(value) {
  const text = String(value ?? '').trim().replace(/^published\s+date\s*:?\s*/i, '');
  const dateKey = (year, month, day) => {
    const date = new Date(Date.UTC(year, month, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month
      && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
      : null;
  };
  const englishDate = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (englishDate) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const month = monthNames.indexOf(englishDate[1].toLowerCase());
    if (month < 0) return `raw:${text}`;
    return dateKey(Number(englishDate[3]), month, Number(englishDate[2])) ?? `raw:${text}`;
  }
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return dateKey(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) ?? `raw:${text}`;
  }
  return `raw:${text}`;
}

function assertPublicationDateNotRegressed(previousPublishedDate, publishedDate) {
  const previousKey = publicationDateKey(previousPublishedDate);
  const currentKey = publicationDateKey(publishedDate);
  const validDateKey = /^\d{4}-\d{2}-\d{2}$/;
  if (validDateKey.test(previousKey) && validDateKey.test(currentKey) && currentKey < previousKey) {
    throw new Error(`Apple published date moved backwards from ${previousPublishedDate} to ${publishedDate}`);
  }
}

export function buildSnapshotChanges(previousData, countries, tiers) {
  const marketKey = (country) => country.marketId ?? country.country;
  const previousByCountry = new Map((previousData?.countries ?? []).map((country) => [marketKey(country), country]));
  const currentByCountry = new Map(countries.map((country) => [marketKey(country), country]));
  const previousTiers = previousData?.tiers ?? [];
  const previousTierIds = new Set(previousTiers.map(({ id }) => id));
  const currentTierIds = new Set(tiers.map(({ id }) => id));
  const addedTiers = tiers
    .filter(({ id }) => !previousTierIds.has(id))
    .map(({ id, label }) => ({ id, label }));
  const removedTiers = previousTiers
    .filter(({ id }) => !currentTierIds.has(id))
    .map(({ id, label }) => ({ id, label }));
  const comparableTiers = tiers.filter(({ id }) => previousTierIds.has(id));
  const addedCountries = countries
    .filter((country) => !previousByCountry.has(marketKey(country)))
    .map(({ country, nameZh }) => ({ country, nameZh }));
  const removedCountries = [...previousByCountry.values()]
    .filter((country) => !currentByCountry.has(marketKey(country)))
    .map(({ country, nameZh }) => ({ country, nameZh: nameZh || country }));
  const changedCountries = [];

  for (const country of countries) {
    const previous = previousByCountry.get(marketKey(country));
    if (!previous) continue;
    const tierChanges = comparableTiers
      .filter(({ id }) => previous.plans[id]?.price !== country.plans[id]?.price)
      .map(({ id }) => ({ id, from: previous.plans[id]?.price ?? null, to: country.plans[id]?.price ?? null }));
    if (previous.currency !== country.currency || previous.region !== country.region || tierChanges.length) {
      changedCountries.push({
        country: country.country,
        nameZh: country.nameZh || country.country,
        fromCurrency: previous.currency,
        toCurrency: country.currency,
        fromRegion: previous.region,
        toRegion: country.region,
        tiers: tierChanges
      });
    }
  }

  return { addedTiers, removedTiers, addedCountries, removedCountries, changedCountries };
}

export function updatePublishedDateHistory(history, previousData, publishedDate, observedAt, changes, observedAtUtc = null) {
  const entries = [];
  const existingEntries = history.sourcePublishedDates;
  const previousEntriesJson = JSON.stringify(existingEntries ?? null);
  if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
    throw new Error('Apple publication history has an invalid structure');
  }
  const seenPublicationDates = new Set();
  let previousObservedAt = '';
  for (const entry of (existingEntries ?? [])) {
    const publishedKey = publicationDateKey(entry?.publishedDate);
    if (!entry
      || typeof entry.publishedDate !== 'string'
      || typeof entry.observedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}$/.test(publishedKey)
      || !/^\d{4}-\d{2}-\d{2}$/.test(entry.observedAt)) {
      throw new Error('Apple publication history contains an invalid entry');
    }
    if (seenPublicationDates.has(publishedKey)) {
      throw new Error(`Apple publication history contains a duplicate date: ${entry.publishedDate}`);
    }
    if (entry.observedAt < previousObservedAt) {
      throw new Error('Apple publication history observation dates are not chronological');
    }
    seenPublicationDates.add(publishedKey);
    previousObservedAt = entry.observedAt;
    entries.push({
      ...entry,
      kind: entry.kind || (entries.length ? 'change' : 'initial'),
      changes: entry.changes ?? { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] }
    });
  }

  if (!entries.length && previousData?.source?.publishedDate) {
    entries.push({
      publishedDate: previousData.source.publishedDate,
      observedAt: previousData.generatedAt ? formatBeijingDate(previousData.generatedAt) : observedAt,
      ...(previousData.generatedAt ? { observedAtBeijing: formatBeijingDate(previousData.generatedAt), observedAtUtc: previousData.run?.finishedAtUtc ?? previousData.generatedAt } : {}),
      kind: 'initial',
      changes: { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] }
    });
  }

  if (!entries.length && publishedDate) {
    entries.push({
      publishedDate,
      observedAt,
      ...(observedAtUtc ? { observedAtBeijing: observedAt, observedAtUtc } : {}),
      kind: 'initial',
      changes: { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] }
    });
  }

  assertPublicationDateNotRegressed(entries.at(-1)?.publishedDate, publishedDate);
  let changed = false;
  if (publishedDate && publicationDateKey(entries.at(-1)?.publishedDate) !== publicationDateKey(publishedDate)) {
    if (entries.at(-1)?.observedAt && observedAt < entries.at(-1).observedAt) {
      throw new Error('Apple publication observation date moved backwards');
    }
    entries.push({
      publishedDate,
      observedAt,
      ...(observedAtUtc ? { observedAtBeijing: observedAt, observedAtUtc } : {}),
      kind: 'change',
      changes
    });
    changed = true;
  }
  history.sourcePublishedDates = entries;
  return { entries, changed, historyChanged: JSON.stringify(entries) !== previousEntriesJson };
}

async function writeTextAtomic(filePath, text) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporaryPath, text, 'utf8');
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlinkIfExists(temporaryPath);
    throw error;
  }
}

export async function writeJsonAtomic(filePath, value) {
  await writeTextAtomic(filePath, serializeJson(value));
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function snapshotFileSha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeTextExclusiveAtomic(filePath, text, onCreated = null) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporaryPath, text, { encoding: 'utf8', flag: 'wx' });
    onCreated?.(temporaryPath);
    await link(temporaryPath, filePath);
    onCreated?.(filePath);
  } finally {
    await unlinkIfExists(temporaryPath);
  }
}

function assertPublicationDateNotFuture(publishedDate, observedAt) {
  const publishedKey = publicationDateKey(publishedDate);
  const observedKey = publicationDateKey(observedAt);
  if (/^\d{4}-\d{2}-\d{2}$/.test(publishedKey)
    && /^\d{4}-\d{2}-\d{2}$/.test(observedKey)
    && publishedKey > observedKey) {
    throw new Error(`Apple published date is in the future: ${publishedDate}`);
  }
}

export function createRunLogEntry(data, summary, startedAt, finishedAt) {
  const orderedFinishedAt = finishedAt.getTime() < startedAt.getTime() ? new Date(startedAt) : finishedAt;
  const publishedDate = data.source.publishedDate ?? null;
  const trigger = resolveTriggerSource(
    process.env.GITHUB_EVENT_NAME,
    process.env.ICLOUD_TRIGGER_SOURCE
  );
  const previousPublishedDate = summary.publicationDateChanged
    ? summary.publishedDateHistory?.at(-2)?.publishedDate ?? null
    : publishedDate;
  return {
    schemaVersion: 1,
    id: orderedFinishedAt.toISOString(),
    status: 'success',
    trigger,
    automaticRunDateBeijing: process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING || null,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: orderedFinishedAt.toISOString(),
    durationMs: orderedFinishedAt.getTime() - startedAt.getTime(),
    observedAtBeijing: summary.observedAt,
    source: {
      appleUrl: data.source.url,
      applePublishedDate: data.source.publishedDate ?? null,
      appleParser: data.source.parser ?? null,
      appleParserStatus: data.source.parserStatus ?? null,
      exchangeRatesFetchedAtUtc: data.fx.fetchedAt ?? null,
      exchangeRatesStale: Boolean(data.fx.stale),
      exchangeRatesSourceMode: data.fx.sourceMode ?? null,
      exchangeRatesFallbackUsed: Boolean(data.fx.fallbackUsed),
      exchangeRatesFallbackReason: data.fx.fallbackReason ?? null
    },
    counts: {
      countries: data.countries.length,
      pricePoints: data.countries.length * data.tiers.length,
      currencies: new Set(data.countries.map(({ currency }) => currency)).size,
      tiers: data.tiers.map(({ id, label }) => ({ id, label }))
    },
    changes: {
      publishedDate: {
        changed: Boolean(summary.publicationDateChanged),
        from: previousPublishedDate,
        to: publishedDate
      },
      addedTiers: summary.publicationChanges.addedTiers,
      removedTiers: summary.publicationChanges.removedTiers,
      addedCountries: summary.publicationChanges.addedCountries,
      removedCountries: summary.publicationChanges.removedCountries,
      changedCountries: summary.publicationChanges.changedCountries.map(({ country, nameZh, fromCurrency, toCurrency, fromRegion, toRegion, tiers }) => ({
        country, nameZh, fromCurrency, toCurrency, fromRegion, toRegion, tiers
      }))
    }
  };
}

function pickPublicFields(value, fields) {
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(value, field))
    .map((field) => [field, value[field]]));
}

function sanitizeListedTiers(tiers) {
  return Array.isArray(tiers)
    ? tiers.map((tier) => pickPublicFields(tier, ['id', 'label']))
    : tiers;
}

function sanitizeListedCountries(countries) {
  return Array.isArray(countries)
    ? countries.map((country) => pickPublicFields(country, ['country', 'nameZh']))
    : countries;
}

function sanitizeChangedCountries(countries) {
  if (!Array.isArray(countries)) return countries;
  return countries.map((country) => {
    const sanitized = pickPublicFields(
      country,
      ['country', 'nameZh', 'fromCurrency', 'toCurrency', 'fromRegion', 'toRegion', 'tiers']
    );
    if (isPlainObject(sanitized) && Array.isArray(sanitized.tiers)) {
      sanitized.tiers = sanitized.tiers.map((tier) => pickPublicFields(tier, ['id', 'from', 'to']));
    }
    return sanitized;
  });
}

function sanitizeRunLogEntry(run) {
  const sanitized = pickPublicFields(run, PUBLIC_RUN_LOG_ENTRY_KEYS);
  if (!isPlainObject(sanitized)) return sanitized;
  if (Object.hasOwn(sanitized, 'source')) {
    sanitized.source = pickPublicFields(sanitized.source, PUBLIC_RUN_LOG_SOURCE_KEYS);
    if (isPlainObject(sanitized.source) && Object.hasOwn(sanitized.source, 'exchangeRatesFallbackReason')) {
      sanitized.source.exchangeRatesFallbackReason = publicFxFallbackReason(
        sanitized.source.exchangeRatesFallbackReason
      );
    }
  }
  if (isPlainObject(sanitized.counts)) {
    sanitized.counts = pickPublicFields(sanitized.counts, PUBLIC_RUN_LOG_COUNT_KEYS);
    if (Array.isArray(sanitized.counts.tiers)) sanitized.counts.tiers = sanitizeListedTiers(sanitized.counts.tiers);
  }
  if (isPlainObject(sanitized.changes)) {
    sanitized.changes = pickPublicFields(sanitized.changes, PUBLIC_RUN_LOG_CHANGE_KEYS);
    if (Object.hasOwn(sanitized.changes, 'publishedDate')) {
      sanitized.changes.publishedDate = pickPublicFields(sanitized.changes.publishedDate, ['changed', 'from', 'to']);
    }
    sanitized.changes.addedTiers = sanitizeListedTiers(sanitized.changes.addedTiers);
    sanitized.changes.removedTiers = sanitizeListedTiers(sanitized.changes.removedTiers);
    sanitized.changes.addedCountries = sanitizeListedCountries(sanitized.changes.addedCountries);
    sanitized.changes.removedCountries = sanitizeListedCountries(sanitized.changes.removedCountries);
    sanitized.changes.changedCountries = sanitizeChangedCountries(sanitized.changes.changedCountries);
  }
  return sanitized;
}

export function buildRunLog(existing, entry) {
  if (existing?.schemaVersion !== 1 || !Array.isArray(existing.runs)) {
    throw new Error('Run log has an unsupported structure');
  }
  return {
    schemaVersion: 1,
    retention: 90,
    updatedAtUtc: entry.finishedAtUtc,
    runs: [
      ...existing.runs.map(sanitizeRunLogEntry),
      entry
    ].slice(-90)
  };
}

async function unlinkIfExists(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function lockClaimPath(lockPath, key) {
  const digest = createHash('sha256').update(key).digest('hex');
  return `${lockPath}.claim-${digest}`;
}

function parseLockClaim(contents) {
  try {
    const metadata = JSON.parse(contents);
    if (typeof metadata?.expectedContents !== 'string') return null;
    return metadata;
  } catch {
    return null;
  }
}

function isActiveLockClaim(metadata) {
  return Number.isInteger(Number(metadata?.pid)) && isProcessAlive(Number(metadata.pid));
}

async function readLockContents(lockPath) {
  return readFile(lockPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function hasActiveLockClaim(lockPath) {
  const currentLockContents = await readLockContents(lockPath);
  if (currentLockContents === null) return false;
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.claim-`;
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const contents = await readFile(path.join(directory, entry.name), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const metadata = contents === null ? null : parseLockClaim(contents);
    if (metadata?.expectedContents === currentLockContents && isActiveLockClaim(metadata)) return true;
  }
  return false;
}

async function claimLockMutation(lockPath, expectedContents, operation) {
  const currentLockContents = await readLockContents(lockPath);
  let claimKey = expectedContents;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claimPath = lockClaimPath(lockPath, claimKey);
    const claimContents = `${JSON.stringify({
      pid: process.pid,
      acquiredAtUtc: new Date().toISOString(),
      operation,
      expectedContents,
      token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    })}\n`;
    try {
      await writeFile(claimPath, claimContents, { flag: 'wx', encoding: 'utf8' });
      return { owned: true, claimPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    const existingContents = await readFile(claimPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existingContents === null) continue;
    const existing = parseLockClaim(existingContents);
    if (existing?.expectedContents === expectedContents
      && currentLockContents === expectedContents
      && isActiveLockClaim(existing)) {
      return { owned: false, active: true, claimPath };
    }
    claimKey = `${expectedContents}\u0000${existingContents}`;
  }
  throw new Error('Unable to claim the iCloud price update lock for stale recovery');
}

async function releaseLockClaim(claimPath) {
  await unlinkIfExists(claimPath);
}

function createLockRelease(lockPath, lockContents) {
  return async () => {
    const current = await readLockContents(lockPath);
    if (current !== lockContents) return;
    const claim = await claimLockMutation(lockPath, lockContents, 'release');
    if (!claim.owned) return;
    try {
      const confirmed = await readLockContents(lockPath);
      if (confirmed === lockContents) await unlinkIfExists(lockPath);
    } finally {
      await releaseLockClaim(claim.claimPath);
    }
  };
}

async function isStaleUpdateLock(lockPath, contents, staleAfterMs) {
  const fileStat = await stat(lockPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!fileStat) return true;
  let metadata = null;
  try {
    metadata = JSON.parse(contents);
  } catch {
    metadata = null;
  }
  const acquiredAtMs = Date.parse(metadata?.acquiredAtUtc ?? '');
  const ageMs = Number.isFinite(acquiredAtMs)
    ? Date.now() - acquiredAtMs
    : Date.now() - fileStat.mtimeMs;
  if (metadata && Object.hasOwn(metadata, 'pid')) {
    const pid = Number(metadata.pid);
    if (Number.isSafeInteger(pid) && pid > 0) return !isProcessAlive(pid);
    return ageMs > staleAfterMs;
  }
  return ageMs > staleAfterMs;
}

export async function acquireUpdateLock(lockPath, {
  staleAfterMs = UPDATE_LOCK_STALE_MS,
  onStaleLockClaimed = null
} = {}) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const lockContents = `${JSON.stringify({
    pid: process.pid,
    acquiredAtUtc: new Date().toISOString(),
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  })}\n`;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await hasActiveLockClaim(lockPath)) {
      throw transientHealthcheckError('Another iCloud price update is already running', {
        code: 'UPDATE_ALREADY_RUNNING'
      });
    }
    try {
      await writeFile(lockPath, lockContents, { flag: 'wx', encoding: 'utf8' });
      return createLockRelease(lockPath, lockContents);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const contents = await readLockContents(lockPath);
      if (contents === null) continue;
      if (!(await isStaleUpdateLock(lockPath, contents, staleAfterMs))) {
        throw transientHealthcheckError('Another iCloud price update is already running', {
          code: 'UPDATE_ALREADY_RUNNING'
        });
      }
      const claim = await claimLockMutation(lockPath, contents, 'stale-recovery');
      if (!claim.owned) {
        throw transientHealthcheckError('Another iCloud price update is already running', {
          code: 'UPDATE_ALREADY_RUNNING'
        });
      }
      try {
        if (onStaleLockClaimed) await onStaleLockClaimed({ lockPath, claimPath: claim.claimPath });
        const confirmed = await readLockContents(lockPath);
        if (confirmed !== contents) continue;
        await unlinkIfExists(lockPath);
        try {
          await writeFile(lockPath, lockContents, { flag: 'wx', encoding: 'utf8' });
        } catch (writeError) {
          if (writeError.code === 'EEXIST') continue;
          throw writeError;
        }
        return createLockRelease(lockPath, lockContents);
      } finally {
        await releaseLockClaim(claim.claimPath);
      }
    }
  }
  throw transientHealthcheckError('Unable to acquire the iCloud price update lock', {
    code: 'UPDATE_LOCK_CONTENTION'
  });
}
async function cleanupUpdaterTemporaryFiles({ currentDataPath, historyPath, runLogPath, snapshotsDir, snapshotIndexPath }) {
  const directories = new Set([
    path.dirname(currentDataPath),
    path.dirname(historyPath),
    path.dirname(runLogPath),
    path.dirname(snapshotIndexPath),
    snapshotsDir
  ]);
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    await Promise.all(entries
      .filter((entry) => entry.isFile() && TEMPORARY_FILE_PATTERN.test(entry.name))
      .map((entry) => unlink(path.join(directory, entry.name))));
  }
}

async function restoreProductionFiles(entries) {
  const results = await Promise.allSettled(entries.map(({ filePath, text, value, existed = true }) => (
    existed ? (typeof text === 'string' ? writeTextAtomic(filePath, text) : writeJsonAtomic(filePath, value)) : unlinkIfExists(filePath)
  )));
  const failures = results.filter(({ status }) => status === 'rejected');
  if (failures.length) {
    throw new Error(`Unable to restore ${failures.length} production data file(s) after a failed update`);
  }
}

async function recoverUpdateTransaction(transactionPath, {
  productionPaths,
  snapshotsDir,
  snapshotIndexPath
}) {
  const state = await readJsonWithExistence(transactionPath, null);
  if (!state.existed) return false;
  const transaction = state.value;
  const allowedProductionPaths = new Set(productionPaths.map((filePath) => path.resolve(filePath)));
  const originalFilePaths = new Set();
  const originalFilesAreSafe = Array.isArray(transaction?.originalFiles)
    && transaction.originalFiles.length === allowedProductionPaths.size
    && transaction.originalFiles.every((entry) => {
      if (!isPlainObject(entry) || typeof entry.filePath !== 'string' || typeof entry.existed !== 'boolean') return false;
      const resolved = path.resolve(entry.filePath);
      if (!allowedProductionPaths.has(resolved) || originalFilePaths.has(resolved)) return false;
      if (entry.existed ? typeof entry.text !== 'string' : entry.text !== null) return false;
      originalFilePaths.add(resolved);
      return true;
    });
  if (!isPlainObject(transaction)
    || transaction.schemaVersion !== 1
    || !['writing', 'committed'].includes(transaction.phase)
    || !originalFilesAreSafe
    || originalFilePaths.size !== allowedProductionPaths.size
    || !(transaction.originalSnapshotIndexText === null || typeof transaction.originalSnapshotIndexText === 'string')) {
    throw new Error('Unsafe or unsupported iCloud price update recovery transaction');
  }

  const snapshotRoot = path.resolve(snapshotsDir);
  const createdSnapshotFiles = transaction.createdSnapshotFiles;
  const createdSnapshotPaths = new Set();
  if (!Array.isArray(createdSnapshotFiles) || createdSnapshotFiles.some((filePath) => {
    if (typeof filePath !== 'string') return true;
    const resolved = path.resolve(filePath);
    const fileName = path.basename(resolved);
    if (path.dirname(resolved) !== snapshotRoot
      || !/^\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{12})?\.json$/.test(fileName)
      || createdSnapshotPaths.has(resolved)) return true;
    createdSnapshotPaths.add(resolved);
    return false;
  })) {
    throw new Error('Unsafe Apple snapshot path in update recovery transaction');
  }

  if (transaction.phase === 'committed') {
    await unlinkIfExists(transactionPath);
    return true;
  }

  const operations = [
    restoreProductionFiles(transaction.originalFiles),
    transaction.originalSnapshotIndexText === null
      ? unlinkIfExists(snapshotIndexPath)
      : writeTextAtomic(snapshotIndexPath, transaction.originalSnapshotIndexText),
    ...createdSnapshotFiles.map((filePath) => unlinkIfExists(filePath))
  ];
  const results = await Promise.allSettled(operations);
  const failures = results.filter(({ status }) => status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map(({ reason }) => reason), 'Unable to recover an interrupted iCloud price update');
  }
  await unlinkIfExists(transactionPath);
  return true;
}

export function redactDiagnosticText(value, environment = process.env) {
  let redacted = String(value ?? '');
  const secrets = Object.entries(environment ?? {})
    .filter(([name, secret]) => (
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PING_URL)$/i.test(name)
      && typeof secret === 'string'
      && secret.length >= 4
    ))
    .map(([, secret]) => secret)
    .sort((first, second) => second.length - first.length);
  for (const secret of secrets) redacted = redacted.replaceAll(secret, '[REDACTED]');
  return redacted
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b((?:authorization|x-api-key|api[-_ ]?key|access[-_ ]?token)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&#\s]+/gi, '$1[REDACTED]')
    .replace(/(https:\/\/v6\.exchangerate-api\.com\/v6\/)(?!latest(?:\/|\b))[^/?#\s]+/gi, '$1[REDACTED]');
}

function failureRunLogEntry(error, startedAt, finishedAt, appleSnapshotCaptured = Boolean(lastAppleSnapshot)) {
  const trigger = resolveTriggerSource(
    process.env.GITHUB_EVENT_NAME,
    process.env.ICLOUD_TRIGGER_SOURCE
  );
  return {
    schemaVersion: 1,
    id: finishedAt.toISOString(),
    status: 'failure',
    trigger,
    automaticRunDateBeijing: process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING || null,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    error: {
      name: error.name,
      code: typeof error?.code === 'string' ? redactDiagnosticText(error.code) : null,
      causeCode: typeof error?.cause?.code === 'string' ? redactDiagnosticText(error.cause.code) : null,
      message: redactDiagnosticText(error?.message ?? error),
      stack: error?.stack == null ? null : redactDiagnosticText(error.stack)
    },
    healthcheckSeverity: classifyHealthcheckFailure(error),
    appleSnapshotCaptured
  };
}

function summarizeNames(names) {
  if (names.length <= 8) return names.join('、');
  return `${names.slice(0, 8).join('、')} 等 ${names.length} 个`;
}

export function buildAppleSnapshotEntry(publishedDate, {
  firstConfirmedDate,
  sourceUrl = APPLE_URL,
  archiveUrl = null,
  parser = 'cross-checked',
  countries,
  pricePoints,
  contentHash,
  dataSha256
} = {}) {
  const publishedDateIso = publicationDateKey(publishedDate);
  if (!isIsoDate(publishedDateIso)) throw new Error('Apple snapshot published date is invalid');
  if (!isFirstConfirmedDateAllowed(firstConfirmedDate)) {
    throw new Error('Apple snapshot first confirmation date is invalid or in the future');
  }
  return {
    publishedDate: publishedDateIso,
    dataFile: `${publishedDateIso}.json`,
    firstConfirmedDate,
    sourceUrl,
    ...(archiveUrl ? { archiveUrl } : {}),
    parser,
    countries,
    pricePoints,
    contentHash,
    ...(dataSha256 ? { dataSha256 } : {})
  };
}

export function appleSnapshotContentHash(parsed) {
  return createHash('sha256').update(JSON.stringify(normalizeApplePricing(parsed))).digest('hex');
}

export function normalizeAppleSemanticSnapshot(parsed) {
  const tiers = [...(parsed?.tiers ?? [])].sort((a, b) => a.capacityGb - b.capacityGb);
  const tierOrder = new Map(tiers.map(({ id }, index) => [id, index]));
  return {
    publishedDate: publicationDateKey(parsed?.sourcePublishedDate ?? parsed?.source?.publishedDate),
    markets: (parsed?.countries ?? []).map(({ country, region, currency, plans }) => ({
      country,
      region,
      currency,
      plans: Object.fromEntries(Object.entries(plans ?? {})
        .map(([tier, value]) => [tier, snapshotPlanPrice(value)])
        .sort(([first], [second]) => (tierOrder.get(first) ?? Number.MAX_SAFE_INTEGER)
          - (tierOrder.get(second) ?? Number.MAX_SAFE_INTEGER)
          || first.localeCompare(second)))
    })).sort((first, second) => first.country.localeCompare(second.country))
  };
}

export function appleSemanticHash(parsed) {
  return createHash('sha256')
    .update(JSON.stringify(normalizeAppleSemanticSnapshot(parsed)))
    .digest('hex');
}

export function appleSemanticChanged(previousData, parsed) {
  return previousData ? appleSemanticHash(previousData) !== appleSemanticHash(parsed) : false;
}

export function confirmAppleSemanticChange(firstParsed, secondParsed, previousData) {
  if (firstParsed.parser !== 'cross-checked' || secondParsed.parser !== 'cross-checked') {
    throw appleConfirmationMismatchError('Apple semantic changes require two fully cross-checked parses');
  }
  validatePrices(secondParsed.countries, { tiers: secondParsed.tiers });
  if (appleSemanticHash(firstParsed) !== appleSemanticHash(secondParsed)) {
    throw appleConfirmationMismatchError('Apple semantic change was not reproduced by the independent confirmation fetch');
  }
  const changes = appleStructuralChanges(previousData, firstParsed);
  return { changes, confirmedRemovedCountries: changes.removedCountries };
}

export function removedCountryNames(previousCountries = [], currentCountries = []) {
  const currentNames = new Set(currentCountries.map(({ country }) => country));
  return previousCountries
    .map(({ country }) => country)
    .filter((country) => !currentNames.has(country));
}

export function confirmCountryRemovals(firstParsed, secondParsed, previousCountries = []) {
  const removals = removedCountryNames(previousCountries, firstParsed.countries);
  if (!removals.length) return [];
  if (firstParsed.parser !== 'cross-checked' || secondParsed.parser !== 'cross-checked') {
    throw new Error('Country removals require two fully cross-checked Apple parses');
  }
  validatePrices(secondParsed.countries, { tiers: secondParsed.tiers });
  if (publicationDateKey(firstParsed.sourcePublishedDate) !== publicationDateKey(secondParsed.sourcePublishedDate)
    || appleSnapshotContentHash(firstParsed) !== appleSnapshotContentHash(secondParsed)) {
    throw new Error('Country removals were not reproduced by the independent Apple confirmation fetch');
  }
  const secondRemovals = removedCountryNames(previousCountries, secondParsed.countries);
  if (JSON.stringify(removals) !== JSON.stringify(secondRemovals)) {
    throw new Error('Country removal confirmation did not reproduce the exact removed-country set');
  }
  return removals;
}

function setDifference(values, baseline) {
  const baselineSet = new Set(baseline);
  return values.filter((value) => !baselineSet.has(value));
}

export function appleStructuralChanges(previousData, parsed) {
  const previousCountries = (previousData?.countries ?? []).map(({ country }) => country);
  const currentCountries = (parsed?.countries ?? []).map(({ country }) => country);
  const previousTiers = (previousData?.tiers ?? []).map(({ id }) => id);
  const currentTiers = (parsed?.tiers ?? []).map(({ id }) => id);
  return {
    addedCountries: setDifference(currentCountries, previousCountries),
    removedCountries: setDifference(previousCountries, currentCountries),
    addedTiers: setDifference(currentTiers, previousTiers),
    removedTiers: setDifference(previousTiers, currentTiers)
  };
}

export function confirmAppleStructuralChanges(firstParsed, secondParsed, previousData) {
  const changes = appleStructuralChanges(previousData, firstParsed);
  if (Object.values(changes).every((items) => items.length === 0)) {
    return { changes, confirmedRemovedCountries: [] };
  }
  if (firstParsed.parser !== 'cross-checked' || secondParsed.parser !== 'cross-checked') {
    throw new Error('Apple country or storage-tier changes require two fully cross-checked parses');
  }
  validatePrices(secondParsed.countries, { tiers: secondParsed.tiers });
  if (publicationDateKey(firstParsed.sourcePublishedDate) !== publicationDateKey(secondParsed.sourcePublishedDate)
    || appleSnapshotContentHash(firstParsed) !== appleSnapshotContentHash(secondParsed)) {
    throw new Error('Apple country or storage-tier changes were not reproduced by the independent confirmation fetch');
  }
  const confirmationChanges = appleStructuralChanges(previousData, secondParsed);
  if (JSON.stringify(changes) !== JSON.stringify(confirmationChanges)) {
    throw new Error('Apple structural confirmation did not reproduce the exact country and storage-tier changes');
  }
  return { changes, confirmedRemovedCountries: changes.removedCountries };
}

function snapshotPlanPrice(value) {
  return Number.isFinite(value) ? value : value?.price;
}

function normalizeApplePricing(parsed) {
  return {
    tiers: parsed.tiers
      .map(({ id, label, capacityGb }) => ({ id, label, capacityGb }))
      .sort((a, b) => a.capacityGb - b.capacityGb),
    countries: parsed.countries.map(({ country, region, currency, plans }) => ({
      country,
      region,
      currency,
      plans: Object.fromEntries(Object.entries(plans)
        .map(([tier, value]) => [tier, snapshotPlanPrice(value)])
        .sort(([a], [b]) => a.localeCompare(b)))
    })).sort((a, b) => a.country.localeCompare(b.country))
  };
}

export function normalizeAppleSnapshot(parsed) {
  return {
    schemaVersion: 1,
    publishedDate: publicationDateKey(parsed.sourcePublishedDate),
    ...normalizeApplePricing(parsed)
  };
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && publicationDateKey(value) === value;
}

function isFirstConfirmedDateAllowed(value) {
  return isIsoDate(value) && value <= formatBeijingDate(new Date());
}

function validateSnapshotFileName(value, extension) {
  return typeof value === 'string'
    && path.basename(value) === value
    && value.endsWith(extension)
    && !value.includes('..');
}

export function normalizeAppleSnapshotIndex(index) {
  if (![1, 2].includes(index?.schemaVersion) || !Array.isArray(index.snapshots)) {
    throw new Error('Apple snapshot index has an unsupported structure');
  }
  const dates = new Set();
  const allFiles = new Set();
  const snapshots = index.snapshots.map((snapshot) => {
    const publishedDate = snapshot?.publishedDate;
    if (!isIsoDate(publishedDate) || dates.has(publishedDate)) {
      throw new Error('Apple snapshot index contains an invalid or duplicate published date');
    }
    dates.add(publishedDate);
    const revisions = Array.isArray(snapshot.revisions)
      ? snapshot.revisions
      : (snapshot.dataFile || snapshot.file) ? [{ ...snapshot }] : null;
    if (!revisions?.length) throw new Error(`Apple snapshot index has no revisions for ${publishedDate}`);
    const hashes = new Set();
    const files = new Set();
    const dataFilePattern = new RegExp(`^${publishedDate}(?:-[a-f0-9]{12})?\\.json$`);
    const normalizedRevisions = revisions.map((revision) => {
      const { file: ignoredFile, htmlSha256: ignoredHtmlSha256, ...revisionData } = revision;
      const normalized = {
        ...revisionData,
        publishedDate: revision.publishedDate ?? publishedDate,
        dataFile: revision.dataFile ?? revision.file?.replace(/\.html$/, '.json')
      };
      const hasDataSha256 = normalized.dataSha256 !== undefined;
      if (normalized.publishedDate !== publishedDate
        || !isFirstConfirmedDateAllowed(normalized.firstConfirmedDate)
        || !validateSnapshotFileName(normalized.dataFile, '.json')
        || !dataFilePattern.test(normalized.dataFile)
        || !/^[a-f0-9]{64}$/.test(normalized.contentHash ?? '')
        || (hasDataSha256 && !/^[a-f0-9]{64}$/.test(normalized.dataSha256))
        || hashes.has(normalized.contentHash)
        || files.has(normalized.dataFile)
        || allFiles.has(normalized.dataFile)) {
        throw new Error(`Apple snapshot index has an invalid revision for ${publishedDate}`);
      }
      hashes.add(normalized.contentHash);
      files.add(normalized.dataFile);
      allFiles.add(normalized.dataFile);
      return normalized;
    }).sort((a, b) => a.firstConfirmedDate.localeCompare(b.firstConfirmedDate));
    const active = normalizedRevisions.at(-1);
    if ((snapshot.activeDataFile && snapshot.activeDataFile !== active.dataFile)
      || (snapshot.activeContentHash && snapshot.activeContentHash !== active.contentHash)) {
      throw new Error(`Apple snapshot index has an invalid active revision for ${publishedDate}`);
    }
    const {
      activeFile: ignoredActiveFile,
      file: ignoredTopLevelFile,
      htmlSha256: ignoredTopLevelHtmlSha256,
      schemaVersion: ignoredNestedSchemaVersion,
      ...snapshotData
    } = snapshot;
    return {
      ...snapshotData,
      publishedDate,
      activeDataFile: active.dataFile,
      activeContentHash: active.contentHash,
      revisions: normalizedRevisions
    };
  });
  return { schemaVersion: 2, snapshots };
}

function isIsoDateTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function normalizedSnapshotAsParsed(snapshot) {
  if (!isPlainObject(snapshot)
    || snapshot.schemaVersion !== 1
    || !isIsoDate(snapshot.publishedDate)
    || !Array.isArray(snapshot.tiers)
    || !Array.isArray(snapshot.countries)) {
    throw new Error('Apple normalized snapshot has an unsupported structure');
  }
  const tierIds = snapshot.tiers.map(({ id }) => id).sort();
  const countries = snapshot.countries.map((country) => {
    if (!isPlainObject(country) || !isPlainObject(country.plans)) {
      throw new Error('Apple normalized snapshot contains an invalid country entry');
    }
    const planIds = Object.keys(country.plans).sort();
    if (JSON.stringify(planIds) !== JSON.stringify(tierIds)) {
      throw new Error(`Apple normalized snapshot has incomplete plans for ${country.country ?? 'unknown country'}`);
    }
    return {
      ...country,
      plans: Object.fromEntries(Object.entries(country.plans).map(([tierId, price]) => [tierId, {
        price,
        formattedPrice: String(price)
      }]))
    };
  });
  const parsed = {
    sourcePublishedDate: snapshot.publishedDate,
    tiers: snapshot.tiers,
    countries
  };
  validatePrices(countries, { minCountries: 60, tiers: snapshot.tiers });
  return parsed;
}

async function listSnapshotEvidence(snapshotsDir) {
  return readdir(snapshotsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }).then((entries) => entries.filter((entry) => (
    entry.name !== 'index.json' && /\.(?:html|json)$/i.test(entry.name)
  )));
}

export async function validateAppleSnapshotStore({
  snapshotsDir = APPLE_SNAPSHOTS_DIR,
  snapshotIndexPath = APPLE_SNAPSHOT_INDEX_PATH,
  snapshotIndex,
  snapshotIndexExists = snapshotIndex !== undefined,
  history = null,
  currentData = null,
  deep = false
} = {}) {
  const [indexState, evidenceEntries] = await Promise.all([
    snapshotIndex === undefined
      ? readJsonWithExistence(snapshotIndexPath, null)
      : Promise.resolve({ value: snapshotIndex, existed: snapshotIndexExists }),
    listSnapshotEvidence(snapshotsDir)
  ]);
  const evidenceNames = evidenceEntries.map(({ name }) => name).sort();
  if (!indexState.existed) {
    if (evidenceNames.length) {
      throw new Error('Apple snapshot index is missing while snapshot evidence exists');
    }
    return null;
  }

  const normalizedIndex = normalizeAppleSnapshotIndex(indexState.value);
  const indexedFiles = new Set(normalizedIndex.snapshots.flatMap(({ revisions }) => (
    revisions.map(({ dataFile }) => dataFile)
  )));
  const unindexedEvidence = evidenceNames.filter((name) => !indexedFiles.has(name));
  if (unindexedEvidence.length) {
    throw new Error(`Apple snapshot index does not reference existing evidence: ${unindexedEvidence.join(', ')}`);
  }

  const evidenceByName = new Map(evidenceEntries.map((entry) => [entry.name, entry]));
  const publicationHistory = new Map((history?.sourcePublishedDates ?? []).map((entry) => (
    [publicationDateKey(entry.publishedDate), entry]
  )));
  const latestSnapshot = normalizedIndex.snapshots.at(-1);
  for (const snapshot of normalizedIndex.snapshots) {
    if (snapshot.publishedDate > snapshot.revisions[0].firstConfirmedDate) {
      throw new Error(`Apple snapshot ${snapshot.publishedDate} predates its publication confirmation`);
    }
    const historyEntry = history ? publicationHistory.get(snapshot.publishedDate) : null;
    if (history && !historyEntry) {
      throw new Error(`Apple snapshot ${snapshot.publishedDate} is missing publication history`);
    }
    if (historyEntry && historyEntry.observedAt !== snapshot.revisions[0].firstConfirmedDate) {
      throw new Error(`Apple snapshot ${snapshot.publishedDate} has an inconsistent earliest confirmation date`);
    }

    for (const revision of snapshot.revisions) {
      if (!Number.isInteger(revision.countries)
        || revision.countries < 60
        || !Number.isInteger(revision.pricePoints)
        || revision.pricePoints <= 0
        || revision.sourceUrl !== APPLE_URL
        || (revision.archiveUrl && !revision.archiveUrl.startsWith('https://web.archive.org/web/'))) {
        throw new Error(`Apple snapshot index has invalid evidence metadata for ${snapshot.publishedDate}`);
      }
      const entry = evidenceByName.get(revision.dataFile);
      if (!entry) throw new Error(`Apple snapshot index references missing evidence: ${revision.dataFile}`);
      if (!entry.isFile()) throw new Error(`Apple snapshot evidence is not a regular file: ${revision.dataFile}`);

      const dataPath = path.join(snapshotsDir, revision.dataFile);
      const hadRawHash = Boolean(revision.dataSha256);
      const dataBuffer = await readFile(dataPath);
      const dataSha256 = snapshotFileSha256(dataBuffer);
      if (revision.dataSha256 && revision.dataSha256 !== dataSha256) {
        throw new Error(`Apple snapshot evidence has a content-hash mismatch in raw bytes for ${snapshot.publishedDate}`);
      }
      revision.dataSha256 = dataSha256;
      const isLatestActiveRevision = snapshot === latestSnapshot && revision.dataFile === snapshot.activeDataFile;
      if (!deep && hadRawHash && !isLatestActiveRevision) continue;

      let normalizedSnapshot;
      try {
        normalizedSnapshot = JSON.parse(dataBuffer.toString('utf8'));
      } catch (error) {
        throw new Error(`Unable to read valid JSON from ${revision.dataFile}: ${error.message}`);
      }
      const parsedNormalized = normalizedSnapshotAsParsed(normalizedSnapshot);
      if (normalizedSnapshot.publishedDate !== snapshot.publishedDate) {
        throw new Error(`Apple snapshot evidence has a publication-date mismatch for ${snapshot.publishedDate}`);
      }
      const normalizedPricePoints = parsedNormalized.countries.length * parsedNormalized.tiers.length;
      if (parsedNormalized.countries.length !== revision.countries
        || normalizedPricePoints !== revision.pricePoints) {
        throw new Error(`Apple snapshot evidence has a count mismatch for ${snapshot.publishedDate}`);
      }
      const normalizedHash = appleSnapshotContentHash(parsedNormalized);
      if (normalizedHash !== revision.contentHash) {
        throw new Error(`Apple snapshot evidence has a content-hash mismatch for ${snapshot.publishedDate}`);
      }
    }
  }

  if (history && publicationHistory.size !== normalizedIndex.snapshots.length) {
    throw new Error('Apple publication history and snapshot index contain different dates');
  }
  if (currentData) {
    const latestSnapshot = normalizedIndex.snapshots.at(-1);
    const currentPublishedDate = publicationDateKey(currentData.source?.publishedDate);
    if (!latestSnapshot || latestSnapshot.publishedDate !== currentPublishedDate) {
      throw new Error('Apple snapshot index latest date does not match current prices');
    }
    if (latestSnapshot.activeContentHash !== appleSnapshotContentHash(currentData)) {
      throw new Error('Apple snapshot active revision does not match current prices');
    }
  }
  return normalizedIndex;
}

export function validateExistingPrices(data) {
  if (!isPlainObject(data)
    || ![1, 2, 3, 4].includes(data.schemaVersion)
    || !isIsoDateTime(data.generatedAt)
    || !isPlainObject(data.source)
    || data.source.url !== APPLE_URL
    || !isIsoDate(publicationDateKey(data.source.publishedDate))
    || !isPlainObject(data.fx)
    || !ALLOWED_FX_SOURCE_URLS.has(data.fx.sourceUrl)
    || data.fx.base !== 'USD'
    || !isIsoDateTime(data.fx.fetchedAt)) {
    throw new Error('Existing prices.json has an unsupported or unsafe structure');
  }
  const usesDerivedCnyPrices = data.schemaVersion >= 3;
  if (usesDerivedCnyPrices) {
    if (data.fx.derivedCurrency !== 'CNY' || Object.hasOwn(data.fx, 'rates')) {
      throw new Error('Existing prices.json exposes raw exchange rates or lacks derived CNY metadata');
    }
  } else if (!isPlainObject(data.fx.rates)
    || data.fx.rates.USD !== 1
    || !Number.isFinite(data.fx.rates.CNY)
    || data.fx.rates.CNY <= 0) {
    throw new Error('Existing prices.json has invalid legacy exchange rates');
  }
  validatePrices(data.countries, { minCountries: 60, tiers: data.tiers });
  if (!usesDerivedCnyPrices) {
    const missingRates = getMissingExchangeRates(data.countries, data.fx.rates);
    if (missingRates.length) {
      throw new Error(`Existing prices.json is missing exchange rates for: ${missingRates.join(', ')}`);
    }
  }
  for (const country of data.countries) {
    if (typeof country.nameZh !== 'string' || !country.nameZh.trim()) {
      throw new Error(`Existing prices.json is missing a display name for ${country.country}`);
    }
    for (const { id } of data.tiers) {
      if (typeof country.plans[id].formattedPrice !== 'string' || !country.plans[id].formattedPrice.trim()) {
        throw new Error(`Existing prices.json is missing formatted ${id} pricing for ${country.country}`);
      }
    }
  }
  if (data.source.parser != null && !/^(cross-checked|document-order|apple-markers-fallback)$/.test(data.source.parser)) {
    throw new Error('Existing prices.json has an invalid Apple parser status');
  }
  if (data.schemaVersion >= 3 && data.source.parser !== 'cross-checked') {
    throw new Error('Existing current prices.json was not produced by both Apple parsers');
  }
  const observedAt = data.run?.observedAtBeijing ?? formatBeijingDate(data.generatedAt);
  if (!isIsoDate(observedAt)) throw new Error('Existing prices.json has an invalid observation date');
  assertPublicationDateNotFuture(data.source.publishedDate, observedAt);
  if (data.schemaVersion >= 2) {
    if (!isPlainObject(data.run)
      || !isIsoDateTime(data.run.startedAtUtc)
      || !isIsoDateTime(data.run.finishedAtUtc)
      || !isIsoDateTime(data.run.observedAtUtc)
      || !isIsoDate(data.run.observedAtBeijing)
      || data.run.finishedAtUtc < data.run.startedAtUtc
      || data.generatedAt !== data.run.finishedAtUtc
      || data.run.observedAtUtc !== data.run.finishedAtUtc
      || data.run.observedAtBeijing !== formatBeijingDate(data.run.finishedAtUtc)
      || data.run.countries !== data.countries.length
      || data.run.pricePoints !== data.countries.length * data.tiers.length) {
      throw new Error('Existing prices.json has inconsistent run metadata');
    }
  }
  validatePricePayload(data, { minCountries: 60 });
}

export function validateExistingHistory(history, data) {
  const usesMarketIds = history?.schemaVersion === 4;
  const records = usesMarketIds ? history?.markets : history?.countries;
  if (!isPlainObject(history)
    || ![1, 2, 4].includes(history.schemaVersion)
    || !isPlainObject(records)
    || !Array.isArray(history.sourcePublishedDates)
    || !history.sourcePublishedDates.length
    || (history.updatedAt != null && !isIsoDateTime(history.updatedAt))) {
    throw new Error('Existing history.json has an unsupported structure');
  }
  for (const [recordKey, record] of Object.entries(records)) {
    assertSafeHistoryCountryKey(recordKey);
    if (!isPlainObject(record)
      || (usesMarketIds && (typeof record.country !== 'string' || !record.country.trim()))
      || typeof record.nameZh !== 'string'
      || !record.nameZh.trim()
      || typeof record.region !== 'string'
      || !record.region.trim()
      || !Array.isArray(record.events)
      || !record.events.length) {
      throw new Error(`Existing history.json has an invalid record for ${recordKey}`);
    }
    let previousObservedAt = '';
    for (const event of record.events) {
      if (!isPlainObject(event)
        || !isIsoDate(event.observedAt)
        || event.observedAt < previousObservedAt
        || typeof event.currency !== 'string'
        || !/^[A-Z]{3}$/.test(event.currency)
        || !isPlainObject(event.plans)
        || !Object.keys(event.plans).length
        || Object.values(event.plans).some((price) => !Number.isFinite(price) || price <= 0)
        || (event.observedAtUtc != null && !isIsoDateTime(event.observedAtUtc))
        || (event.observedAtUtc != null && event.observedAtBeijing !== event.observedAt)) {
        throw new Error(`Existing history.json has an invalid event for ${recordKey}`);
      }
      previousObservedAt = event.observedAt;
    }
  }

  const publicationDates = new Set();
  let previousPublishedDate = '';
  let previousObservedAt = '';
  for (const entry of history.sourcePublishedDates) {
    const publishedDate = publicationDateKey(entry?.publishedDate);
    if (!isPlainObject(entry)
      || !isIsoDate(publishedDate)
      || publicationDates.has(publishedDate)
      || publishedDate < previousPublishedDate
      || !isIsoDate(entry.observedAt)
      || entry.observedAt < previousObservedAt) {
      throw new Error('Existing history.json has an invalid publication history');
    }
    publicationDates.add(publishedDate);
    previousPublishedDate = publishedDate;
    previousObservedAt = entry.observedAt;
  }
  if (previousPublishedDate !== publicationDateKey(data.source.publishedDate)) {
    throw new Error('Existing history.json latest publication date does not match current prices');
  }

  validatePriceHistoryConsistency(data, history);
}

function validateExistingRunLog(runLog, data) {
  if (!isPlainObject(runLog)
    || runLog.schemaVersion !== 1
    || !Array.isArray(runLog.runs)
    || !runLog.runs.length
    || !Number.isInteger(runLog.retention)
    || runLog.retention <= 0) {
    throw new Error('Existing run-log.json has an unsupported structure');
  }
  let previousFinishedAt = '';
  const latestAllowedTimestamp = Date.now() + FX_MAX_FUTURE_SKEW_MS;
  for (const run of runLog.runs) {
    if (!isPlainObject(run)
      || !isPlainObject(run.source)
      || Object.keys(run.source).some((key) => /api.?key/i.test(key))
      || run.status !== 'success'
      || !isIsoDateTime(run.startedAtUtc)
      || !isIsoDateTime(run.finishedAtUtc)
      || run.finishedAtUtc < run.startedAtUtc
      || Date.parse(run.startedAtUtc) > latestAllowedTimestamp
      || Date.parse(run.finishedAtUtc) > latestAllowedTimestamp
      || run.finishedAtUtc < previousFinishedAt) {
      throw new Error('Existing run-log.json contains an invalid run');
    }
    previousFinishedAt = run.finishedAtUtc;
  }
  const latestRun = runLog.runs.at(-1);
  const expectedTierCounts = data.tiers.map(({ id, label }) => ({ id, label }));
  if (runLog.updatedAtUtc !== latestRun.finishedAtUtc
    || latestRun.finishedAtUtc !== (data.run?.finishedAtUtc ?? data.generatedAt)
    || latestRun.source?.appleUrl !== data.source.url
    || publicationDateKey(latestRun.source?.applePublishedDate) !== publicationDateKey(data.source.publishedDate)
    || latestRun.counts?.countries !== data.countries.length
    || latestRun.counts?.pricePoints !== data.countries.length * data.tiers.length
    || latestRun.counts?.currencies !== new Set(data.countries.map(({ currency }) => currency)).size
    || JSON.stringify(latestRun.counts?.tiers) !== JSON.stringify(expectedTierCounts)) {
    throw new Error('Existing run-log.json latest run does not match current prices');
  }
}

export async function preflightProductionState({
  previousDataState,
  previousHistoryState,
  previousRunLogState,
  snapshotsDir = APPLE_SNAPSHOTS_DIR,
  snapshotIndexPath = APPLE_SNAPSHOT_INDEX_PATH
}) {
  const requiredStates = [
    ['prices.json', previousDataState],
    ['history.json', previousHistoryState]
  ];
  const existingCount = requiredStates.filter(([, state]) => state.existed).length;
  if (existingCount === 1) {
    const missing = requiredStates.filter(([, state]) => !state.existed).map(([name]) => name);
    throw new Error(`Production data state is partial; missing: ${missing.join(', ')}`);
  }
  if (existingCount === 0) {
    if (previousRunLogState.existed) {
      throw new Error('Production data state is partial; missing: prices.json, history.json');
    }
    const snapshotIndex = await validateAppleSnapshotStore({ snapshotsDir, snapshotIndexPath });
    if (snapshotIndex) throw new Error('Production data state is partial; core JSON files are missing');
    return { bootstrap: true, snapshotIndex: null };
  }

  validateExistingPrices(previousDataState.value);
  validateExistingHistory(previousHistoryState.value, previousDataState.value);
  if (previousRunLogState.existed) {
    validateExistingRunLog(previousRunLogState.value, previousDataState.value);
  }
  const snapshotIndex = await validateAppleSnapshotStore({
    snapshotsDir,
    snapshotIndexPath,
    history: previousHistoryState.value,
    currentData: previousDataState.value
  });
  if (!snapshotIndex) {
    throw new Error('Apple snapshot store is missing for the existing production baseline');
  }
  return { bootstrap: false, snapshotIndex };
}

export function buildAppleSnapshotIndex(existing, entry) {
  const snapshots = Array.isArray(existing?.snapshots) ? existing.snapshots : [];
  const byDate = new Map(snapshots.map((item) => [item.publishedDate, item]));
  const current = byDate.get(entry.publishedDate);
  if (!current) {
    byDate.set(entry.publishedDate, {
      publishedDate: entry.publishedDate,
      activeDataFile: entry.dataFile,
      activeContentHash: entry.contentHash,
      revisions: [entry]
    });
  } else {
    const revisions = Array.isArray(current.revisions) ? current.revisions : [current];
    const matchingIndex = revisions.findIndex(({ contentHash }) => contentHash === entry.contentHash);
    const nextRevisions = [...revisions];
    if (matchingIndex < 0) {
      nextRevisions.push(entry);
    } else if (entry.firstConfirmedDate < revisions[matchingIndex].firstConfirmedDate) {
      nextRevisions[matchingIndex] = {
        ...revisions[matchingIndex],
        firstConfirmedDate: entry.firstConfirmedDate,
        ...(entry.archiveUrl ? { archiveUrl: entry.archiveUrl } : {})
      };
    } else {
      return {
        schemaVersion: 2,
        snapshots: [...byDate.values()].sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))
      };
    }
    const orderedRevisions = nextRevisions.sort((a, b) => (
      (a.firstConfirmedDate ?? '').localeCompare(b.firstConfirmedDate ?? '')
    ));
    const activeRevision = orderedRevisions.at(-1);
    byDate.set(entry.publishedDate, {
      ...current,
      activeDataFile: activeRevision.dataFile,
      activeContentHash: activeRevision.contentHash,
      revisions: orderedRevisions
    });
  }
  return {
    schemaVersion: 2,
    snapshots: [...byDate.values()].sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))
  };
}

export async function savePublishedAppleSnapshot(_html, parsed, firstConfirmedDate, {
  snapshotsDir = APPLE_SNAPSHOTS_DIR,
  indexPath = APPLE_SNAPSHOT_INDEX_PATH
} = {}) {
  const publishedDate = publicationDateKey(parsed.sourcePublishedDate);
  const contentHash = appleSnapshotContentHash(parsed);
  const normalizedSnapshot = normalizeAppleSnapshot(parsed);
  const normalizedSnapshotText = serializeJson(normalizedSnapshot);
  const index = normalizeAppleSnapshotIndex(await readJson(indexPath, { schemaVersion: 2, snapshots: [] }));
  const existing = index.snapshots?.find((item) => item.publishedDate === publishedDate);
  const revisions = Array.isArray(existing?.revisions) ? existing.revisions : existing ? [existing] : [];
  if (revisions.some((revision) => revision.contentHash === contentHash)) return false;
  const dataFile = existing ? `${publishedDate}-${contentHash.slice(0, 12)}.json` : `${publishedDate}.json`;
  const entry = buildAppleSnapshotEntry(parsed.sourcePublishedDate, {
    firstConfirmedDate,
    parser: parsed.parser,
    countries: parsed.countries.length,
    pricePoints: parsed.countries.length * parsed.tiers.length,
    contentHash,
    dataSha256: snapshotFileSha256(normalizedSnapshotText)
  });
  entry.dataFile = dataFile;
  const updatedIndex = normalizeAppleSnapshotIndex(buildAppleSnapshotIndex(index, entry));
  const dataPath = path.join(snapshotsDir, entry.dataFile);
  const createdPaths = [];
  try {
    await mkdir(snapshotsDir, { recursive: true });
    await writeTextExclusiveAtomic(dataPath, normalizedSnapshotText, (filePath) => createdPaths.push(filePath));
    await writeJsonAtomic(indexPath, updatedIndex);
  } catch (error) {
    const cleanupResults = await Promise.allSettled(createdPaths.map((filePath) => unlinkIfExists(filePath)));
    const cleanupFailures = cleanupResults
      .filter(({ status }) => status === 'rejected')
      .map(({ reason }) => reason);
    if (cleanupFailures.length) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `Apple snapshot write failed and cleanup was incomplete: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
  return true;
}

function summarizeChangedCountries(entries) {
  return summarizeNames(entries.map(({ nameZh, country }) => markdownInline(nameZh || country)));
}

function describeParser(data) {
  const parser = markdownInline(data.source.parser ?? 'unknown');
  if (parser === 'cross-checked') return `${parser}（双解析器一致）`;
  return `${parser}（${markdownInline(data.source.parserStatus ?? 'unknown')}）`;
}

function describeExchangeRateSource(fx) {
  if (fx.stale) return '上一份有效汇率';
  if (fx.sourceMode === 'api-key') return 'ExchangeRate-API 认证接口（主来源）';
  if (fx.fallbackUsed) return 'ExchangeRate-API 开放接口（自动回退）';
  return 'ExchangeRate-API 开放接口';
}

export function buildActionSummaryLines(data, summary, trigger = resolveTriggerSource(
  process.env.GITHUB_EVENT_NAME,
  process.env.ICLOUD_TRIGGER_SOURCE
)) {
  const publicationChanges = summary.publicationChanges ?? {
    addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: []
  };
  const changedCountries = publicationChanges.changedCountries ?? [];
  const priceChanges = changedCountries.filter(({ tiers }) => tiers?.length);
  const currencyChanges = changedCountries.filter(({ fromCurrency, toCurrency }) => fromCurrency !== toCurrency);
  const regionChanges = changedCountries.filter(({ fromRegion, toRegion }) => fromRegion !== toRegion);
  const changes = [];
  const warnings = [];

  if (summary.publicationDateChanged) {
    const previousDate = summary.publishedDateHistory.at(-2)?.publishedDate ?? 'unknown';
    changes.push(`Apple 发布日期：${markdownInline(previousDate)} → ${markdownInline(data.source.publishedDate ?? 'unknown')}`);
  }
  if (publicationChanges.addedTiers.length) {
    changes.push(`新增容量：${publicationChanges.addedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
  if (publicationChanges.removedTiers.length) {
    changes.push(`移除容量：${publicationChanges.removedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
  if (publicationChanges.addedCountries.length) {
    changes.push(`新增地区：${summarizeChangedCountries(publicationChanges.addedCountries)}`);
  }
  if (publicationChanges.removedCountries.length) {
    changes.push(`移除地区：${summarizeChangedCountries(publicationChanges.removedCountries)}`);
  }
  if (regionChanges.length) changes.push(`所属分区变化：${summarizeChangedCountries(regionChanges)}`);
  if (currencyChanges.length) changes.push(`币种变化：${summarizeChangedCountries(currencyChanges)}`);
  if (priceChanges.length) changes.push(`价格变化：${summarizeChangedCountries(priceChanges)}`);
  if (!changes.length) changes.push('本次变化：无');

  if (data.source.parser !== 'cross-checked') warnings.push(`- **解析降级**：${describeParser(data)}`);
  if (data.fx.stale) warnings.push('- **汇率降级**：本次获取失败，沿用上次成功结果');
  if (summary.missingRates.length) warnings.push(`- **缺少汇率**：${summary.missingRates.map((currency) => markdownInline(currency)).join('、')}`);
  for (const warning of summary.fxSanityWarnings ?? []) {
    warnings.push(`- **FX sanity**：${markdownInline(warning)}`);
  }
  for (const market of summary.unknownMarkets ?? []) {
    warnings.push(`- **UNKNOWN_APPLE_MARKET**：${markdownInline(market.sourceName)} → ${markdownInline(market.generatedMarketId ?? market.id)}；分区 ${markdownInline(market.region ?? 'unknown')}；币种 ${markdownInline(market.currency ?? 'unknown')}`);
  }

  const lines = [
    '## iCloud+ 价格更新',
    '',
    '### 结论',
    '- **状态：成功**',
    `- 触发方式：${describeTriggerSource(trigger)}`,
    `- 抓取完成时间（北京时间）：${formatBeijingDateTime(data.generatedAt)}`,
    '',
    '### 数据概览',
    `- 地区数量：${data.countries.length}`,
    `- 价格点数量：${data.countries.length * data.tiers.length}`,
    `- 历史记录覆盖：${Object.keys(summary.history?.markets ?? summary.history?.countries ?? {}).length} 个地区`,
    `- Apple 页面标注日期：${markdownInline(data.source.publishedDate ?? 'unknown')}`,
    `- Apple 发布日期记录：${summary.publishedDateHistory.length} 条`,
    '',
    '### 校验与来源',
    `- Apple 解析路径：${describeParser(data)}`,
    `- 汇率来源：${describeExchangeRateSource(data.fx)}`,
    `- 汇率更新时间（北京时间）：${formatBeijingDateTime(data.fx.fetchedAt)}`,
    `- 汇率状态：${data.fx.stale ? '沿用上次成功结果' : '本次成功获取'}`,
    '',
    '### 本次变化',
    ...changes
  ];
  if (warnings.length) lines.push('', '### 警告', ...warnings);
  lines.push('');
  return lines;
}

async function writeActionSummary(data, summary, stepSummaryPath) {
  if (!stepSummaryPath) return;
  await appendFile(
    stepSummaryPath,
    buildActionSummaryLines(data, summary).join('\n'),
    'utf8'
  );
}

export async function main({
  dryRun = DRY_RUN,
  paths = {},
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY,
  writeJson = writeJsonAtomic,
  networkBudget = createNetworkBudget()
} = {}) {
  const currentDataPath = paths.currentDataPath ?? CURRENT_DATA_PATH;
  const historyPath = paths.historyPath ?? HISTORY_PATH;
  const runLogPath = paths.runLogPath ?? RUN_LOG_PATH;
  const namesPath = paths.namesPath ?? NAMES_PATH;
  const snapshotsDir = paths.snapshotsDir ?? APPLE_SNAPSHOTS_DIR;
  const snapshotIndexPath = paths.snapshotIndexPath ?? APPLE_SNAPSHOT_INDEX_PATH;
  const lockPath = paths.lockPath ?? defaultUpdateLockPath(currentDataPath);
  const transactionPath = paths.transactionPath ?? defaultUpdateTransactionPath(currentDataPath);
  const releaseLock = dryRun ? null : await acquireUpdateLock(lockPath);
  try {
    runStartedAt = new Date();
    lastAppleSnapshot = null;
    if (!dryRun) {
      await recoverUpdateTransaction(transactionPath, {
        productionPaths: [currentDataPath, historyPath, runLogPath],
        snapshotsDir,
        snapshotIndexPath
      });
      await cleanupUpdaterTemporaryFiles({
        currentDataPath,
        historyPath,
        runLogPath,
        snapshotsDir,
        snapshotIndexPath
      });
    }
    const [previousDataState, previousHistoryState, previousRunLogState, countryNames] = await Promise.all([
      readJsonWithExistence(currentDataPath),
      readJsonWithExistence(historyPath),
      readJsonWithExistence(runLogPath, { schemaVersion: 1, retention: 90, runs: [] }),
      readJson(namesPath, {})
    ]);
    await preflightProductionState({
      previousDataState,
      previousHistoryState,
      previousRunLogState,
      snapshotsDir,
      snapshotIndexPath
    });
    const previousData = previousDataState.value;
    const previousHistory = previousHistoryState.value;
    const previousRunLog = previousRunLogState.value;
    const originalFiles = [
      { filePath: currentDataPath, value: structuredClone(previousData), text: previousDataState.text, existed: previousDataState.existed },
      { filePath: historyPath, value: structuredClone(previousHistory), text: previousHistoryState.text, existed: previousHistoryState.existed },
      { filePath: runLogPath, value: structuredClone(previousRunLog), text: previousRunLogState.text, existed: previousRunLogState.existed }
    ];
    validateCountryNameMapping(countryNames);
    validateMarketRegistry();
    const html = await fetchResource(APPLE_URL, { networkBudget });

  const parsed = parseApplePrices(html, { allowUnknownCountries: true });
  lastAppleSnapshot = normalizeAppleSnapshot(parsed);
  if (parsed.parser !== 'cross-checked') {
    throw new Error(`Apple parser redundancy failed closed: ${logInline(parsed.parserStatus)}`);
  }
  if (!parsed.sourcePublishedDate || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDateKey(parsed.sourcePublishedDate))) {
    throw new Error('Apple published date was not found or has an unsupported format');
  }
  validatePrices(parsed.countries, { tiers: parsed.tiers });
  let confirmedRemovedCountries = [];
  if (!previousData || appleSemanticChanged(previousData, parsed)) {
    let confirmationHtml;
    try {
      confirmationHtml = await fetchResource(APPLE_URL, {
        networkBudget,
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        resourceName: 'Apple iCloud+ pricing semantic-change confirmation'
      });
    } catch (error) {
      throw appleConfirmationUnavailableError(error);
    }
    let confirmationParsed;
    try {
      confirmationParsed = parseApplePrices(confirmationHtml, { allowUnknownCountries: true });
    } catch (error) {
      throw appleConfirmationMismatchError(
        'Apple confirmation did not produce two matching parser results',
        error
      );
    }
    ({ confirmedRemovedCountries } = confirmAppleSemanticChange(
      parsed,
      confirmationParsed,
      previousData
    ));
  }
  const unknownMarkets = [];
  const parsedCountries = attachMarketIdentity(parsed.countries, {
    onUnknown: (market, country) => {
      const warning = {
        sourceName: market.sourceName,
        generatedMarketId: market.id,
        region: country.region,
        currency: country.currency
      };
      unknownMarkets.push(warning);
      console.warn(`UNKNOWN_APPLE_MARKET:${logInline(warning.sourceName)}:${warning.generatedMarketId}:${logInline(warning.region)}:${logInline(warning.currency)}`);
    }
  }).map((country) => ({
    ...country,
    nameZh: Object.hasOwn(countryNames, country.country) ? countryNames[country.country] : country.nameZh
  }));

  const fx = await getExchangeRates(previousData, {
    requiredCurrencies: [...new Set(parsedCountries.map(({ currency }) => currency))],
    networkBudget
  });
  const fxSanity = validateFxSanity(previousData, fx, {
    currentCurrencies: parsedCountries.map(({ currency }) => currency)
  });
  for (const warning of fxSanity.warnings) console.warn(warning);
  const countries = attachDerivedCnyPrices(parsedCountries, { fx, previousData });
  if (process.env.GITHUB_ACTIONS === 'true' && fx.fallbackUsed && !fx.stale) {
    console.log('::notice title=汇率来源自动回退::认证汇率来源不可用，已使用开放接口。');
  }
  if (process.env.GITHUB_ACTIONS === 'true' && fx.stale) {
    console.log('::warning title=汇率更新失败::两个在线汇率来源均不可用，已沿用上一份有效汇率。');
  }
  const missingRates = fx.rates ? getMissingExchangeRates(countries, fx.rates) : [];
  if (missingRates.length) {
    throw new Error(`Exchange rates are missing for: ${missingRates.join(', ')}`);
  }
  validatePrices(countries, {
    tiers: parsed.tiers,
    previousCountries: previousData?.countries ?? [],
    confirmedRemovedCountries,
    previousRates: previousData?.fx?.rates,
    currentRates: fx.rates
  });
  validatePriceChangeAnomalies(countries, {
    previousData,
    currentRates: fx.rates,
    tiers: parsed.tiers
  });
  let finishedAt = new Date();
  if (finishedAt.getTime() < runStartedAt.getTime()) finishedAt = new Date(runStartedAt);
  const generatedAt = finishedAt.toISOString();
  const observedAt = formatBeijingDate(generatedAt);
  assertPublicationDateNotFuture(parsed.sourcePublishedDate, observedAt);
  const data = {
    schemaVersion: 4,
    generatedAt,
    source: {
      name: 'Apple Support',
      url: APPLE_URL,
      publishedDate: parsed.sourcePublishedDate,
      parser: parsed.parser,
      parserStatus: parsed.parserStatus
    },
    run: {
      startedAtUtc: runStartedAt.toISOString(),
      finishedAtUtc: generatedAt,
      observedAtBeijing: observedAt,
      observedAtUtc: generatedAt,
      countries: countries.length,
      pricePoints: countries.length * parsed.tiers.length
    },
    fx: publicExchangeRateMetadata(fx),
    tiers: parsed.tiers,
    countries
  };
  const publicationChanges = buildSnapshotChanges(previousData, countries, parsed.tiers);
  const historyUpdate = updateHistory(previousHistory, countries, observedAt, parsed.tiers, generatedAt);
  const history = historyUpdate.history;
  const publishedDateUpdate = updatePublishedDateHistory(history, previousData, parsed.sourcePublishedDate, observedAt, publicationChanges, generatedAt);
  const historyChanged = historyUpdate.changed || publishedDateUpdate.historyChanged;
  if (historyChanged && history.updatedAt !== generatedAt) {
    history.updatedAt = generatedAt;
  }
  const publishedDateHistory = publishedDateUpdate.entries;
  const summary = {
    history,
    historyChanged,
    missingRates,
    fxSanityWarnings: fxSanity.warnings,
    unknownMarkets,
    publishedDateHistory,
    publicationDateChanged: publishedDateUpdate.changed,
    publicationChanges,
    observedAt
  };
  const run = createRunLogEntry(data, summary, runStartedAt, finishedAt);
  const runLog = buildRunLog(previousRunLog, run);
  validatePricePayload(data, { minCountries: 60 });
  validateHistoryPayload(history);
  validatePriceHistoryConsistency(data, history);
  validateExistingRunLog(runLog, data);
  const originalSnapshotIndexState = dryRun
    ? { value: null, text: null }
    : await readJsonWithExistence(snapshotIndexPath, null);
  const originalSnapshotIndex = originalSnapshotIndexState.value;

  if (dryRun) {
    console.log(`Live check passed with ${parsed.parser}: ${countries.length} countries and ${countries.length * parsed.tiers.length} prices. No files were changed.`);
  } else {
    const publishedDate = publicationDateKey(parsed.sourcePublishedDate);
    const contentHash = appleSnapshotContentHash(parsed);
    const existingSnapshot = originalSnapshotIndex?.snapshots?.find((item) => item.publishedDate === publishedDate);
    const existingRevision = existingSnapshot?.revisions?.some((revision) => revision.contentHash === contentHash);
    const snapshotFile = existingSnapshot ? `${publishedDate}-${contentHash.slice(0, 12)}.json` : `${publishedDate}.json`;
    const snapshotCandidates = existingRevision ? [] : [
      path.join(snapshotsDir, snapshotFile)
    ];
    const candidateExists = await Promise.all(snapshotCandidates.map(pathExists));
    const createdSnapshotFiles = snapshotCandidates.filter((_, index) => !candidateExists[index]);
    const transaction = {
      schemaVersion: 1,
      phase: 'writing',
      originalFiles,
      originalSnapshotIndexText: originalSnapshotIndexState.text,
      createdSnapshotFiles
    };
    await writeJsonAtomic(transactionPath, transaction);
    try {
      await savePublishedAppleSnapshot(html, parsed, observedAt, {
        snapshotsDir,
        indexPath: snapshotIndexPath
      });
      await writeJson(currentDataPath, data);
      if (historyChanged) await writeJson(historyPath, history);
      await writeJson(runLogPath, runLog);
      await writeJsonAtomic(transactionPath, { ...transaction, phase: 'committed' });
    } catch (error) {
      try {
        await recoverUpdateTransaction(transactionPath, {
          productionPaths: [currentDataPath, historyPath, runLogPath],
          snapshotsDir,
          snapshotIndexPath
        });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Production update failed and rollback was incomplete');
      }
      throw error;
    }
    await unlinkIfExists(transactionPath);
    console.log(`Saved ${countries.length} countries and ${countries.length * parsed.tiers.length} prices using ${parsed.parser}.`);
  }
  try {
    await writeActionSummary(data, summary, stepSummaryPath);
  } catch (error) {
    console.warn(`Unable to write GitHub Actions summary: ${logInline(error.message)}`);
  }
  } finally {
    if (releaseLock) {
      try {
        await releaseLock();
      } catch (error) {
        console.warn(`Unable to release the iCloud price update lock: ${logInline(error.message)}`);
      }
    }
  }
}

export async function writeFailureDiagnostics(error, {
  diagnosticsDir = DIAGNOSTICS_DIR,
  appleSnapshot = lastAppleSnapshot,
  startedAt = runStartedAt,
  finishedAt = new Date(),
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY
} = {}) {
  const report = failureRunLogEntry(error, startedAt, finishedAt, Boolean(appleSnapshot));
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(diagnosticsDir, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (appleSnapshot) {
    await writeFile(
      path.join(diagnosticsDir, 'apple-snapshot.json'),
      `${JSON.stringify(appleSnapshot, null, 2)}\n`,
      'utf8'
    );
  }
  if (stepSummaryPath) {
    await appendFile(stepSummaryPath, [
      '## iCloud+ 价格更新',
      '',
      '### 失败',
      '- **状态：失败**',
      `- 触发方式：${describeTriggerSource(report.trigger)}`,
      `- 失败时间（北京时间）：${formatBeijingDateTime(finishedAt)}`,
      `- **失败原因：${markdownInline(error?.message ?? error)}**`,
      `- Apple 规范化 JSON：${report.appleSnapshotCaptured ? '已保存到运行附件' : '解析完成前失败，未生成'}`,
      '',
      '### 处理建议',
      '- 请先查看当前失败步骤日志，再下载 `icloud-price-diagnostics-*` 附件。',
      ''
    ].join('\n'), 'utf8');
  }
  return report;
}

async function handleFailure(error) {
  console.error(`iCloud price update failed: ${logInline(redactDiagnosticText(error?.message ?? error))}`);
  try {
    await writeFailureDiagnostics(error);
  } catch (diagnosticError) {
    console.error(`Unable to save diagnostics: ${logInline(redactDiagnosticText(diagnosticError.message))}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(handleFailure);
}
