import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMissingExchangeRates, parseApplePrices, TIERS, validatePrices } from './parse-prices.mjs';

const APPLE_URL = 'https://support.apple.com/en-us/108047';
const FX_URL = 'https://open.er-api.com/v6/latest/USD';
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_DATA_PATH = path.join(PROJECT_DIR, 'data/prices.json');
const HISTORY_PATH = path.join(PROJECT_DIR, 'data/history.json');
const NAMES_PATH = path.join(PROJECT_DIR, 'scripts/country-names.zh.json');
const DIAGNOSTICS_DIR = path.join(PROJECT_DIR, 'artifacts');
const RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000];
const DRY_RUN = process.argv.includes('--dry-run');
let lastAppleHtml = null;

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

async function getExchangeRates(previousData) {
  try {
    const payload = await fetchResource(FX_URL, { json: true, attempts: 3 });
    if (payload?.result !== 'success' || payload?.base_code !== 'USD' || !payload?.rates?.CNY) {
      throw new Error('Exchange-rate response is missing required fields');
    }
    return {
      sourceUrl: FX_URL,
      base: 'USD',
      fetchedAt: new Date(payload.time_last_update_unix * 1000).toISOString(),
      stale: false,
      rates: { ...(previousData?.fx?.rates ?? {}), ...payload.rates }
    };
  } catch (error) {
    if (!previousData?.fx?.rates?.CNY) throw error;
    console.warn(`Exchange-rate update failed; keeping previous rates: ${error.message}`);
    return { ...previousData.fx, stale: true };
  }
}

function snapshotPlans(country) {
  return Object.fromEntries(TIERS.map(({ id }) => [id, country.plans[id].price]));
}

function hasPriceChange(previousEvent, country) {
  if (!previousEvent || previousEvent.currency !== country.currency) return true;
  return TIERS.some(({ id }) => previousEvent.plans[id] !== country.plans[id].price);
}

function updateHistory(previousHistory, countries, observedAt) {
  const history = previousHistory ?? { schemaVersion: 1, countries: {} };
  history.schemaVersion = 1;
  history.updatedAt = new Date().toISOString();

  for (const country of countries) {
    const record = history.countries[country.country] ?? {
      nameZh: country.nameZh,
      region: country.region,
      events: []
    };
    record.nameZh = country.nameZh;
    record.region = country.region;

    const previousEvent = record.events.at(-1);
    if (hasPriceChange(previousEvent, country)) {
      record.events.push({
        observedAt,
        currency: country.currency,
        plans: snapshotPlans(country)
      });
    }
    history.countries[country.country] = record;
  }
  return history;
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

async function writeActionSummary(data, missingRates) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = [
    '## iCloud+ price update',
    '',
    `- Status: success`,
    `- Countries and regions: ${data.countries.length}`,
    `- Prices: ${data.countries.length * data.tiers.length}`,
    `- Apple published date: ${data.source.publishedDate ?? 'unknown'}`,
    `- Exchange rates: ${data.fx.stale ? 'cached previous rates' : data.fx.fetchedAt}`,
    `- Missing currency rates: ${missingRates.length ? missingRates.join(', ') : 'none'}`,
    ''
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'), 'utf8');
}

async function main() {
  const [previousData, previousHistory, countryNames, html] = await Promise.all([
    readJson(CURRENT_DATA_PATH),
    readJson(HISTORY_PATH),
    readJson(NAMES_PATH, {}),
    fetchResource(APPLE_URL)
  ]);
  lastAppleHtml = html;

  if (!countryNames || Object.keys(countryNames).length < 60) {
    throw new Error('Chinese country-name mapping is missing or incomplete');
  }

  const parsed = parseApplePrices(html);
  validatePrices(parsed.countries, { previousCountries: previousData?.countries ?? [] });
  const countries = parsed.countries.map((country) => ({
    ...country,
    nameZh: countryNames[country.country] ?? country.country
  }));

  const fx = await getExchangeRates(previousData);
  const missingRates = getMissingExchangeRates(countries, fx.rates);
  if (missingRates.length) {
    throw new Error(`Exchange rates are missing for: ${missingRates.join(', ')}`);
  }
  const generatedAt = new Date().toISOString();
  const observedAt = generatedAt.slice(0, 10);
  const data = {
    schemaVersion: 1,
    generatedAt,
    source: {
      name: 'Apple Support',
      url: APPLE_URL,
      publishedDate: parsed.sourcePublishedDate
    },
    fx,
    tiers: TIERS,
    countries
  };
  const history = updateHistory(previousHistory, countries, observedAt);

  if (DRY_RUN) {
    console.log(`Live check passed: ${countries.length} countries and ${countries.length * TIERS.length} prices. No files were changed.`);
  } else {
    await writeJsonAtomic(CURRENT_DATA_PATH, data);
    await writeJsonAtomic(HISTORY_PATH, history);
    console.log(`Saved ${countries.length} countries and ${countries.length * TIERS.length} prices.`);
  }
  await writeActionSummary(data, missingRates);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mkdir(DIAGNOSTICS_DIR, { recursive: true });
    await writeFile(path.join(DIAGNOSTICS_DIR, 'update-failure.json'), `${JSON.stringify({
      failedAt: new Date().toISOString(),
      error: error.message,
      stack: error.stack
    }, null, 2)}\n`, 'utf8');
    if (lastAppleHtml) {
      await writeFile(path.join(DIAGNOSTICS_DIR, 'apple-response.html'), lastAppleHtml, 'utf8');
    }
  } catch (diagnosticError) {
    console.error(`Unable to save diagnostics: ${diagnosticError.message}`);
  }
  process.exitCode = 1;
});
