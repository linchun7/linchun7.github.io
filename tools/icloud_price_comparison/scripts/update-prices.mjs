import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getMissingExchangeRates,
  parseApplePrices,
  validatePriceChangeAnomalies,
  validatePrices
} from './parse-prices.mjs';

const APPLE_URL = 'https://support.apple.com/en-us/108047';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DATA_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const RUN_LOG_PATH = path.join(PROJECT_DIR, 'data/run-log.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const DIAGNOSTICS_DIR = path.join(PROJECT_DIR, 'artifacts');
const RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000];
const DRY_RUN = process.argv.includes('--dry-run');
let lastAppleHtml = null;
let runStartedAt = new Date();

async function fetchResource(url, { json = false, attempts = RETRY_DELAYS_MS.length } = {}) {
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
          'user-agent': 'Mozilla/5.0 (compatible; iCloud-Price-Comparison/2.0; +https://github.com/linchun7/linchun7.github.io)'
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
      console.warn(`Fetch attempt ${attempt}/${attempts} failed for ${url}: ${error.message}`);
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastError?.message}`);
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Unable to read valid JSON from ${path.basename(filePath)}: ${error.message}`);
  }
}

export async function getExchangeRates(previousData) {
  try {
    const payload = await fetchResource(FX_URL, { json: true, attempts: 3 });
    if (payload?.result !== 'success'
      || payload?.base_code !== 'USD'
      || !Number.isFinite(payload?.time_last_update_unix)
      || !Number.isFinite(payload?.rates?.CNY)
      || payload.rates.CNY <= 0) {
      throw new Error('Exchange-rate response is missing required fields');
    }
    return {
      sourceUrl: FX_URL,
      base: 'USD',
      fetchedAt: new Date(payload.time_last_update_unix * 1000).toISOString(),
      stale: false,
      rates: payload.rates
    };
  } catch (error) {
    if (!previousData?.fx?.rates?.CNY) throw error;
    console.warn(`Exchange-rate update failed; keeping previous rates: ${error.message}`);
    return { ...previousData.fx, stale: true };
  }
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

function formatBeijingDate(value) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
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
  let addedCountries = 0;
  let changedCountries = 0;

  for (const country of countries) {
    const existingRecord = history.countries[country.country];
    const record = existingRecord ?? {
      nameZh: country.nameZh,
      region: country.region,
      events: []
    };
    if (!existingRecord) addedCountries += 1;
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
  return { history, addedCountries, changedCountries };
}

export function publicationDateKey(value) {
  const text = String(value ?? '').trim();
  const englishDate = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (englishDate) {
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const month = monthNames.indexOf(englishDate[1].toLowerCase());
    if (month >= 0) return new Date(Date.UTC(Number(englishDate[3]), month, Number(englishDate[2]))).toISOString().slice(0, 10);
  }
  const dateOnly = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) return text;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? `raw:${String(value ?? '').trim()}` : new Date(parsed).toISOString().slice(0, 10);
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
  return {
    schemaVersion: 1,
    id: finishedAt.toISOString(),
    status: 'success',
    trigger: process.env.GITHUB_EVENT_NAME ?? 'local',
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
      exchangeRatesStale: Boolean(data.fx.stale)
    },
    counts: {
      countries: data.countries.length,
      pricePoints: data.countries.length * data.tiers.length,
      currencies: new Set(data.countries.map(({ currency }) => currency)).size,
      tiers: data.tiers.map(({ id, label }) => ({ id, label }))
    },
    changes: {
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

async function writeAppleSnapshot(html, startedAt) {
  const stamp = startedAt.toISOString().replaceAll(/[-:]/g, '').replace('.000Z', 'Z');
  await mkdir(DIAGNOSTICS_DIR, { recursive: true });
  await writeFile(path.join(DIAGNOSTICS_DIR, `apple-response-${stamp}.html`), html, 'utf8');
}

function failureRunLogEntry(error, startedAt, finishedAt) {
  return {
    schemaVersion: 1,
    id: finishedAt.toISOString(),
    status: 'failure',
    trigger: process.env.GITHUB_EVENT_NAME ?? 'local',
    startedAtUtc: startedAt.toISOString(),
    finishedAtUtc: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null
    },
    appleResponseCaptured: Boolean(lastAppleHtml)
  };
}

async function writeActionSummary(data, summary) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    '## iCloud+ 价格更新',
    '',
    '- 状态：成功',
    `- 触发方式：${process.env.GITHUB_EVENT_NAME ?? 'unknown'}`,
    `- 抓取完成时间（北京时间）：${formatBeijingDateTime(data.generatedAt)}`,
    `- Apple 页面标注日期：${data.source.publishedDate ?? 'unknown'}`,
    `- Apple 解析路径：${data.source.parser ?? 'unknown'}`,
    `- 解析冗余状态：${data.source.parserStatus ?? 'unknown'}`,
    `- Apple 发布日期记录：${summary.publishedDateHistory.length} 条`,
    `- 本次发布日期对应内容变化：${summary.publicationDateChanged ? `${summary.publicationChanges.changedCountries.length} 个地区内容变化、${summary.publicationChanges.addedCountries.length} 个新增地区、${summary.publicationChanges.removedCountries.length} 个移除地区、${summary.publicationChanges.addedTiers.length} 个新增容量、${summary.publicationChanges.removedTiers.length} 个移除容量` : '发布日期未变化'}`,
    `- 地区数量：${data.countries.length}`,
    `- 价格点数量：${data.countries.length * data.tiers.length}`,
    `- 本次新增地区：${summary.addedCountries.length ? summary.addedCountries.join('、') : '无'}`,
    `- 本次移除地区：${summary.removedCountries.length ? summary.removedCountries.join('、') : '无'}`,
    `- 检测到价格或币种变化：${summary.changedCountries} 个地区`,
    `- 历史记录覆盖：${Object.keys(summary.history.countries).length} 个地区`,
    `- 汇率数据时间（北京时间）：${formatBeijingDateTime(data.fx.fetchedAt)}`,
    `- 汇率状态：${data.fx.stale ? '沿用上次成功结果' : '本次成功获取'}`,
    `- 缺少汇率：${summary.missingRates.length ? summary.missingRates.join('、') : '无'}`,
    ''
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), 'utf8');
}

export async function main() {
  runStartedAt = new Date();
  const [previousData, previousHistory, previousRunLog, countryNames, html] = await Promise.all([
    readJson(CURRENT_DATA_PATH),
    readJson(HISTORY_PATH),
    readJson(RUN_LOG_PATH, { schemaVersion: 1, retention: 90, runs: [] }),
    readJson(NAMES_PATH, {}),
    fetchResource(APPLE_URL)
  ]);
  lastAppleHtml = html;
  if (!DRY_RUN) {
    try {
      await writeAppleSnapshot(html, runStartedAt);
    } catch (error) {
      console.warn(`Unable to save Apple HTML snapshot: ${error.message}`);
    }
  }

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

  const fx = await getExchangeRates(previousData);
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
  const addedCountries = publicationChanges.addedCountries.map(({ country }) => country);
  const removedCountries = publicationChanges.removedCountries.map(({ country }) => country);

  const summary = {
    history,
    missingRates,
    addedCountries,
    removedCountries,
    changedCountries: historyUpdate.changedCountries,
    publishedDateHistory,
    publicationDateChanged: publishedDateUpdate.changed,
    publicationChanges,
    observedAt
  };
  const run = createRunLogEntry(data, summary, runStartedAt, finishedAt);
  const runLog = buildRunLog(previousRunLog, run);

  if (DRY_RUN) {
    console.log(`Live check passed with ${parsed.parser}: ${countries.length} countries and ${countries.length * parsed.tiers.length} prices. No files were changed.`);
  } else {
    await writeJsonAtomic(CURRENT_DATA_PATH, data);
    await writeJsonAtomic(HISTORY_PATH, history);
    await writeJsonAtomic(RUN_LOG_PATH, runLog);
    console.log(`Saved ${countries.length} countries and ${countries.length * parsed.tiers.length} prices using ${parsed.parser}.`);
  }
  try {
    await writeActionSummary(data, summary);
  } catch (error) {
    console.warn(`Unable to write GitHub Actions summary: ${error.message}`);
  }
}

async function handleFailure(error) {
  console.error(error);
  try {
    const finishedAt = new Date();
    const report = failureRunLogEntry(error, runStartedAt, finishedAt);
    await mkdir(DIAGNOSTICS_DIR, { recursive: true });
    await writeFile(path.join(DIAGNOSTICS_DIR, 'run-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    await writeFile(path.join(DIAGNOSTICS_DIR, 'update-failure.json'), `${JSON.stringify({
      failedAt: finishedAt.toISOString(),
      error: error.message,
      stack: error.stack
    }, null, 2)}\n`, 'utf8');
    if (lastAppleHtml) {
      await writeAppleSnapshot(lastAppleHtml, runStartedAt);
      await writeFile(path.join(DIAGNOSTICS_DIR, 'apple-response.html'), lastAppleHtml, 'utf8');
    }
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, [
        '## iCloud+ 价格更新',
        '',
        '- 状态：失败',
        `- 触发方式：${report.trigger}`,
        `- 失败时间（北京时间）：${formatBeijingDateTime(finishedAt)}`,
        `- 失败原因：${error.message}`,
        `- Apple 原始响应：${report.appleResponseCaptured ? '已保存到运行附件' : '未获取到'}`,
        ''
      ].join('\n'), 'utf8');
    }
  } catch (diagnosticError) {
    console.error(`Unable to save diagnostics: ${diagnosticError.message}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(handleFailure);
}
