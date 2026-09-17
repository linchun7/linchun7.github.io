import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePricePayload } from '../data-contract.js';
import { parseJsonStrictBytes, validateCoreDataArtifact } from './validate-data-artifact.mjs';
import { assertStaticPageMatches, publicPayloadFingerprint } from './static-page.mjs';

export const PRODUCTION_PRICES_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json';
export const PRODUCTION_HISTORY_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/history.json';
export const PRODUCTION_RUN_LOG_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/run-log.json';
export const PRODUCTION_INDEX_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/';
export const PRODUCTION_ASSET_BASE_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/';
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1_000;
export const DEFAULT_INTERVAL_MS = 15 * 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1_000;
export const MAX_PRICES_RESPONSE_BYTES = 1024 * 1024;
export const MAX_HISTORY_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_RUN_LOG_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_STATIC_ASSET_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTML_RESPONSE_BYTES = 512 * 1024;
const JSON_FILES = [['prices', 'prices.json'], ['history', 'history.json'], ['runLog', 'run-log.json']];
const PROJECT_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = path.resolve(PROJECT_DIRECTORY, '../..');
const PROJECT_REPOSITORY_PATH = 'tools/icloud_price_comparison';
const execFileAsync = promisify(execFileCallback);

export const CORE_STATIC_ASSETS = Object.freeze([
  Object.freeze({ path: 'style.css', contentTypePattern: /text\/css\b/i }),
  Object.freeze({ path: 'script.js', contentTypePattern: /(?:application|text)\/(?:javascript|ecmascript)\b/i }),
  Object.freeze({ path: 'data-contract.js', contentTypePattern: /(?:application|text)\/(?:javascript|ecmascript)\b/i }),
  Object.freeze({ path: 'data-model.js', contentTypePattern: /(?:application|text)\/(?:javascript|ecmascript)\b/i }),
  Object.freeze({ path: 'vendor/lucide-subset.js', contentTypePattern: /(?:application|text)\/(?:javascript|ecmascript)\b/i })
]);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assetVersionFromHtml(html, assetPath, label) {
  const matches = [...html.matchAll(new RegExp(`${escapeRegExp(assetPath)}\\?v=([a-f0-9]{8})`, 'g'))].map((match) => match[1]);
  if (!matches.length) throw new Error(`${label}: missing cache-busted reference for ${assetPath}`);
  const versions = [...new Set(matches)];
  if (versions.length !== 1) throw new Error(`${label}: inconsistent cache-busting versions for ${assetPath}`);
  return versions[0];
}

function normalizeAssetBytes(value, label) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new Error(`${label}: static asset bytes are invalid`);
}

export function createStaticAssetManifest(indexHtml, assetContents, label = 'static asset manifest') {
  if (typeof indexHtml !== 'string') throw new Error(`${label}: index.html must be text`);
  const assets = {};
  for (const definition of CORE_STATIC_ASSETS) {
    const bytes = normalizeAssetBytes(assetContents?.[definition.path], `${label} ${definition.path}`);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_STATIC_ASSET_RESPONSE_BYTES) {
      throw new Error(`${label}: ${definition.path} has an invalid size`);
    }
    const hash = sha256(bytes);
    const version = assetVersionFromHtml(indexHtml, definition.path, label);
    if (version !== hash.slice(0, 8)) {
      throw new Error(`${label}: ${definition.path} cache-busting version does not match its SHA-256`);
    }
    assets[definition.path] = { bytes, hash, version };
  }
  return { indexHtml, assets };
}

export async function loadStaticAssetManifest(projectDirectory = PROJECT_DIRECTORY, label = 'static asset manifest') {
  const indexHtml = await readFile(path.join(projectDirectory, 'index.html'), 'utf8');
  const assetContents = Object.fromEntries(await Promise.all(CORE_STATIC_ASSETS.map(async ({ path: assetPath }) => [
    assetPath,
    await readFile(path.join(projectDirectory, assetPath))
  ])));
  return createStaticAssetManifest(indexHtml, assetContents, label);
}

async function readTextFromGitRef(ref, relativePath) {
  const object = `${ref}:${PROJECT_REPOSITORY_PATH}/${relativePath}`;
  const { stdout } = await execFileAsync('git', ['show', object], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
    windowsHide: true
  });
  return stdout;
}

export async function loadStaticAssetManifestFromGitRef(ref = 'origin/main', label = 'git static asset manifest') {
  const [indexHtml, ...assetTexts] = await Promise.all([
    readTextFromGitRef(ref, 'index.html'),
    ...CORE_STATIC_ASSETS.map(({ path: assetPath }) => readTextFromGitRef(ref, assetPath))
  ]);
  return createStaticAssetManifest(
    indexHtml,
    Object.fromEntries(CORE_STATIC_ASSETS.map(({ path: assetPath }, index) => [assetPath, assetTexts[index]])),
    label
  );
}

function requestOptions(signal, { cacheBypass = true } = {}) {
  const options = { redirect: 'error', signal };
  if (cacheBypass) {
    options.cache = 'no-store';
    options.headers = { 'cache-control': 'no-cache', pragma: 'no-cache' };
  }
  return options;
}

function verificationUrl(baseUrl, runId, attempt) {
  const url = new URL(baseUrl);
  url.searchParams.set('verify', `${runId}-${attempt}`);
  return url;
}

function assetVerificationUrl(baseUrl, assetPath, version, runId, attempt) {
  const url = new URL(assetPath, baseUrl);
  url.searchParams.set('v', version);
  url.searchParams.set('verify', `${runId}-${attempt}`);
  return url;
}

function canonicalAssetUrl(baseUrl, assetPath, version) {
  const url = new URL(assetPath, baseUrl);
  url.searchParams.set('v', version);
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

async function fetchJsonResource(fetchImpl, url, signal, resource, maxBytes, { cacheBypass = true } = {}) {
  try {
    const response = await fetchImpl(url, requestOptions(signal, { cacheBypass }));
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

async function fetchHtmlResource(fetchImpl, url, signal, { cacheBypass = true } = {}) {
  try {
    const response = await fetchImpl(url, requestOptions(signal, { cacheBypass }));
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

async function fetchStaticAsset(fetchImpl, baseUrl, definition, expected, signal, runId, attempt, { diagnostic = true } = {}) {
  try {
    const url = diagnostic
      ? assetVerificationUrl(baseUrl, definition.path, expected.version, runId, attempt)
      : canonicalAssetUrl(baseUrl, definition.path, expected.version);
    const response = await fetchImpl(
      url,
      requestOptions(signal, { cacheBypass: diagnostic })
    );
    return await readBoundedResponse(response, {
      label: definition.path,
      maxBytes: MAX_STATIC_ASSET_RESPONSE_BYTES,
      contentTypePattern: definition.contentTypePattern
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    error.reason = error.reason?.startsWith('HTTP_')
      ? `asset:${definition.path}:${error.reason}`
      : error.reason ?? `asset-invalid:${definition.path}:${String(error.message).slice(0, 140).replace(/[\r\n]+/g, ' ')}`;
    throw error;
  }
}

async function verifyStaticAssets(manifest, productionHtml, {
  fetchImpl, productionAssetBaseUrl, signal, runId, attempt, diagnostic = true
}) {
  for (const definition of CORE_STATIC_ASSETS) {
    const expected = manifest.assets?.[definition.path];
    if (!expected) {
      const error = new Error(`Missing expected static asset: ${definition.path}`);
      error.reason = `expected-asset-missing:${definition.path}`;
      throw error;
    }
    let productionVersion;
    try {
      productionVersion = assetVersionFromHtml(productionHtml, definition.path, 'production index.html');
    } catch (error) {
      error.reason = `asset-index-invalid:${definition.path}:${String(error.message).slice(0, 120).replace(/[\r\n]+/g, ' ')}`;
      throw error;
    }
    if (productionVersion !== expected.version) {
      const error = new Error(`${definition.path} production version ${productionVersion} != expected ${expected.version}`);
      error.reason = `asset-index-version:${definition.path}`;
      throw error;
    }
    const bytes = await fetchStaticAsset(
      fetchImpl,
      productionAssetBaseUrl,
      definition,
      expected,
      signal,
      runId,
      attempt,
      { diagnostic }
    );
    if (sha256(bytes) !== expected.hash) {
      const error = new Error(`${definition.path} production bytes do not match the committed asset`);
      error.reason = `asset-not-deployed:${definition.path}`;
      throw error;
    }
  }
}

function classifyArtifactValidationError(error) {
  const message = String(error?.message ?? error).slice(0, 160).replace(/[\r\n]+/g, ' ');
  if (/run-log\.json/i.test(message)) return `run-log-invalid:${message}`;
  if (/history|price history/i.test(message)) return `history-invalid:${message}`;
  return `prices-invalid:${message}`;
}

const artifactHashesMatch = (left, right) => JSON_FILES.every(([key]) => left.hashes[key] === right.hashes[key]);
const artifactExactlyMatches = (left, right) => artifactHashesMatch(left, right)
  && publicPayloadFingerprint(left.prices) === publicPayloadFingerprint(right.prices)
  && left.prices.generatedAt === right.prices.generatedAt
  && left.prices.run.finishedAtUtc === right.prices.run.finishedAtUtc;
const safeObservedTimestamp = (value) => (typeof value === 'string' && value.length <= 40 ? value : null);
const resultResources = (staticManifest) => ({
  'prices.json': 'verified',
  'history.json': 'verified',
  'run-log.json': 'verified',
  'index.html': 'verified against prices.json',
  ...(staticManifest
    ? Object.fromEntries(CORE_STATIC_ASSETS.map(({ path: assetPath }) => [assetPath, 'verified byte-for-byte']))
    : {})
});

async function readProductionSnapshot({
  fetchImpl,
  productionPricesUrl,
  productionHistoryUrl,
  productionRunLogUrl,
  productionIndexUrl,
  signal,
  runId,
  attempt,
  diagnostic
}) {
  const resourceUrl = (value) => diagnostic ? verificationUrl(value, runId, attempt) : new URL(value);
  const requestMode = { cacheBypass: diagnostic };
  const [pricesResult, historyResult, runLogResult, productionHtml] = await Promise.all([
    fetchJsonResource(fetchImpl, resourceUrl(productionPricesUrl), signal, 'prices', MAX_PRICES_RESPONSE_BYTES, requestMode),
    fetchJsonResource(fetchImpl, resourceUrl(productionHistoryUrl), signal, 'history', MAX_HISTORY_RESPONSE_BYTES, requestMode),
    fetchJsonResource(fetchImpl, resourceUrl(productionRunLogUrl), signal, 'run-log', MAX_RUN_LOG_RESPONSE_BYTES, requestMode),
    fetchHtmlResource(fetchImpl, resourceUrl(productionIndexUrl), signal, requestMode)
  ]);
  let observed;
  try {
    observed = buildArtifact(
      { prices: pricesResult.value, history: historyResult.value, runLog: runLogResult.value },
      { prices: pricesResult.bytes, history: historyResult.bytes, runLog: runLogResult.bytes },
      diagnostic ? 'production diagnostic artifact' : 'production acceptance artifact'
    );
  } catch (error) {
    error.reason = classifyArtifactValidationError(error);
    throw error;
  }
  try {
    assertStaticPageMatches(productionHtml, observed.prices);
  } catch (error) {
    error.reason = `STATIC_RENDER_MISMATCH:${String(error.message).slice(0, 120).replace(/[\r\n]+/g, ' ')}`;
    throw error;
  }
  return { observed, productionHtml };
}

async function verifyCanonicalAcceptance(targetArtifact, targetStaticAssets, {
  fetchImpl,
  productionPricesUrl,
  productionHistoryUrl,
  productionRunLogUrl,
  productionIndexUrl,
  productionAssetBaseUrl,
  signal,
  runId,
  attempt
}) {
  let snapshot;
  try {
    snapshot = await readProductionSnapshot({
      fetchImpl,
      productionPricesUrl,
      productionHistoryUrl,
      productionRunLogUrl,
      productionIndexUrl,
      signal,
      runId,
      attempt,
      diagnostic: false
    });
  } catch (error) {
    error.reason = `canonical:${error.reason ?? (error?.name === 'AbortError' ? 'request-timeout' : String(error?.message ?? error).slice(0, 140).replace(/[\r\n]+/g, ' '))}`;
    throw error;
  }
  const { observed, productionHtml } = snapshot;
  if (!artifactExactlyMatches(observed, targetArtifact)) {
    const error = new Error('Canonical production URLs do not match the proven deployment target');
    error.reason = 'canonical-artifact-not-deployed';
    throw error;
  }
  if (targetStaticAssets) {
    try {
      await verifyStaticAssets(targetStaticAssets, productionHtml, {
        fetchImpl,
        productionAssetBaseUrl,
        signal,
        runId,
        attempt,
        diagnostic: false
      });
    } catch (error) {
      error.reason = `canonical:${error.reason ?? String(error?.message ?? error).slice(0, 140).replace(/[\r\n]+/g, ' ')}`;
      throw error;
    }
  }
  return { observed, productionHtml };
}

export async function verifyProductionDeployment(expectedArtifact, {
  productionPricesUrl = PRODUCTION_PRICES_URL,
  productionHistoryUrl = PRODUCTION_HISTORY_URL,
  productionRunLogUrl = PRODUCTION_RUN_LOG_URL,
  productionIndexUrl = PRODUCTION_INDEX_URL,
  productionAssetBaseUrl = PRODUCTION_ASSET_BASE_URL,
  expectedStaticAssets = null,
  runId = 'local', maxWaitMs = DEFAULT_MAX_WAIT_MS, intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = () => Date.now(),
  getCurrentMainArtifact = async () => null,
  getCurrentMainStaticAssets = async () => null,
  log = console.log
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
      const { observed } = await readProductionSnapshot({
        fetchImpl,
        productionPricesUrl,
        productionHistoryUrl,
        productionRunLogUrl,
        productionIndexUrl,
        signal: controller.signal,
        runId,
        attempt: attempts,
        diagnostic: true
      });
      lastObservedGeneratedAt = safeObservedTimestamp(observed.prices.generatedAt);

      const pricesMatch = observed.hashes.prices === expected.hashes.prices
        && publicPayloadFingerprint(observed.prices) === expectedFingerprint
        && observed.prices.generatedAt === expected.prices.generatedAt
        && observed.prices.run.finishedAtUtc === expected.prices.run.finishedAtUtc;
      if (pricesMatch && observed.hashes.history === expected.hashes.history && observed.hashes.runLog === expected.hashes.runLog) {
        const acceptance = await verifyCanonicalAcceptance(expected, expectedStaticAssets, {
          fetchImpl,
          productionPricesUrl,
          productionHistoryUrl,
          productionRunLogUrl,
          productionIndexUrl,
          productionAssetBaseUrl,
          signal: controller.signal,
          runId,
          attempt: attempts
        });
        const result = { status: 'deployed', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.prices.generatedAt, observedGeneratedAt: acceptance.observed.prices.generatedAt, resources: resultResources(expectedStaticAssets) };
        log(`真实生产部署验证通过：canonical URL，第 ${attempts} 次检查；generatedAt=${acceptance.observed.prices.generatedAt}`);
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
          if (artifactExactlyMatches(observed, currentMain)) {
            let currentMainStaticAssets = null;
            if (expectedStaticAssets) {
              currentMainStaticAssets = await getCurrentMainStaticAssets();
              if (!currentMainStaticAssets) {
                const error = new Error('Current main static assets are required to prove a superseding deployment');
                error.reason = 'current-main-assets-unavailable';
                throw error;
              }
            }
            const acceptance = await verifyCanonicalAcceptance(currentMain, currentMainStaticAssets, {
              fetchImpl,
              productionPricesUrl,
              productionHistoryUrl,
              productionRunLogUrl,
              productionIndexUrl,
              productionAssetBaseUrl,
              signal: controller.signal,
              runId,
              attempt: attempts
            });
            const result = { status: 'superseded', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.prices.generatedAt, observedGeneratedAt: acceptance.observed.prices.generatedAt, resources: resultResources(currentMainStaticAssets ?? expectedStaticAssets) };
            log(`真实生产部署验证通过：canonical URL 已是更新提交版本，第 ${attempts} 次检查；generatedAt=${acceptance.observed.prices.generatedAt}`);
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
      lastReason = error.reason ?? (error?.name === 'AbortError'
        ? 'request-timeout'
        : `retryable-response:${String(error?.message ?? error).slice(0, 160).replace(/[\r\n]+/g, ' ')}`);
    } finally {
      controller.abort();
      clearTimeout(timeout);
    }
    log(`真实生产部署验证第 ${attempts} 次：observed=${lastObservedGeneratedAt ?? 'unavailable'}；结果=${lastReason}`);
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

function resourceStatusLabel(status) {
  if (status === 'verified') return '已验证';
  if (status === 'verified against prices.json') return '已与 prices.json 一致验证';
  if (status === 'verified byte-for-byte') return '已逐字节验证';
  return status;
}

function deploymentStatusLabel(status) {
  if (status === 'deployed') return '已部署并验证';
  if (status === 'superseded') return '已由更新版本覆盖并验证';
  return status;
}

function summaryLines(result) {
  return [
    '## 真实生产部署验证',
    '',
    ...Object.entries(result.resources).map(([resource, status]) => `- ${resource}：${resourceStatusLabel(status)}`),
    `- 状态：${deploymentStatusLabel(result.status)}`,
    `- 预期 generatedAt：${result.expectedGeneratedAt}`,
    `- 实际 generatedAt：${result.observedGeneratedAt}`,
    `- 验证尝试次数：${result.attempts}`,
    `- 耗时：${(result.elapsedMs / 1_000).toFixed(1)} 秒`,
    ''
  ];
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const expected = await loadVerificationArtifact(options.expectedDataDir, 'expected artifact');
  const expectedStaticAssets = await loadStaticAssetManifest(PROJECT_DIRECTORY, 'expected static assets');
  const getCurrentMainArtifact = options.currentMainDataDir
    ? async () => loadVerificationArtifact(options.currentMainDataDir, 'current main artifact')
    : async () => null;
  const getCurrentMainStaticAssets = options.currentMainDataDir
    ? async () => loadStaticAssetManifestFromGitRef('origin/main', 'current main static assets')
    : async () => null;
  try {
    const result = await verifyProductionDeployment(expected, {
      ...options,
      expectedStaticAssets,
      getCurrentMainArtifact,
      getCurrentMainStaticAssets
    });
    if (options.summaryFile) await appendFile(options.summaryFile, summaryLines(result).join('\n'), 'utf8');
  } catch (error) {
    if (options.summaryFile) {
      const details = error.details ?? {};
      await appendFile(options.summaryFile, [
        '## 真实生产部署验证',
        '',
        `- 状态：失败（${error.code ?? 'failed'}）`,
        `- 预期 generatedAt：${details.expectedGeneratedAt ?? expected.prices.generatedAt}`,
        `- 最后观测 generatedAt：${details.lastObservedGeneratedAt ?? 'unavailable'}`,
        `- 最后原因：${details.lastReason ?? 'unavailable'}`,
        `- 尝试次数：${details.attempts ?? 0}`,
        `- 耗时：${((details.elapsedMs ?? 0) / 1_000).toFixed(1)} 秒`,
        ''
      ].join('\n'), 'utf8');
    }
    console.error(`真实生产部署验证失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await runCli();
