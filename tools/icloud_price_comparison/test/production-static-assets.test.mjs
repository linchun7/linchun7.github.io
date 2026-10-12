import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
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
    const artifact = item.artifact ?? expectedData;
    const staticAssets = item.staticAssets ?? expectedStatic;
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
      response.end(artifact.raw.prices);
      return;
    }
    if (pathName === '/history.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(artifact.raw.history);
      return;
    }
    if (pathName === '/run-log.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(artifact.raw.runLog);
      return;
    }
    if (pathName === '/minimum-history.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(artifact.raw.minimumHistory);
      return;
    }
    if (pathName === '/index.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(item.indexHtml ?? staticAssets.indexHtml);
      return;
    }

    const assetPath = pathName.replace(/^\//, '');
    const asset = staticAssets.assets[assetPath];
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
      productionMinimumHistoryUrl: `${base}/minimum-history.json`,
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

async function rejectsWithReason(sequence, reason, options = {}) {
  const server = await startServer(sequence);
  try {
    await assert.rejects(
      () => verifyProductionDeployment(expectedData, fastOptions(server, { maxWaitMs: 1, ...options })),
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
  assert.equal(server.observedRequests.length, 15);
  const diagnosticRequests = server.observedRequests.filter(({ url }) => /[?&]verify=/.test(url));
  const acceptanceRequests = server.observedRequests.filter(({ url }) => !/[?&]verify=/.test(url));
  assert.equal(diagnosticRequests.length, 5);
  assert.equal(acceptanceRequests.length, 10);
  for (const request of diagnosticRequests) {
    assert.equal(request.cacheControl, 'no-cache');
    assert.equal(request.pragma, 'no-cache');
    assert.match(request.url, /[?&]verify=asset-test-1(?:&|$)/);
  }
  for (const request of acceptanceRequests) {
    assert.equal(request.cacheControl, undefined);
    assert.equal(request.pragma, undefined);
    assert.doesNotMatch(request.url, /[?&]verify=/);
  }
  for (const { path } of CORE_STATIC_ASSETS) {
    const request = server.observedRequests.find(({ pathName }) => pathName === `/${path}`);
    assert.ok(request, `missing production readback for ${path}`);
    assert.match(request.url, new RegExp(`[?&]v=${expectedStatic.assets[path].version}(?:&|$)`));
    assert.doesNotMatch(request.url, /[?&]verify=/);
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

function sameDataSuccessorManifest(changedAssets = ['style.css']) {
  const contents = Object.fromEntries(
    CORE_STATIC_ASSETS.map(({ path }) => [path, expectedStatic.assets[path].bytes])
  );
  let indexHtml = expectedStatic.indexHtml;
  for (const assetPath of changedAssets) {
    contents[assetPath] = Buffer.concat([
      contents[assetPath], Buffer.from('\n/* same-data current-main successor fixture */\n')
    ]);
    const version = createHash('sha256').update(contents[assetPath]).digest('hex').slice(0, 8);
    indexHtml = indexHtml.replaceAll(
      `${assetPath}?v=${expectedStatic.assets[assetPath].version}`,
      `${assetPath}?v=${version}`
    );
  }
  return createStaticAssetManifest(indexHtml, contents, 'same-data successor fixture');
}

test('accepts a same-data successor only after current main proves every canonical asset', async (t) => {
  const currentStatic = sameDataSuccessorManifest(['style.css', 'script.js']);
  const server = await startServer([{ staticAssets: currentStatic }]);
  t.after(() => server.close());
  let mainDataReads = 0;
  let mainAssetReads = 0;
  const result = await verifyProductionDeployment(expectedData, fastOptions(server, {
    getCurrentMainArtifact: async () => { mainDataReads += 1; return expectedData; },
    getCurrentMainStaticAssets: async () => { mainAssetReads += 1; return currentStatic; }
  }));
  assert.equal(result.status, 'superseded');
  assert.equal(result.observedGeneratedAt, result.expectedGeneratedAt, 'code-only deployments retain generatedAt');
  assert.equal(mainDataReads, 1, 'an exact data match must still reach the trusted-main proof after old assets fail');
  assert.equal(mainAssetReads, 1);
  for (const { path } of CORE_STATIC_ASSETS) {
    assert.equal(result.resources[path], 'verified byte-for-byte');
    const reads = server.observedRequests.filter(({ pathName }) => pathName === `/${path}`);
    assert.ok(reads.some(({ url }) => new URL(url, 'http://localhost').searchParams.get('v') === currentStatic.assets[path].version));
    for (const { url, cacheControl, pragma } of reads) {
      assert.doesNotMatch(url, /[?&]verify=/, 'all acceptance assets use ordinary user URLs');
      assert.equal(cacheControl, undefined);
      assert.equal(pragma, undefined);
    }
  }
});

test('same-data changed assets are rejected without trusted current-main data', () => rejectsWithReason(
  [{ staticAssets: sameDataSuccessorManifest() }],
  'canonical:asset-index-version:style\\.css'
));

test('same-data current-main proof fails closed when its asset manifest is unavailable', () => rejectsWithReason(
  [{ staticAssets: sameDataSuccessorManifest() }],
  'current-main-assets-unavailable',
  { getCurrentMainArtifact: async () => expectedData }
));

test('same-data current-main proof validates the bytes behind manifest hashes', async () => {
  const currentStatic = sameDataSuccessorManifest();
  const invalidManifest = {
    ...currentStatic,
    assets: {
      ...currentStatic.assets,
      'style.css': { ...currentStatic.assets['style.css'], bytes: expectedStatic.assets['style.css'].bytes }
    }
  };
  await rejectsWithReason(
    [{ staticAssets: currentStatic }],
    'current-main-assets-invalid',
    { getCurrentMainArtifact: async () => expectedData, getCurrentMainStaticAssets: async () => invalidManifest }
  );
});

for (const key of ['history', 'runLog', 'minimumHistory']) {
  test(`same-data successor cannot be proven with mismatched ${key} bytes from current main`, async () => {
    const currentStatic = sameDataSuccessorManifest();
    const differentMain = {
      ...expectedData,
      raw: { ...expectedData.raw, [key]: Buffer.concat([expectedData.raw[key], Buffer.from('\n')]) }
    };
    let mainReads = 0;
    await rejectsWithReason(
      [{ staticAssets: currentStatic }],
      'canonical:asset-index-version:style\\.css',
      {
        getCurrentMainArtifact: async () => { mainReads += 1; return differentMain; },
        getCurrentMainStaticAssets: async () => currentStatic
      }
    );
    assert.ok(mainReads > 0, 'the exact data path must try, but cannot trust, different main bytes');
  });
}

for (const assetPath of ['style.css', 'script.js']) {
  test(`same-data successor rejects stale ${assetPath} despite current-main HTML versions`, () => {
    const currentStatic = sameDataSuccessorManifest(['style.css', 'script.js']);
    return rejectsWithReason(
      [{
        staticAssets: currentStatic,
        assets: { [assetPath]: { body: expectedStatic.assets[assetPath].bytes } }
      }],
      `canonical:asset-not-deployed:${assetPath.replaceAll('.', '\\.')}`,
      { getCurrentMainArtifact: async () => expectedData, getCurrentMainStaticAssets: async () => currentStatic }
    );
  });
}

test('same-data successor rejects canonical HTML that still names older asset versions', async (t) => {
  const currentStatic = sameDataSuccessorManifest();
  const server = await startServer([{ staticAssets: currentStatic }]);
  t.after(() => server.close());
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/index.html' && !parsed.searchParams.has('verify')) {
      return new Response(expectedStatic.indexHtml, { headers: { 'content-type': 'text/html' } });
    }
    return globalThis.fetch(url, options);
  };
  await assert.rejects(
    () => verifyProductionDeployment(expectedData, fastOptions(server, {
      maxWaitMs: 1, fetchImpl,
      getCurrentMainArtifact: async () => expectedData,
      getCurrentMainStaticAssets: async () => currentStatic
    })),
    error => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
      && /canonical:asset-index-version:style\.css/.test(error.details.lastReason)
  );
});

test('same-generatedAt data changes cannot be accepted as a code-only successor', async () => {
  const currentStatic = sameDataSuccessorManifest();
  const changedData = {
    ...expectedData,
    raw: { ...expectedData.raw, history: Buffer.concat([expectedData.raw.history, Buffer.from('\n')]) }
  };
  let mainReads = 0;
  await rejectsWithReason(
    [{ artifact: changedData, staticAssets: currentStatic }],
    'history-not-deployed',
    {
      getCurrentMainArtifact: async () => { mainReads += 1; return changedData; },
      getCurrentMainStaticAssets: async () => currentStatic
    }
  );
  assert.equal(mainReads, 0, 'equal generatedAt cannot substitute different data, even if current main offers it');
});

test('same-data successor rejects invalid current-main artifacts before static acceptance', () => {
  const invalidMain = { ...expectedData, runLog: { ...expectedData.runLog, untrusted: true } };
  return rejectsWithReason(
    [{ staticAssets: sameDataSuccessorManifest() }],
    'current-main-invalid',
    { getCurrentMainArtifact: async () => invalidMain, getCurrentMainStaticAssets: async () => sameDataSuccessorManifest() }
  );
});

test('same-data successor rejects a current-main index inconsistent with its data artifact', () => {
  const currentStatic = sameDataSuccessorManifest();
  const inconsistentStatic = {
    ...currentStatic,
    indexHtml: currentStatic.indexHtml.replace(/<!-- ICLOUD_STATIC_TABLE_BODY:START -->[\s\S]*?<!-- ICLOUD_STATIC_TABLE_BODY:END -->/, '<!-- ICLOUD_STATIC_TABLE_BODY:START --><tr><td>unproven</td></tr><!-- ICLOUD_STATIC_TABLE_BODY:END -->')
  };
  assert.notEqual(inconsistentStatic.indexHtml, currentStatic.indexHtml, 'fixture must replace the generated table fragment');
  return rejectsWithReason(
    [{ staticAssets: currentStatic }],
    'current-main-assets-invalid',
    { getCurrentMainArtifact: async () => expectedData, getCurrentMainStaticAssets: async () => inconsistentStatic }
  );
});

for (const [key, pathName] of [['prices', '/prices.json'], ['history', '/history.json']]) {
  test(`same-data fallback rejects canonical ${key} bytes that drift after diagnostic proof`, async (t) => {
    const currentStatic = sameDataSuccessorManifest();
    const server = await startServer([{ staticAssets: currentStatic }]);
    t.after(() => server.close());
    let mainReads = 0;
    const fetchImpl = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === pathName && !parsed.searchParams.has('verify')) {
        return new Response(Buffer.concat([expectedData.raw[key], Buffer.from('\n')]), {
          headers: { 'content-type': 'application/json' }
        });
      }
      return globalThis.fetch(url, options);
    };
    await assert.rejects(
      () => verifyProductionDeployment(expectedData, fastOptions(server, {
        maxWaitMs: 1, fetchImpl,
        getCurrentMainArtifact: async () => { mainReads += 1; return expectedData; },
        getCurrentMainStaticAssets: async () => currentStatic
      })),
      error => error.code === 'PUBLISH_PRODUCTION_NOT_UPDATED'
        && error.details.lastReason === 'canonical-artifact-not-deployed'
    );
    assert.ok(mainReads > 0, 'fallback must re-read canonical JSON after entering the trusted-main proof');
  });
}
