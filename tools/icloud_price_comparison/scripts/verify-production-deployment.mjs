import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePricePayload } from '../data-contract.js';
import { parseJsonStrictBytes, validateCoreDataArtifact } from './validate-data-artifact.mjs';
import { assertStaticPageMatches, publicPayloadFingerprint } from './static-page.mjs';

export const PRODUCTION_PRICES_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json';
export const PRODUCTION_HISTORY_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/history.json';
export const PRODUCTION_RUN_LOG_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/run-log.json';
export const PRODUCTION_INDEX_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/';
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1_000;
export const DEFAULT_INTERVAL_MS = 15 * 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1_000;
export const MAX_PRICES_RESPONSE_BYTES = 1024 * 1024;
export const MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_LOG_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HTML_RESPONSE_BYTES = 512 * 1024;
const JSON_FILES = [['prices', 'prices.json'], ['history', 'history.json'], ['runLog', 'run-log.json']];
export { publicPayloadFingerprint };

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8: ${error.message}`);
  }
}

function validateDeployablePrices(payload, label) {
  validatePricePayload(payload);
  if (payload.schemaVersion !== 4) throw new Error(`${label} schemaVersion is not 4`);
  if (payload.source?.parser !== 'cross-checked') throw new Error(`${label} parser is not cross-checked`);
  if (typeof payload.run?.finishedAtUtc !== 'string') throw new Error(`${label} run.finishedAtUtc is missing`);
  return payload;
}

function buildArtifact(values, raw, label) {
  validateDeployablePrices(values.prices, `${label} prices.json`);
  validateCoreDataArtifact(values);
  return { ...values, raw, hashes: Object.fromEntries(JSON_FILES.map(([key]) => [key, sha256(raw[key])])) };
}

export function createVerificationArtifact({ prices, history, runLog }, label = 'verification artifact') {
  const values = { prices, history, runLog };
  const raw = Object.fromEntries(JSON_FILES.map(([key]) => [key, Buffer.from(JSON.stringify(values[key]))]));
  return buildArtifact(values, raw, label);
}

export async function loadVerificationArtifact(dataDirectory, label = 'verification artifact') {
  const raw = Object.fromEntries(await Promise.all(JSON_FILES.map(async ([key, fileName]) => [
    key,
    await readFile(dataDirectory instanceof URL ? new URL(fileName, dataDirectory) : path.join(dataDirectory, fileName))
  ])));
  const values = Object.fromEntries(JSON_FILES.map(([key, fileName]) => [key, parseJsonStrictBytes(raw[key], `${label} ${fileName}`)]));
  return buildArtifact(values, raw, label);
}

function normalizeArtifact(artifact, label) {
  if (artifact?.raw && artifact?.hashes) {
    return buildArtifact({ prices: artifact.prices, history: artifact.history, runLog: artifact.runLog }, artifact.raw, label);
  }
  return createVerificationArtifact(artifact, label);
}

function requestOptions(signal) {
  return { cache: 'no-store', headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }, redirect: 'error', signal };
}

function verificationUrl(baseUrl, runId, attempt) {
  const url = new URL(baseUrl);
  url.searchParams.set('verify', `${runId}-${attempt}`);
  return url;
}

async function readBoundedResponse(response, { label, maxBytes, contentTypePattern }) {
  if (!response.ok) {
    const error = new Error(`${label} HTTP_${response.status}`);
    error.reason = `HTTP_${response.status}`;
    throw error;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentTypePattern.test(contentType)) throw new Error(`${label} unexpected content type: ${contentType || 'missing'}`);
  const declaredLength = response.headers.get('content-length');
  if (/^\d+$/.test(declaredLength ?? '') && Number(declaredLength) > maxBytes) throw new Error(`${label} response exceeds the size limit`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new Error(`${label} response exceeds the size limit`);
  return bytes;
}

async function fetchJsonResource(fetchImpl, url, signal, resource, maxBytes) {
  try {
    const response = await fetchImpl(url, requestOptions(signal));
    const bytes = await readBoundedResponse(response, {
      label: resource, maxBytes,
      contentTypePattern: /(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i
    });
    return { bytes, value: parseJsonStrictBytes(bytes, resource) };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    error.reason = error.reason?.startsWith('HTTP_')
      ? `${resource}:${error.reason}`
      : error.reason ?? `${resource}-invalid:${String(error.message).slice(0, 140).replace(/[\r\n]+/g, ' ')}`;
    throw error;
  }
}

async function fetchHtmlResource(fetchImpl, url, signal) {
  try {
    const response = await fetchImpl(url, requestOptions(signal));
    const bytes = await readBoundedResponse(response, {
      label: 'index.html', maxBytes: MAX_HTML_RESPONSE_BYTES, contentTypePattern: /text\/html\b/i
    });
    return decodeUtf8(bytes, 'index.html');
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    error.reason = error.reason?.startsWith('HTTP_')
      ? `index:${error.reason}`
      : error.reason ?? `index-invalid:${String(error.message).slice(0, 140).replace(/[\r\n]+/g, ' ')}`;
    throw error;
  }
}

function classifyArtifactValidationError(error) {
  const message = String(error?.message ?? error).slice(0, 160).replace(/[\r\n]+/g, ' ');
  if (/run-log\.json/i.test(message)) return `run-log-invalid:${message}`;
  if (/history|price history/i.test(message)) return `history-invalid:${message}`;
  return `prices-invalid:${message}`;
}

const artifactHashesMatch = (left, right) => JSON_FILES.every(([key]) => left.hashes[key] === right.hashes[key]);
const safeObservedTimestamp = (value) => (typeof value === 'string' && value.length <= 40 ? value : null);
const resultResources = () => ({
  'prices.json': 'verified',
  'history.json': 'verified',
  'run-log.json': 'verified',
  'index.html': 'verified against prices.json'
});

export async function verifyProductionDeployment(expectedArtifact, {
  productionPricesUrl = PRODUCTION_PRICES_URL,
  productionHistoryUrl = PRODUCTION_HISTORY_URL,
  productionRunLogUrl = PRODUCTION_RUN_LOG_URL,
  productionIndexUrl = PRODUCTION_INDEX_URL,
  runId = 'local', maxWaitMs = DEFAULT_MAX_WAIT_MS, intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = () => Date.now(),
  getCurrentMainArtifact = async () => null, log = console.log
} = {}) {
  const expected = normalizeArtifact(expectedArtifact, 'expected artifact');
  const expectedFingerprint = publicPayloadFingerprint(expected.prices);
  const startedAt = now();
  let attempts = 0;
  let lastObservedGeneratedAt = null;
  let lastReason = 'not-requested';

  do {
    attempts += 1;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const [pricesResult, historyResult, runLogResult, productionHtml] = await Promise.all([
        fetchJsonResource(fetchImpl, verificationUrl(productionPricesUrl, runId, attempts), controller.signal, 'prices', MAX_PRICES_RESPONSE_BYTES),
        fetchJsonResource(fetchImpl, verificationUrl(productionHistoryUrl, runId, attempts), controller.signal, 'history', MAX_HISTORY_RESPONSE_BYTES),
        fetchJsonResource(fetchImpl, verificationUrl(productionRunLogUrl, runId, attempts), controller.signal, 'run-log', MAX_RUN_LOG_RESPONSE_BYTES),
        fetchHtmlResource(fetchImpl, verificationUrl(productionIndexUrl, runId, attempts), controller.signal)
      ]);
      let observed;
      try {
        observed = buildArtifact(
          { prices: pricesResult.value, history: historyResult.value, runLog: runLogResult.value },
          { prices: pricesResult.bytes, history: historyResult.bytes, runLog: runLogResult.bytes },
          'production artifact'
        );
      } catch (error) {
        error.reason = classifyArtifactValidationError(error);
        throw error;
      }
      lastObservedGeneratedAt = safeObservedTimestamp(observed.prices.generatedAt);
      try {
        assertStaticPageMatches(productionHtml, observed.prices);
      } catch (error) {
        error.reason = `STATIC_RENDER_MISMATCH:${String(error.message).slice(0, 120).replace(/[\r\n]+/g, ' ')}`;
        throw error;
      }

      const pricesMatch = observed.hashes.prices === expected.hashes.prices
        && publicPayloadFingerprint(observed.prices) === expectedFingerprint
        && observed.prices.generatedAt === expected.prices.generatedAt
        && observed.prices.run.finishedAtUtc === expected.prices.run.finishedAtUtc;
      if (pricesMatch && observed.hashes.history === expected.hashes.history && observed.hashes.runLog === expected.hashes.runLog) {
        const result = { status: 'deployed', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.prices.generatedAt, observedGeneratedAt: observed.prices.generatedAt, resources: resultResources() };
        log(`Production verification passed on attempt ${attempts}: ${observed.prices.generatedAt}`);
        return result;
      }

      if (Date.parse(observed.prices.generatedAt) > Date.parse(expected.prices.generatedAt)) {
        const currentMainCandidate = await getCurrentMainArtifact();
        if (currentMainCandidate) {
          let currentMain;
          try {
            currentMain = normalizeArtifact(currentMainCandidate, 'current main artifact');
          } catch (error) {
            error.reason = `current-main-invalid:${String(error.message).slice(0, 140).replace(/[\r\n]+/g, ' ')}`;
            throw error;
          }
          if (artifactHashesMatch(observed, currentMain)
            && publicPayloadFingerprint(observed.prices) === publicPayloadFingerprint(currentMain.prices)) {
            const result = { status: 'superseded', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.prices.generatedAt, observedGeneratedAt: observed.prices.generatedAt, resources: resultResources() };
            log(`Production verification passed with a newer committed deployment on attempt ${attempts}: ${observed.prices.generatedAt}`);
            return result;
          }
          if (observed.hashes.prices === currentMain.hashes.prices) {
            if (observed.hashes.history !== currentMain.hashes.history) lastReason = 'history-not-deployed';
            else if (observed.hashes.runLog !== currentMain.hashes.runLog) lastReason = 'run-log-not-deployed';
            else lastReason = 'newer-version-unproven';
          } else lastReason = 'newer-version-unproven';
        } else {
          lastReason = 'newer-version-unproven';
        }
      } else if (!pricesMatch) lastReason = 'prices-not-deployed';
      else if (observed.hashes.history !== expected.hashes.history) lastReason = 'history-not-deployed';
      else lastReason = 'run-log-not-deployed';
    } catch (error) {
      lastReason = error?.name === 'AbortError'
        ? 'request-timeout'
        : error.reason ?? `retryable-response:${String(error?.message ?? error).slice(0, 160).replace(/[\r\n]+/g, ' ')}`;
    } finally {
      clearTimeout(timeout);
    }
    log(`Production verification attempt ${attempts}: observed=${lastObservedGeneratedAt ?? 'unavailable'} result=${lastReason}`);
    const remainingMs = maxWaitMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  } while (now() - startedAt <= maxWaitMs);

  const elapsedMs = now() - startedAt;
  const error = new Error(`PUBLISH_PRODUCTION_NOT_UPDATED: expected=${expected.prices.generatedAt} observed=${lastObservedGeneratedAt ?? 'unavailable'} attempts=${attempts} elapsedMs=${elapsedMs} reason=${lastReason}`);
  error.code = 'PUBLISH_PRODUCTION_NOT_UPDATED';
  error.details = { attempts, elapsedMs, expectedGeneratedAt: expected.prices.generatedAt, lastObservedGeneratedAt, lastReason };
  throw error;
}

function parseCliArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value == null) throw new Error(`Invalid argument: ${name ?? 'missing'}`);
    values.set(name, value);
  }
  if (!values.get('--expected-data-dir')) throw new Error('--expected-data-dir is required');
  const options = {
    expectedDataDir: values.get('--expected-data-dir'), currentMainDataDir: values.get('--current-main-data-dir') ?? null,
    runId: values.get('--run-id') ?? 'local', summaryFile: values.get('--summary-file') ?? null,
    maxWaitMs: values.has('--max-wait-ms') ? Number(values.get('--max-wait-ms')) : DEFAULT_MAX_WAIT_MS,
    intervalMs: values.has('--interval-ms') ? Number(values.get('--interval-ms')) : DEFAULT_INTERVAL_MS
  };
  if (!Number.isFinite(options.maxWaitMs) || options.maxWaitMs <= 0 || options.maxWaitMs > 10 * 60 * 1_000) throw new Error('--max-wait-ms must be between 1 and 600000');
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > options.maxWaitMs) throw new Error('--interval-ms must be positive and no greater than --max-wait-ms');
  return options;
}

function summaryLines(result) {
  return ['## Production verification', '', '- prices.json: verified', '- history.json: verified', '- run-log.json: verified', '- index.html: verified against prices.json', `- Status: ${result.status}`, `- Expected generatedAt: ${result.expectedGeneratedAt}`, `- Observed generatedAt: ${result.observedGeneratedAt}`, `- Attempts: ${result.attempts}`, `- Elapsed: ${(result.elapsedMs / 1_000).toFixed(1)}s`, ''];
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const expected = await loadVerificationArtifact(options.expectedDataDir, 'expected artifact');
  const getCurrentMainArtifact = options.currentMainDataDir
    ? async () => loadVerificationArtifact(options.currentMainDataDir, 'current main artifact')
    : async () => null;
  try {
    const result = await verifyProductionDeployment(expected, { ...options, getCurrentMainArtifact });
    if (options.summaryFile) await appendFile(options.summaryFile, summaryLines(result).join('\n'), 'utf8');
  } catch (error) {
    if (options.summaryFile) {
      const details = error.details ?? {};
      await appendFile(options.summaryFile, ['## Production verification', '', `- Status: ${error.code ?? 'failed'}`, `- Expected generatedAt: ${details.expectedGeneratedAt ?? expected.prices.generatedAt}`, `- Last observed generatedAt: ${details.lastObservedGeneratedAt ?? 'unavailable'}`, `- Last reason: ${details.lastReason ?? 'unavailable'}`, `- Attempts: ${details.attempts ?? 0}`, `- Elapsed: ${((details.elapsedMs ?? 0) / 1_000).toFixed(1)}s`, ''].join('\n'), 'utf8');
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await runCli();
