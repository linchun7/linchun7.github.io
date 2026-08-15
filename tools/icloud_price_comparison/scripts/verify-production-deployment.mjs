import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePricePayload } from '../data-contract.js';
import { assertStaticPageMatches, publicPayloadFingerprint } from './static-page.mjs';

export const PRODUCTION_PRICES_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json';
export const PRODUCTION_INDEX_URL = 'https://www.linchun.com.cn/tools/icloud_price_comparison/';
export const DEFAULT_MAX_WAIT_MS = 5 * 60 * 1_000;
export const DEFAULT_INTERVAL_MS = 15 * 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 1_000;
const MAX_JSON_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTML_RESPONSE_BYTES = 512 * 1024;
export { publicPayloadFingerprint };

function validateDeployablePayload(payload, label) {
  validatePricePayload(payload);
  if (payload.schemaVersion !== 4) throw new Error(`${label} schemaVersion is not 4`);
  if (payload.source?.parser !== 'cross-checked') throw new Error(`${label} parser is not cross-checked`);
  if (typeof payload.run?.finishedAtUtc !== 'string') throw new Error(`${label} run.finishedAtUtc is missing`);
  return payload;
}

async function readBoundedJson(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/(?:application|text)\/(?:[a-z0-9.+-]*\+)?json\b/i.test(contentType)) {
    throw new Error(`unexpected content type: ${contentType || 'missing'}`);
  }
  const declaredLength = response.headers.get('content-length');
  if (/^\d+$/.test(declaredLength ?? '') && Number(declaredLength) > MAX_JSON_RESPONSE_BYTES) {
    throw new Error('production response exceeds the size limit');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_JSON_RESPONSE_BYTES) throw new Error('production response exceeds the size limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

async function readBoundedHtml(response) {
  const contentType = response.headers.get('content-type') ?? '';
  if (!/text\/html\b/i.test(contentType)) throw new Error(`unexpected HTML content type: ${contentType || 'missing'}`);
  const declaredLength = response.headers.get('content-length');
  if (/^\d+$/.test(declaredLength ?? '') && Number(declaredLength) > MAX_HTML_RESPONSE_BYTES) throw new Error('production HTML exceeds the size limit');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_HTML_RESPONSE_BYTES) throw new Error('production HTML exceeds the size limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function safeObservedTimestamp(value) {
  return typeof value === 'string' && value.length <= 40 ? value : null;
}

export async function verifyProductionDeployment(expectedPayload, {
  productionUrl = PRODUCTION_PRICES_URL,
  productionIndexUrl = PRODUCTION_INDEX_URL,
  runId = 'local',
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = () => Date.now(),
  getCurrentMainPayload = async () => null,
  log = console.log
} = {}) {
  const expected = validateDeployablePayload(expectedPayload, 'expected artifact');
  const expectedFingerprint = publicPayloadFingerprint(expected);
  const startedAt = now();
  let attempts = 0;
  let lastObservedGeneratedAt = null;
  let lastHttpStatus = null;
  let lastReason = 'not-requested';

  do {
    attempts += 1;
    lastHttpStatus = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const requestUrl = new URL(productionUrl);
      requestUrl.searchParams.set('verify', `${runId}-${attempts}`);
      const response = await fetchImpl(requestUrl, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        redirect: 'error',
        signal: controller.signal
      });
      lastHttpStatus = response.status;
      if (!response.ok) {
        lastReason = `HTTP_${response.status}`;
      } else {
        const observed = validateDeployablePayload(await readBoundedJson(response), 'production payload');
        lastObservedGeneratedAt = safeObservedTimestamp(observed.generatedAt);
      const observedFingerprint = publicPayloadFingerprint(observed);
        const indexUrl = new URL(productionIndexUrl);
        indexUrl.searchParams.set('verify', `${runId}-${attempts}`);
        const htmlResponse = await fetchImpl(indexUrl, {
          cache: 'no-store',
          headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
          redirect: 'error',
          signal: controller.signal
        });
        if (!htmlResponse.ok) throw new Error(`production HTML HTTP_${htmlResponse.status}`);
        const productionHtml = await readBoundedHtml(htmlResponse);
        assertStaticPageMatches(productionHtml, observed);
        if (observedFingerprint === expectedFingerprint
          && observed.generatedAt === expected.generatedAt
          && observed.run.finishedAtUtc === expected.run.finishedAtUtc) {
          const result = { status: 'deployed', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.generatedAt, observedGeneratedAt: observed.generatedAt };
          log(`Production verification passed on attempt ${attempts}: ${observed.generatedAt}`);
          return result;
        }
        if (Date.parse(observed.generatedAt) > Date.parse(expected.generatedAt)) {
          const currentMain = await getCurrentMainPayload();
          if (currentMain) {
            validateDeployablePayload(currentMain, 'current main payload');
            if (publicPayloadFingerprint(currentMain) === observedFingerprint) {
              const result = { status: 'superseded', attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.generatedAt, observedGeneratedAt: observed.generatedAt };
              log(`Production verification passed with a newer committed deployment on attempt ${attempts}: ${observed.generatedAt}`);
              return result;
            }
          }
          lastReason = 'newer-version-unproven';
        } else {
          lastReason = 'not-deployed-yet';
        }
      }
    } catch (error) {
      lastReason = error?.name === 'AbortError' ? 'request-timeout' : `retryable-response:${String(error?.message ?? error).slice(0, 160).replace(/[\r\n]+/g, ' ')}`;
    } finally {
      clearTimeout(timeout);
    }
    log(`Production verification attempt ${attempts}: status=${lastHttpStatus ?? 'network-error'} observed=${lastObservedGeneratedAt ?? 'unavailable'} result=${lastReason}`);
    const remainingMs = maxWaitMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleep(Math.min(intervalMs, remainingMs));
  } while (now() - startedAt <= maxWaitMs);

  const error = new Error(`PUBLISH_PRODUCTION_NOT_UPDATED: expected=${expected.generatedAt} observed=${lastObservedGeneratedAt ?? 'unavailable'} http=${lastHttpStatus ?? 'network-error'} attempts=${attempts} elapsedMs=${now() - startedAt}`);
  error.code = 'PUBLISH_PRODUCTION_NOT_UPDATED';
  error.details = { attempts, elapsedMs: now() - startedAt, expectedGeneratedAt: expected.generatedAt, lastObservedGeneratedAt, lastHttpStatus, lastReason };
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
  if (!values.get('--expected-file')) throw new Error('--expected-file is required');
  const options = {
    expectedFile: values.get('--expected-file'),
    currentMainFile: values.get('--current-main-file') ?? null,
    runId: values.get('--run-id') ?? 'local',
    summaryFile: values.get('--summary-file') ?? null,
    maxWaitMs: values.has('--max-wait-ms') ? Number(values.get('--max-wait-ms')) : DEFAULT_MAX_WAIT_MS,
    intervalMs: values.has('--interval-ms') ? Number(values.get('--interval-ms')) : DEFAULT_INTERVAL_MS
  };
  if (!Number.isFinite(options.maxWaitMs) || options.maxWaitMs <= 0 || options.maxWaitMs > 10 * 60 * 1_000) {
    throw new Error('--max-wait-ms must be between 1 and 600000');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0 || options.intervalMs > options.maxWaitMs) {
    throw new Error('--interval-ms must be positive and no greater than --max-wait-ms');
  }
  return options;
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const expected = JSON.parse(await readFile(options.expectedFile, 'utf8'));
  const getCurrentMainPayload = options.currentMainFile
    ? async () => JSON.parse(await readFile(options.currentMainFile, 'utf8'))
    : async () => null;
  try {
    const result = await verifyProductionDeployment(expected, { ...options, getCurrentMainPayload });
    if (options.summaryFile) {
      await appendFile(options.summaryFile, [
        '## Production verification', '',
        `- Status: ${result.status === 'superseded' ? 'passed (superseded by newer deployment)' : 'passed'}`,
        `- Expected generatedAt: ${result.expectedGeneratedAt}`,
        `- Observed generatedAt: ${result.observedGeneratedAt}`,
        `- Attempts: ${result.attempts}`,
        `- Elapsed: ${(result.elapsedMs / 1_000).toFixed(1)}s`, ''
      ].join('\n'), 'utf8');
    }
  } catch (error) {
    if (options.summaryFile) {
      const details = error.details ?? {};
      await appendFile(options.summaryFile, [
        '## Production verification', '',
        `- Status: ${error.code ?? 'failed'}`,
        `- Expected generatedAt: ${details.expectedGeneratedAt ?? expected.generatedAt}`,
        `- Last observed generatedAt: ${details.lastObservedGeneratedAt ?? 'unavailable'}`,
        `- Last HTTP status: ${details.lastHttpStatus ?? 'network-error'}`,
        `- Attempts: ${details.attempts ?? 0}`,
        `- Elapsed: ${((details.elapsedMs ?? 0) / 1_000).toFixed(1)}s`, ''
      ].join('\n'), 'utf8');
    }
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await runCli();
