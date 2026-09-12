import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CORE_STATIC_ASSETS,
  PRODUCTION_ASSET_BASE_URL,
  createStaticAssetManifest,
  loadStaticAssetManifest,
  loadStaticAssetManifestFromGitRef,
  loadVerificationArtifact,
  verifyProductionDeployment
} from '../scripts/verify-production-deployment.mjs';

const projectDirectory = fileURLToPath(new URL('../', import.meta.url));
const dataDirectory = new URL('../data/', import.meta.url);
const expectedData = await loadVerificationArtifact(dataDirectory, 'committed fixture');
const expectedStatic = await loadStaticAssetManifest(projectDirectory, 'committed static fixture');
const contentTypes = new Map([
  ['style.css', 'text/css; charset=utf-8'],
  ['script.js', 'application/javascript; charset=utf-8'],
  ['data-contract.js', 'application/javascript; charset=utf-8'],
  ['data-model.js', 'application/javascript; charset=utf-8'],
  ['vendor/lucide-subset.js', 'application/javascript; charset=utf-8']
]);

function attemptFromUrl(requestUrl) {
  const token = new URL(requestUrl, 'http://localhost').searchParams.get('verify') ?? '';
  const match = token.match(/-(\d+)$/);
  return Math.max(0, Number(match?.[1] ?? 1) - 1);
}

async function startServer(sequence = [{}]) {
  const observedRequests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const attempt = attemptFromUrl(request.url);
    const item = sequence[Math.min(attempt, sequence.length - 1)];
    const pathName = url.pathname;
    observedRequests.push({
      pathName,
      attempt: attempt + 1,
      url: request.url,
      cacheControl: request.headers['cache-control'],
      pragma: request.headers.pragma
    });

    if (pathName === '/prices.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(expectedData.raw.prices);
      return;
    }
    if (pathName === '/history.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(expectedData.raw.history);
      return;
    }
    if (pathName === '/run-log.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(expectedData.raw.runLog);
      return;
    }
    if (pathName === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(item.indexHtml ?? expectedStatic.indexHtml);
      return;
    }

    const assetPath = pathName.replace(/^\//, '');
    const asset = expectedStatic.assets[assetPath];
    if (asset) {
      const override = item.assets?.[assetPath] ?? {};
      if (override.redirect) {
        response.writeHead(302, { location: override.redirect });
        response.end();
        return;
      }
      if (override.declaredLength) response.setHeader('content-length', override.declaredLength);
      response.writeHead(override.status ?? 200, {
        'content-type': override.contentType ?? contentTypes.get(assetPath)
      });
      response.end(override.body ?? asset.bytes);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    urls: {
      productionPricesUrl: `${base}/prices.json`,
      productionHistoryUrl: `${base}/history.json`,
      productionRunLogUrl: `${base}/run-log.json`,
      productionIndexUrl: `${base}/index.html`,
      productionAssetBaseUrl: `${base}/`
    },
    observedRequests,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

function fastOptions(server, overrides = {}) {
  let nowMs = 0;
  return {
    ...server.urls,
    expectedStaticAssets: expectedStatic,
    runId: 'asset-test',
    maxWaitMs: 4,
    intervalMs: 1,
    requestTimeoutMs: 1_000,
    now: () => nowMs,
    sleep: async (milliseconds) => { nowMs += milliseconds; },
    log: () => {},
    ...overrides
  };
}

async function rejectsWithReason(sequence, reason) {
  const server = await startServer(sequence);
  try {
    await assert.rejects(
      () => verifyProductionDeployment(expectedData, fastOptions(server, { maxWaitMs: 1 })),
      (error) => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
        && new RegExp(reason).test(error.details.lastReason)
    );
  } finally {
    await server.close();
  }
}

test('uses a fixed production base for the five execution-critical static assets', () => {
  assert.equal(PRODUCTION_ASSET_BASE_URL, 'https://www.linchun.com.cn/tools/icloud_price_comparison/');
  assert.deepEqual(
    CORE_STATIC_ASSETS.map(({ path }) => path),
    ['style.css', 'script.js', 'data-contract.js', 'data-model.js', 'vendor/lucide-subset.js']
  );
});

test('committed asset cache-busting versions are the SHA-256 prefixes of their exact bytes', () => {
  for (const { path } of CORE_STATIC_ASSETS) {
    const asset = expectedStatic.assets[path];
    assert.match(asset.hash, /^[a-f0-9]{64}$/);
    assert.equal(asset.version, asset.hash.slice(0, 8));
    assert.ok(asset.bytes.byteLength > 0);
  }
});

test('git-ref asset loading reproduces the committed manifest exactly', async () => {
  const fromGit = await loadStaticAssetManifestFromGitRef('HEAD', 'HEAD static fixture');
  for (const { path } of CORE_STATIC_ASSETS) {
    assert.equal(fromGit.assets[path].hash, expectedStatic.assets[path].hash);
    assert.equal(fromGit.assets[path].version, expectedStatic.assets[path].version);
  }
});

test('rejects a manifest when index.html points at bytes with a different version', () => {
  const changed = expectedStatic.indexHtml.replace(
    /script\.js\?v=[a-f0-9]{8}/g,
    'script.js?v=00000000'
  );
  assert.throws(
    () => createStaticAssetManifest(
      changed,
      Object.fromEntries(Object.entries(expectedStatic.assets).map(([name, value]) => [name, value.bytes])),
      'tampered fixture'
    ),
    /script\.js cache-busting version does not match its SHA-256/
  );
});

test('production acceptance verifies all five static assets byte-for-byte', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const result = await verifyProductionDeployment(expectedData, fastOptions(server));
  assert.equal(result.status, 'deployed');
  for (const { path } of CORE_STATIC_ASSETS) {
    assert.equal(result.resources[path], 'verified byte-for-byte');
  }
  assert.equal(server.observedRequests.length, 9);
  for (const request of server.observedRequests) {
    assert.equal(request.cacheControl, 'no-cache');
    assert.equal(request.pragma, 'no-cache');
    assert.match(request.url, /[?&]verify=asset-test-1(?:&|$)/);
  }
  for (const { path } of CORE_STATIC_ASSETS) {
    const request = server.observedRequests.find(({ pathName }) => pathName === `/${path}`);
    assert.ok(request, `missing production readback for ${path}`);
    assert.match(request.url, new RegExp(`[?&]v=${expectedStatic.assets[path].version}(?:&|$)`));
  }
});

test('retries and fails closed when a core script has stale bytes', () => rejectsWithReason([
  { assets: { 'script.js': { body: Buffer.from('stale script bytes') } } }
], 'asset-not-deployed:script\\.js'));

test('retries and fails closed when production index points at the wrong asset version', () => rejectsWithReason([
  { indexHtml: expectedStatic.indexHtml.replace(/script\.js\?v=[a-f0-9]{8}/g, 'script.js?v=00000000') }
], 'asset-index-version:script\\.js'));

test('rejects wrong MIME and HTTP failures for execution-critical assets', async () => {
  await rejectsWithReason([
    { assets: { 'style.css': { contentType: 'text/html' } } }
  ], 'asset-invalid:style\\.css');
  await rejectsWithReason([
    { assets: { 'data-model.js': { status: 503, body: Buffer.from('unavailable') } } }
  ], 'asset:data-model\\.js:HTTP_503');
});
