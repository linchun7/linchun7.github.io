import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getMissingExchangeRates,
  parseApplePrices,
  validatePriceChangeAnomalies,
  validatePrices
} from './parse-prices.mjs';
import { describeTriggerSource, formatBeijingDate, resolveTriggerSource } from './run-context.mjs';

const APPLE_URL = 'https://support.apple.com/en-us/108047';
const FX_AUTH_URL = 'https://v6.exchangerate-api.com/v6/latest/USD';
const FX_OPEN_URL = 'https://open.er-api.com/v6/latest/USD';
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DATA_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const RUN_LOG_PATH = path.join(PROJECT_DIR, 'data/run-log.json');
const APPLE_SNAPSHOTS_DIR = path.join(PROJECT_DIR, 'data/apple-snapshots');
const APPLE_SNAPSHOT_INDEX_PATH = path.join(APPLE_SNAPSHOTS_DIR, 'index.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const DIAGNOSTICS_DIR = path.join(PROJECT_DIR, 'artifacts');
const RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000];
const DRY_RUN = process.argv.includes('--dry-run');
let lastAppleHtml = null;
let runStartedAt = new Date();

async function fetchResource(url, {
  json = false,
  attempts = RETRY_DELAYS_MS.length,
  headers = {},
  resourceName = url
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS.at(-1);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: {
          accept: json ? 'application/json' : 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
          'cache-control': attempt === 1 ? 'max-age=0' : 'no-cache',
          'user-agent': 'Mozilla/5.0 (compatible; iCloud-Price-Comparison/2.0; +https://github.com/linchun7/linchun7.github.io)',
          ...headers
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(45_000)
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = await response.text();
      if (!json && (body.length < 20_000 || !body.includes('50 GB'))) {
        throw new Error(`Unexpected Apple response (${body.length} bytes)`);
      }
      return json ? JSON.parse(body) : body;
    } catch (error) {
      lastError = error;
      console.warn(`Fetch attempt ${attempt}/${attempts} failed for ${resourceName}: ${error.message}`);
    }
  }
  throw new Error(`Failed to fetch ${resourceName}: ${lastError?.message}`);
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

export async function getExchangeRates(previousData, {
  apiKey = process.env.EXCHANGE_RATE_API_KEY,
  requiredCurrencies = []
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
        resourceName: source.resourceName
      });
      const parsed = parseExchangeRatePayload(payload, source.ratesField);
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
        console.info(`汇率 Key 接口不可用（${describeExchangeRateFallback(fallbackReason)}），已使用开放接口。`);
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
        rates: parsed.rates
      };
    } catch (error) {
      failures.push({
        sourceMode: source.sourceMode,
        reason: error.fxReason ?? 'request-failed',
        message: error.message
      });
    }
  }

  const previousUsd = previousData?.fx?.rates?.USD;
  const previousCny = previousData?.fx?.rates?.CNY;
  const failureMessage = failures.map(({ sourceMode, message }) => `${sourceMode}: ${message}`).join('; ');
  if (previousUsd !== 1 || !Number.isFinite(previousCny) || previousCny <= 0) {
    throw new Error(failureMessage || 'Exchange-rate update failed');
  }
  console.warn(`Exchange-rate update failed; keeping previous rates: ${failureMessage}`);
  return {
    ...previousData.fx,
    stale: true,
    fallbackUsed: Boolean(normalizedApiKey),
    fallbackReason: failures[0]?.reason ?? 'request-failed',
    apiKeyStatus: normalizedApiKey ? failures[0]?.reason ?? 'request-failed' : 'not-configured'
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

function githubAnnotationValue(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function snapshotPlans(country, tiers) {
  return Object.fromEntries(tiers.map(({ id }) => [id, country.plans[id].price]));
}

function hasPriceChange(previousEvent, country, tiers) {
  if (!previousEvent || previousEvent.currency !== country.currency) return true;
  return tiers.some(({ id }) => previousEvent.plans[id] !== country.plans[id].price);
}

export function updateHistory(previousHistory, countries, observedAt, tiers, observedAtUtc = null) {
  const history = previousHistory ?? { schemaVersion: 2, countries: {} };
  history.schemaVersion = 2;
  history.updatedAt = new Date().toISOString();
  let changedCountries = 0;

  for (const country of countries) {
    const existingRecord = history.countries[country.country];
    const record = existingRecord ?? {
      nameZh: country.nameZh,
      region: country.region,
      events: []
    };
    record.nameZh = country.nameZh;
    record.region = country.region;

    const previousEvent = record.events.at(-1);
    if (hasPriceChange(previousEvent, country, tiers)) {
      changedCountries += 1;
      record.events.push({
        observedAt,
        ...(observedAtUtc ? { observedAtBeijing: observedAt } : {}),
        ...(observedAtUtc ? { observedAtUtc } : {}),
        currency: country.currency,
        plans: snapshotPlans(country, tiers)
      });
    }
    history.countries[country.country] = record;
  }
  return { history, changedCountries };
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
  const previousByCountry = new Map((previousData?.countries ?? []).map((country) => [country.country, country]));
  const currentByCountry = new Map(countries.map((country) => [country.country, country]));
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
    .filter(({ country }) => !previousByCountry.has(country))
    .map(({ country, nameZh }) => ({ country, nameZh }));
  const removedCountries = [...previousByCountry.values()]
    .filter(({ country }) => !currentByCountry.has(country))
    .map(({ country, nameZh }) => ({ country, nameZh: nameZh || country }));
  const changedCountries = [];

  for (const country of countries) {
    const previous = previousByCountry.get(country.country);
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
  for (const entry of (Array.isArray(history.sourcePublishedDates) ? history.sourcePublishedDates : [])) {
    if (!entry || typeof entry.publishedDate !== 'string' || typeof entry.observedAt !== 'string') continue;
    if (publicationDateKey(entries.at(-1)?.publishedDate) === publicationDateKey(entry.publishedDate)) continue;
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
  return { entries, changed };
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export function createRunLogEntry(data, summary, startedAt, finishedAt) {
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
    id: finishedAt.toISOString(),
    status: 'success',
    trigger,
    automaticRunDateBeijing: process.env.ICLOUD_AUTOMATIC_RUN_DATE_BEIJING || null,
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
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
      exchangeRatesFallbackReason: data.fx.fallbackReason ?? null,
      exchangeRatesApiKeyStatus: data.fx.apiKeyStatus ?? null
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

export function buildRunLog(existing, entry) {
  if (existing?.schemaVersion !== 1 || !Array.isArray(existing.runs)) {
    throw new Error('Run log has an unsupported structure');
  }
  return {
    schemaVersion: 1,
    retention: 90,
    updatedAtUtc: entry.finishedAtUtc,
    runs: [...existing.runs, entry].slice(-90)
  };
}

async function writeAppleSnapshot(html, startedAt, diagnosticsDir = DIAGNOSTICS_DIR) {
  const stamp = startedAt.toISOString().replaceAll(/[-:]/g, '').replace('.000Z', 'Z');
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(diagnosticsDir, `apple-response-${stamp}.html`), html, 'utf8');
}

function failureRunLogEntry(error, startedAt, finishedAt, appleResponseCaptured = Boolean(lastAppleHtml)) {
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
      message: error.message,
      stack: error.stack ?? null
    },
    appleResponseCaptured
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
  contentHash
} = {}) {
  const publishedDateIso = publicationDateKey(publishedDate);
  if (!publishedDateIso) throw new Error('Apple snapshot published date is invalid');
  return {
    publishedDate: publishedDateIso,
    file: `${publishedDateIso}.html`,
    dataFile: `${publishedDateIso}.json`,
    firstConfirmedDate,
    sourceUrl,
    ...(archiveUrl ? { archiveUrl } : {}),
    parser,
    countries,
    pricePoints,
    contentHash
  };
}

export function appleSnapshotContentHash(parsed) {
  return createHash('sha256').update(JSON.stringify(normalizeApplePricing(parsed))).digest('hex');
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
        .map(([tier, value]) => [tier, value.price])
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

export function buildAppleSnapshotIndex(existing, entry) {
  const snapshots = Array.isArray(existing?.snapshots) ? existing.snapshots : [];
  const byDate = new Map(snapshots.map((item) => [item.publishedDate, item]));
  const current = byDate.get(entry.publishedDate);
  if (!current) {
    byDate.set(entry.publishedDate, {
      publishedDate: entry.publishedDate,
      activeFile: entry.file,
      activeDataFile: entry.dataFile,
      activeContentHash: entry.contentHash,
      revisions: [entry]
    });
  } else {
    const revisions = Array.isArray(current.revisions) ? current.revisions : [current];
    if (!revisions.some(({ contentHash }) => contentHash === entry.contentHash)) {
      const orderedRevisions = [...revisions, entry].sort((a, b) => (
        (a.firstConfirmedDate ?? '').localeCompare(b.firstConfirmedDate ?? '')
      ));
      const activeRevision = orderedRevisions.at(-1);
      byDate.set(entry.publishedDate, {
        ...current,
        activeFile: activeRevision.file,
        activeDataFile: activeRevision.dataFile,
        activeContentHash: activeRevision.contentHash,
        revisions: orderedRevisions
      });
    }
  }
  return {
    schemaVersion: 1,
    snapshots: [...byDate.values()].sort((a, b) => a.publishedDate.localeCompare(b.publishedDate))
  };
}

export async function savePublishedAppleSnapshot(html, parsed, firstConfirmedDate, {
  snapshotsDir = APPLE_SNAPSHOTS_DIR,
  indexPath = APPLE_SNAPSHOT_INDEX_PATH
} = {}) {
  const publishedDate = publicationDateKey(parsed.sourcePublishedDate);
  const contentHash = appleSnapshotContentHash(parsed);
  const index = await readJson(indexPath, { schemaVersion: 1, snapshots: [] });
  const existing = index.snapshots?.find((item) => item.publishedDate === publishedDate);
  const revisions = Array.isArray(existing?.revisions) ? existing.revisions : existing ? [existing] : [];
  if (revisions.some((revision) => revision.contentHash === contentHash)) return false;
  const file = existing ? `${publishedDate}-${contentHash.slice(0, 12)}.html` : `${publishedDate}.html`;
  const entry = buildAppleSnapshotEntry(parsed.sourcePublishedDate, {
    firstConfirmedDate,
    parser: parsed.parser,
    countries: parsed.countries.length,
    pricePoints: parsed.countries.length * parsed.tiers.length,
    contentHash
  });
  entry.file = file;
  entry.dataFile = file.replace(/\.html$/, '.json');
  const snapshotPath = path.join(snapshotsDir, entry.file);
  const dataPath = path.join(snapshotsDir, entry.dataFile);
  try {
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(snapshotPath, html, 'utf8');
    await writeJsonAtomic(dataPath, normalizeAppleSnapshot(parsed));
    await writeJsonAtomic(indexPath, buildAppleSnapshotIndex(index, entry));
  } catch (error) {
    await Promise.allSettled([
      unlink(snapshotPath),
      unlink(dataPath),
      unlink(`${indexPath}.tmp`)
    ]);
    throw error;
  }
  return true;
}

function summarizeChangedCountries(entries) {
  return summarizeNames(entries.map(({ nameZh, country }) => nameZh || country));
}

function describeParser(data) {
  const parser = data.source.parser ?? 'unknown';
  if (parser === 'cross-checked') return `${parser}（双解析器一致）`;
  return `${parser}（${data.source.parserStatus ?? 'unknown'}）`;
}

function describeExchangeRateSource(fx) {
  if (fx.stale) return '上一份有效汇率';
  if (fx.sourceMode === 'api-key') return 'ExchangeRate-API Key 接口（主来源）';
  if (fx.fallbackUsed) return 'ExchangeRate-API 开放接口（自动回退）';
  return 'ExchangeRate-API 开放接口';
}

function describeExchangeRateFallback(reason) {
  const labels = {
    'quota-reached': 'API 额度已用完',
    'invalid-key': 'API Key 无效',
    'inactive-account': 'API 账户未激活',
    'unsupported-code': 'API 不支持请求的币种',
    'malformed-request': 'API 请求格式无效',
    'missing-rates': '主接口缺少所需币种',
    'invalid-response': '主接口响应校验失败',
    'request-failed': '主接口请求失败'
  };
  return labels[reason] ?? '主接口不可用';
}

function describeExchangeRateAuthentication(fx) {
  if (fx.apiKeyStatus === 'valid') return 'API Key 有效';
  if (fx.apiKeyStatus === 'not-configured') {
    return fx.stale ? '未配置 API Key，开放接口失败' : '未配置 API Key，使用开放接口';
  }
  return fx.stale
    ? `${describeExchangeRateFallback(fx.apiKeyStatus)}，开放接口也不可用`
    : `${describeExchangeRateFallback(fx.apiKeyStatus)}，使用开放接口`;
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
    changes.push(`Apple 发布日期：${previousDate} → ${data.source.publishedDate ?? 'unknown'}`);
  }
  if (publicationChanges.addedTiers.length) {
    changes.push(`新增容量：${publicationChanges.addedTiers.map(({ label, id }) => label || id).join('、')}`);
  }
  if (publicationChanges.removedTiers.length) {
    changes.push(`移除容量：${publicationChanges.removedTiers.map(({ label, id }) => label || id).join('、')}`);
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
  if (summary.missingRates.length) warnings.push(`- **缺少汇率**：${summary.missingRates.join('、')}`);

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
    `- 历史记录覆盖：${Object.keys(summary.history?.countries ?? {}).length} 个地区`,
    `- Apple 页面标注日期：${data.source.publishedDate ?? 'unknown'}`,
    `- Apple 发布日期记录：${summary.publishedDateHistory.length} 条`,
    '',
    '### 校验与来源',
    `- Apple 解析路径：${describeParser(data)}`,
    `- 汇率来源：${describeExchangeRateSource(data.fx)}`,
    `- 汇率认证：${describeExchangeRateAuthentication(data.fx)}`,
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
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY
} = {}) {
  const currentDataPath = paths.currentDataPath ?? CURRENT_DATA_PATH;
  const historyPath = paths.historyPath ?? HISTORY_PATH;
  const runLogPath = paths.runLogPath ?? RUN_LOG_PATH;
  const namesPath = paths.namesPath ?? NAMES_PATH;
  const snapshotsDir = paths.snapshotsDir ?? APPLE_SNAPSHOTS_DIR;
  const snapshotIndexPath = paths.snapshotIndexPath ?? APPLE_SNAPSHOT_INDEX_PATH;
  runStartedAt = new Date();
  const [previousData, previousHistory, previousRunLog, countryNames, html] = await Promise.all([
    readJson(currentDataPath),
    readJson(historyPath),
    readJson(runLogPath, { schemaVersion: 1, retention: 90, runs: [] }),
    readJson(namesPath, {}),
    fetchResource(APPLE_URL)
  ]);
  lastAppleHtml = html;
  if (!countryNames || Object.keys(countryNames).length < 60) {
    throw new Error('Chinese country-name mapping is missing or incomplete');
  }

  const parsed = parseApplePrices(html);
  if (parsed.parser !== 'cross-checked') {
    console.warn(`Apple parser redundancy degraded: ${parsed.parserStatus}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning title=Apple parser redundancy::${githubAnnotationValue(parsed.parserStatus)}`);
    }
  }
  if (!parsed.sourcePublishedDate || !/^\d{4}-\d{2}-\d{2}$/.test(publicationDateKey(parsed.sourcePublishedDate))) {
    throw new Error('Apple published date was not found or has an unsupported format');
  }
  validatePrices(parsed.countries, {
    tiers: parsed.tiers,
    previousCountries: previousData?.countries ?? []
  });
  const countries = parsed.countries.map((country) => ({
    ...country,
    nameZh: countryNames[country.country] ?? country.country
  }));

  const fx = await getExchangeRates(previousData, {
    requiredCurrencies: [...new Set(countries.map(({ currency }) => currency))]
  });
  if (process.env.GITHUB_ACTIONS === 'true' && fx.apiKeyStatus === 'not-configured') {
    console.log('::notice title=未配置汇率 API Key::已直接使用开放接口，价格更新继续执行。');
  } else if (process.env.GITHUB_ACTIONS === 'true' && fx.apiKeyStatus !== 'valid') {
    const handling = fx.stale ? '已沿用上一份有效汇率' : '已使用开放接口';
    console.log(`::notice title=汇率 API Key 未生效::${githubAnnotationValue(`${describeExchangeRateFallback(fx.apiKeyStatus)}，${handling}。`)}`);
  }
  if (process.env.GITHUB_ACTIONS === 'true' && fx.stale) {
    console.log('::warning title=汇率更新失败::两个在线汇率来源均不可用，已沿用上一份有效汇率。');
  }
  const missingRates = getMissingExchangeRates(countries, fx.rates);
  if (missingRates.length) {
    throw new Error(`Exchange rates are missing for: ${missingRates.join(', ')}`);
  }
  validatePriceChangeAnomalies(countries, {
    previousData,
    currentRates: fx.rates,
    tiers: parsed.tiers
  });
  const generatedAt = new Date().toISOString();
  const observedAt = formatBeijingDate(generatedAt);
  const finishedAt = new Date(generatedAt);
  const data = {
    schemaVersion: 2,
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
    fx,
    tiers: parsed.tiers,
    countries
  };
  const publicationChanges = buildSnapshotChanges(previousData, countries, parsed.tiers);
  const historyUpdate = updateHistory(previousHistory, countries, observedAt, parsed.tiers, generatedAt);
  const history = historyUpdate.history;
  const publishedDateUpdate = updatePublishedDateHistory(history, previousData, parsed.sourcePublishedDate, observedAt, publicationChanges, generatedAt);
  const publishedDateHistory = publishedDateUpdate.entries;
  if (!dryRun) {
    await savePublishedAppleSnapshot(html, parsed, observedAt, {
      snapshotsDir,
      indexPath: snapshotIndexPath
    });
  }
  const summary = {
    history,
    missingRates,
    publishedDateHistory,
    publicationDateChanged: publishedDateUpdate.changed,
    publicationChanges,
    observedAt
  };
  const run = createRunLogEntry(data, summary, runStartedAt, finishedAt);
  const runLog = buildRunLog(previousRunLog, run);

  if (dryRun) {
    console.log(`Live check passed with ${parsed.parser}: ${countries.length} countries and ${countries.length * parsed.tiers.length} prices. No files were changed.`);
  } else {
    await writeJsonAtomic(currentDataPath, data);
    await writeJsonAtomic(historyPath, history);
    await writeJsonAtomic(runLogPath, runLog);
    console.log(`Saved ${countries.length} countries and ${countries.length * parsed.tiers.length} prices using ${parsed.parser}.`);
  }
  try {
    await writeActionSummary(data, summary, stepSummaryPath);
  } catch (error) {
    console.warn(`Unable to write GitHub Actions summary: ${error.message}`);
  }
}

export async function writeFailureDiagnostics(error, {
  diagnosticsDir = DIAGNOSTICS_DIR,
  appleHtml = lastAppleHtml,
  startedAt = runStartedAt,
  finishedAt = new Date(),
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY
} = {}) {
  const report = failureRunLogEntry(error, startedAt, finishedAt, Boolean(appleHtml));
  await mkdir(diagnosticsDir, { recursive: true });
  await writeFile(path.join(diagnosticsDir, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (appleHtml) {
    await writeAppleSnapshot(appleHtml, startedAt, diagnosticsDir);
  }
  if (stepSummaryPath) {
    await appendFile(stepSummaryPath, [
      '## iCloud+ 价格更新',
      '',
      '### 失败',
      '- **状态：失败**',
      `- 触发方式：${describeTriggerSource(report.trigger)}`,
      `- 失败时间（北京时间）：${formatBeijingDateTime(finishedAt)}`,
      `- **失败原因：${error.message}**`,
      `- Apple 原始响应：${report.appleResponseCaptured ? '已保存到运行附件' : '未获取到'}`,
      '',
      '### 处理建议',
      '- 请先查看当前失败步骤日志，再下载 `icloud-price-diagnostics-*` 附件。',
      ''
    ].join('\n'), 'utf8');
  }
  return report;
}

async function handleFailure(error) {
  console.error(error);
  try {
    await writeFailureDiagnostics(error);
  } catch (diagnosticError) {
    console.error(`Unable to save diagnostics: ${diagnosticError.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(handleFailure);
}
