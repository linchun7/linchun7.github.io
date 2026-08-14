import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  latestAllowedSnapshotDate,
  logInline as artifactLogInline,
  validateExtractedDataArtifact,
  validateTarArchive
} from '../scripts/validate-data-artifact.mjs';

const DATA_DIRECTORY = fileURLToPath(new URL('../data', import.meta.url));
const ARCHIVE_ROOT = 'tools/icloud_price_comparison/data';
const BLOCK_SIZE = 512;

test('uses the Beijing calendar date for snapshot confirmation bounds', () => {
  const earlyBeijingMorning = Date.parse('2026-08-08T16:30:00.000Z');
  assert.equal(latestAllowedSnapshotDate(earlyBeijingMorning), '2026-08-09');
});

test('bounds and flattens untrusted artifact-validator log text', () => {
  assert.equal(
    artifactLogInline('bad archive\n::warning title=injected::payload\u202e'),
    'bad archive : :warning title=injected: :payload '
  );
  const bounded = artifactLogInline('x'.repeat(2_500));
  assert.equal([...bounded].length, 2_001);
  assert.match(bounded, /…$/);
});

async function copiedData(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'icloud-data-artifact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDirectory = path.join(root, 'data');
  await cp(DATA_DIRECTORY, dataDirectory, { recursive: true });
  return { root, dataDirectory };
}

function serializedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJson(filePath, value) {
  const text = serializedJson(value);
  await writeFile(filePath, text);
  return { text, sha256: sha256(text) };
}

function tarString(header, value, offset, length) {
  const encoded = Buffer.from(value);
  assert.ok(encoded.length <= length, `${value} does not fit in a ustar field`);
  encoded.copy(header, offset);
}

function tarOctal(header, value, offset, length) {
  const encoded = `${value.toString(8).padStart(length - 1, '0')}\0`;
  tarString(header, encoded, offset, length);
}

function tarEntry({
  name,
  type = '0',
  content = Buffer.alloc(0),
  linkName = '',
  mode = type === '5' ? 0o755 : 0o644,
  magic = 'ustar\0',
  version = '00',
  prefix = ''
}) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(BLOCK_SIZE);
  tarString(header, name, 0, 100);
  tarOctal(header, mode, 100, 8);
  tarOctal(header, 0, 108, 8);
  tarOctal(header, 0, 116, 8);
  tarOctal(header, type === '5' ? 0 : body.length, 124, 12);
  tarOctal(header, 0, 136, 12);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  tarString(header, linkName, 157, 100);
  tarString(header, magic, 257, 6);
  tarString(header, version, 263, 2);
  tarString(header, prefix, 345, 155);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  tarString(header, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padding = Buffer.alloc(Math.ceil(body.length / BLOCK_SIZE) * BLOCK_SIZE - body.length);
  return Buffer.concat([header, body, padding]);
}

async function archiveEntries(dataDirectory) {
  const entries = [{ name: `${ARCHIVE_ROOT}/`, type: '5' }];
  async function visit(directory, relative = '') {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((first, second) => first.name.localeCompare(second.name));
    for (const child of children) {
      const relativePath = relative ? `${relative}/${child.name}` : child.name;
      const fullPath = path.join(directory, child.name);
      if (child.isDirectory()) {
        entries.push({ name: `${ARCHIVE_ROOT}/${relativePath}/`, type: '5' });
        await visit(fullPath, relativePath);
      } else {
        entries.push({ name: `${ARCHIVE_ROOT}/${relativePath}`, type: '0', content: await readFile(fullPath) });
      }
    }
  }
  await visit(dataDirectory);
  return entries;
}

async function writeArchive(root, dataDirectory, mutate = (entries) => entries) {
  const entries = mutate(await archiveEntries(dataDirectory));
  const archivePath = path.join(root, 'artifact.tar');
  await writeFile(archivePath, Buffer.concat([
    ...entries.map(tarEntry),
    Buffer.alloc(BLOCK_SIZE * 2)
  ]));
  return archivePath;
}

test('accepts the committed data directory and its strict ustar package', async (t) => {
  const { root, dataDirectory } = await copiedData(t);
  const directoryResult = await validateExtractedDataArtifact(dataDirectory);
  assert.equal(directoryResult.countries, 73);
  assert.equal(directoryResult.snapshots, 7);
  const archivePath = await writeArchive(root, dataDirectory);
  const archiveResult = await validateTarArchive(archivePath);
  assert.ok(archiveResult.entries >= 12);
});

test('rejects historical price events that do not match Apple snapshot evidence', async (t) => {
  const { dataDirectory } = await copiedData(t);
  const historyPath = path.join(dataDirectory, 'history.json');
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const record = Object.values(history.markets).find(({ events }) => events.length > 1);
  assert.ok(record, 'production history must include a multi-event country');
  const tierId = Object.keys(record.events[0].plans)[0];
  record.events[0].plans[tierId] += 1;
  await writeJson(historyPath, history);
  await assert.rejects(
    validateExtractedDataArtifact(dataDirectory),
    /history events do not match snapshot evidence/
  );
});

test('rejects missing core files and extra files or directories', async (t) => {
  const missing = await copiedData(t);
  await unlink(path.join(missing.dataDirectory, 'prices.json'));
  await assert.rejects(validateExtractedDataArtifact(missing.dataDirectory), /missing required file prices\.json/);

  const extraFile = await copiedData(t);
  await writeFile(path.join(extraFile.dataDirectory, 'payload.html'), '<script>alert(1)</script>');
  await assert.rejects(validateExtractedDataArtifact(extraFile.dataDirectory), /unexpected file payload\.html/);

  const extraDirectory = await copiedData(t);
  await mkdir(path.join(extraDirectory.dataDirectory, 'uploads'));
  await assert.rejects(validateExtractedDataArtifact(extraDirectory.dataDirectory), /unexpected directory uploads/);
});

test('rejects ambiguous, malformed, or unsafe JSON encodings', async (t) => {
  for (const [label, duplicateKey] of [
    ['literal duplicate key', 'schemaVersion'],
    ['escaped duplicate key', '\\u0073chemaVersion']
  ]) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const runLogPath = path.join(dataDirectory, 'run-log.json');
      const original = await readFile(runLogPath, 'utf8');
      await writeFile(runLogPath, original.replace('{', `{\n  "${duplicateKey}": 999,`));
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /duplicate object key "schemaVersion"/);
    });
  }

  await t.test('UTF-8 byte-order mark', async (subtest) => {
    const { dataDirectory } = await copiedData(subtest);
    const pricesPath = path.join(dataDirectory, 'prices.json');
    const original = await readFile(pricesPath);
    await writeFile(pricesPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), original]));
    await assert.rejects(validateExtractedDataArtifact(dataDirectory), /byte-order mark/);
  });

  await t.test('invalid UTF-8', async (subtest) => {
    const { dataDirectory } = await copiedData(subtest);
    const pricesPath = path.join(dataDirectory, 'prices.json');
    await writeFile(pricesPath, Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d]));
    await assert.rejects(validateExtractedDataArtifact(dataDirectory), /not valid UTF-8/);
  });

  for (const [label, unsafeText] of [
    ['bidirectional control', `status\u202e`],
    ['unpaired surrogate', `status\ud800`]
  ]) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const runLogPath = path.join(dataDirectory, 'run-log.json');
      const runLog = JSON.parse(await readFile(runLogPath, 'utf8'));
      runLog.runs.at(-1).source.appleParserStatus = unsafeText;
      await writeJson(runLogPath, runLog);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /unsafe Unicode or control characters/);
    });
  }
});
test('rejects legacy schema 2 data even when its raw exchange rates are otherwise valid', async (t) => {
  const { dataDirectory } = await copiedData(t);
  const pricesPath = path.join(dataDirectory, 'prices.json');
  const prices = JSON.parse(await readFile(pricesPath, 'utf8'));
  prices.schemaVersion = 2;
  delete prices.fx.derivedCurrency;
  prices.fx.apiKeyStatus = 'valid';
  prices.fx.rates = Object.fromEntries(
    [...new Set(['USD', 'CNY', ...prices.countries.map(({ currency }) => currency)])]
      .sort()
      .map((currency) => [currency, currency === 'USD' ? 1 : 1.5])
  );
  for (const country of prices.countries) {
    for (const plan of Object.values(country.plans)) delete plan.cnyPrice;
  }
  await writeFile(pricesPath, `${JSON.stringify(prices, null, 2)}\n`);

  await assert.rejects(
    validateExtractedDataArtifact(dataDirectory),
    /prices\.json must use the current public schema/
  );
});

test('rejects legacy public history and history timestamps that diverge from current prices', async (t) => {
  for (const [label, mutate, expected] of [
    ['legacy schema', (history) => { history.schemaVersion = 1; delete history.updatedAt; }, /current public schema/],
    ['future timestamp', (history) => {
      history.updatedAt = '2099-01-01T00:00:00.000Z';
    }, /updated after|invalid event|invalid publication history/]
  ]) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const historyPath = path.join(dataDirectory, 'history.json');
      const history = JSON.parse(await readFile(historyPath, 'utf8'));
      mutate(history);
      await writeJson(historyPath, history);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), expected);
    });
  }
});

test('rejects public run logs that expose API-key status metadata', async (t) => {
  const { dataDirectory } = await copiedData(t);
  const runLogPath = path.join(dataDirectory, 'run-log.json');
  const runLog = JSON.parse(await readFile(runLogPath, 'utf8'));
  runLog.runs.at(-1).source.exchangeRatesApiKeyStatus = 'valid';
  await writeFile(runLogPath, `${JSON.stringify(runLog, null, 2)}\n`);
  await assert.rejects(
    validateExtractedDataArtifact(dataDirectory),
    /run-log\.json contains an invalid run/
  );
});

test('rejects unexpected fields and non-canonical ordering in normalized snapshots even with a recomputed file hash', async (t) => {
  const mutations = [
    ['top level', (snapshot) => { snapshot.rawHtml = '<html>private source</html>'; }],
    ['tier', (snapshot) => { snapshot.tiers[0].debug = true; }],
    ['country', (snapshot) => { snapshot.countries[0].sourceFragment = '<tr>private source</tr>'; }],
    ['tier ordering', (snapshot) => { snapshot.tiers.reverse(); }],
    ['tier count cap', (snapshot) => {
      snapshot.tiers = Array.from({ length: 21 }, () => structuredClone(snapshot.tiers[0]));
    }],
    ['country count cap', (snapshot) => {
      snapshot.countries = Array.from({ length: 251 }, () => structuredClone(snapshot.countries[0]));
    }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const indexPath = path.join(dataDirectory, 'apple-snapshots', 'index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      const revision = index.snapshots[0].revisions[0];
      const snapshotPath = path.join(dataDirectory, 'apple-snapshots', revision.dataFile);
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
      mutate(snapshot);
      revision.dataSha256 = (await writeJson(snapshotPath, snapshot)).sha256;
      await writeJson(indexPath, index);
      await assert.rejects(
        validateExtractedDataArtifact(dataDirectory),
        /snapshot .* (unsupported structure|invalid tiers|invalid country entry)/
      );
    });
  }
});

test('rejects unexpected fields at every snapshot-index layer', async (t) => {
  const mutations = [
    ['top level', (index) => { index.debug = true; }],
    ['publication entry', (index) => { index.snapshots[0].debug = true; }],
    ['revision', (index) => { index.snapshots[0].revisions[0].debug = true; }],
    ['publication count cap', (index) => {
      index.snapshots = Array.from({ length: 1001 }, () => structuredClone(index.snapshots[0]));
    }],
    ['revision count cap', (index) => {
      index.snapshots[0].revisions = Array.from(
        { length: 101 },
        () => structuredClone(index.snapshots[0].revisions[0])
      );
    }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const indexPath = path.join(dataDirectory, 'apple-snapshots', 'index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      mutate(index);
      await writeJson(indexPath, index);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /snapshot index|index\.json/);
    });
  }
});

test('rejects unrecognized snapshot parsers and non-canonical archive evidence URLs', async (t) => {
  const mutations = [
    ['parser', (revision) => { revision.parser = 'debug-parser'; }],
    ['archive host', (revision) => { revision.archiveUrl = 'https://example.com/web/20250518125256/https://support.apple.com/en-us/108047'; }],
    ['archive target', (revision) => { revision.archiveUrl = 'https://web.archive.org/web/20250518125256/https://example.com/private'; }],
    ['archive timestamp', (revision) => { revision.archiveUrl = 'https://web.archive.org/web/latest/https://support.apple.com/en-us/108047'; }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const indexPath = path.join(dataDirectory, 'apple-snapshots', 'index.json');
      const index = JSON.parse(await readFile(indexPath, 'utf8'));
      mutate(index.snapshots[0].revisions[0]);
      await writeJson(indexPath, index);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /snapshot index/);
    });
  }
});

test('rejects unexpected fields at every public run-log layer', async (t) => {
  const mutations = [
    ['top level', (runLog) => { runLog.debug = true; }],
    ['run', (runLog) => { runLog.runs.at(-1).debug = true; }],
    ['source', (runLog) => { runLog.runs.at(-1).source.rawRates = { USD: 1 }; }],
    ['counts', (runLog) => { runLog.runs.at(-1).counts.debug = true; }],
    ['counted tier', (runLog) => { runLog.runs.at(-1).counts.tiers[0].debug = true; }],
    ['changes', (runLog) => { runLog.runs.at(-1).changes.debug = true; }],
    ['publication change', (runLog) => { runLog.runs.at(-1).changes.publishedDate.debug = true; }],
    ['listed country', (runLog) => {
      runLog.runs.at(-1).changes.addedCountries.push({ country: 'Example', nameZh: '示例', debug: true });
    }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const runLogPath = path.join(dataDirectory, 'run-log.json');
      const runLog = JSON.parse(await readFile(runLogPath, 'utf8'));
      mutate(runLog);
      await writeJson(runLogPath, runLog);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /run-log\.json/);
    });
  }
});

test('rejects semantically invalid run-log evidence', async (t) => {
  const mutations = [
    ['retention cap', (_run, runLog) => { runLog.retention = 1001; }],
    ['run schema', (run) => { run.schemaVersion = 2; }],
    ['run id', (run) => { run.id = run.startedAtUtc; }],
    ['status', (run) => { run.status = 'failed'; }],
    ['trigger', (run) => { run.trigger = 'untrusted-trigger'; }],
    ['duration', (run) => { run.durationMs += 1; }],
    ['observation date', (run) => { run.observedAtBeijing = '2026-08-08'; }],
    ['manual automatic date', (run) => {
      run.trigger = 'manual';
      run.automaticRunDateBeijing = run.observedAtBeijing;
    }],
    ['Apple URL', (run) => { run.source.appleUrl = 'https://example.com/'; }],
    ['Apple publication date', (run) => { run.source.applePublishedDate = 'not a date'; }],
    ['Apple parser', (run) => { run.source.appleParser = 'debug-parser'; }],
    ['Apple parser status', (run) => { run.source.appleParserStatus = ''; }],
    ['FX stale type', (run) => { run.source.exchangeRatesStale = 'false'; }],
    ['FX timestamp', (run) => { run.source.exchangeRatesFetchedAtUtc = '2020-01-01T00:00:00.000Z'; }],
    ['FX source mode', (run) => { run.source.exchangeRatesSourceMode = 'debug'; }],
    ['FX fallback coherence', (run) => {
      run.source.exchangeRatesFallbackUsed = true;
      run.source.exchangeRatesFallbackReason = null;
    }],
    ['private FX credential reason', (run) => {
      run.source.exchangeRatesSourceMode = 'open-access';
      run.source.exchangeRatesFallbackUsed = true;
      run.source.exchangeRatesFallbackReason = 'invalid-key';
    }],
    ['country count', (run) => { run.counts.countries = 1; }],
    ['price-point count', (run) => { run.counts.pricePoints += 1; }],
    ['currency count', (run) => { run.counts.currencies = 0; }],
    ['tier order', (run) => { run.counts.tiers.reverse(); }],
    ['tier label', (run) => { run.counts.tiers[0].label = 'Fifty GB'; }],
    ['publication arrays', (run) => { run.changes.addedCountries = {}; }],
    ['no-op changed country', (run) => {
      run.changes.changedCountries.push({
        country: 'Example',
        nameZh: '示例',
        fromCurrency: 'USD',
        toCurrency: 'USD',
        fromRegion: 'Americas',
        toRegion: 'Americas',
        tiers: []
      });
    }],
    ['missing latest publication change', (run) => { delete run.changes.publishedDate; }],
    ['publication changed flag', (run) => { run.changes.publishedDate.changed = true; }]
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const runLogPath = path.join(dataDirectory, 'run-log.json');
      const runLog = JSON.parse(await readFile(runLogPath, 'utf8'));
      mutate(runLog.runs.at(-1), runLog);
      await writeJson(runLogPath, runLog);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), /run-log\.json/);
    });
  }
});

test('rejects hardlinked extracted files', async (t) => {
  const { root, dataDirectory } = await copiedData(t);
  const pricesPath = path.join(dataDirectory, 'prices.json');
  const externalPath = path.join(root, 'outside-prices.json');
  await cp(pricesPath, externalPath);
  await unlink(pricesPath);
  await link(externalPath, pricesPath);
  await assert.rejects(validateExtractedDataArtifact(dataDirectory), /hardlinked file prices\.json/);
});

test('requires the snapshot index to exactly match snapshot files', async (t) => {
  const missing = await copiedData(t);
  const missingIndex = JSON.parse(await readFile(path.join(missing.dataDirectory, 'apple-snapshots', 'index.json'), 'utf8'));
  const indexedFile = missingIndex.snapshots[0].revisions[0].dataFile;
  await unlink(path.join(missing.dataDirectory, 'apple-snapshots', indexedFile));
  await assert.rejects(validateExtractedDataArtifact(missing.dataDirectory), /snapshot index and files differ/);

  const unindexed = await copiedData(t);
  const sourceFile = path.join(unindexed.dataDirectory, 'apple-snapshots', '2026-07-17.json');
  await cp(sourceFile, path.join(unindexed.dataDirectory, 'apple-snapshots', '2026-07-17-deadbeefdead.json'));
  await assert.rejects(validateExtractedDataArtifact(unindexed.dataDirectory), /snapshot index and files differ/);
});

test('rejects publication changes that do not match the snapshot evidence', async (t) => {
  const { dataDirectory } = await copiedData(t);
  const historyPath = path.join(dataDirectory, 'history.json');
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  const changedTier = history.sourcePublishedDates
    .flatMap((entry) => entry.changes?.changedCountries ?? [])
    .flatMap((country) => country.tiers ?? [])[0];
  assert.ok(changedTier, 'production history must contain a changed-tier fixture');
  changedTier.to += 1;
  await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
  await assert.rejects(
    validateExtractedDataArtifact(dataDirectory),
    /publication changes do not match snapshot evidence/
  );
});

test('rejects archive path traversal, extra content, and missing core files', async (t) => {
  const first = await copiedData(t);
  const traversalArchive = await writeArchive(first.root, first.dataDirectory, (entries) => entries.map((entry) => (
    entry.name.endsWith('/prices.json') ? { ...entry, name: `${ARCHIVE_ROOT}/../escape.json` } : entry
  )));
  await assert.rejects(validateTarArchive(traversalArchive), /unsafe path|escapes/);

  const second = await copiedData(t);
  const extraArchive = await writeArchive(second.root, second.dataDirectory, (entries) => [
    ...entries,
    { name: `${ARCHIVE_ROOT}/payload.html`, type: '0', content: 'payload' }
  ]);
  await assert.rejects(validateTarArchive(extraArchive), /unexpected file payload\.html/);

  const third = await copiedData(t);
  const missingArchive = await writeArchive(third.root, third.dataDirectory, (entries) => (
    entries.filter((entry) => !entry.name.endsWith('/prices.json'))
  ));
  await assert.rejects(validateTarArchive(missingArchive), /missing required file prices\.json/);
});

test('rejects symlink, hardlink, and device entries before extraction', async (t) => {
  for (const [type, description] of [['2', 'symbolic link'], ['1', 'hard link'], ['3', 'device']]) {
    await t.test(description, async (subtest) => {
      const { root, dataDirectory } = await copiedData(subtest);
      const archivePath = await writeArchive(root, dataDirectory, (entries) => entries.map((entry) => (
        entry.name.endsWith('/prices.json')
          ? { ...entry, type, content: Buffer.alloc(0), linkName: type === '3' ? '' : '../../outside' }
          : entry
      )));
      await assert.rejects(validateTarArchive(archivePath), /forbidden type/);
    });
  }
});

test('requires exact POSIX ustar magic and version on every archive entry', async (t) => {
  for (const [field, value, expected] of [
    ['magic', '', /not POSIX ustar/],
    ['magic', 'ustar ', /not POSIX ustar/],
    ['version', '01', /unsupported ustar version/]
  ]) {
    await t.test(`${field}=${JSON.stringify(value)}`, async (subtest) => {
      const { root, dataDirectory } = await copiedData(subtest);
      const archivePath = await writeArchive(root, dataDirectory, (entries) => entries.map((entry) => (
        entry.name.endsWith('/prices.json') ? { ...entry, [field]: value } : entry
      )));
      await assert.rejects(validateTarArchive(archivePath), expected);
    });
  }
});

test('rejects executable and special permission modes before extraction', async (t) => {
  for (const [mode, expected] of [
    [0o755, /is executable/],
    [0o4644, /special permission bits/]
  ]) {
    await t.test(mode.toString(8), async (subtest) => {
      const { root, dataDirectory } = await copiedData(subtest);
      const archivePath = await writeArchive(root, dataDirectory, (entries) => entries.map((entry) => (
        entry.name.endsWith('/prices.json') ? { ...entry, mode } : entry
      )));
      await assert.rejects(validateTarArchive(archivePath), expected);
    });
  }
});

test('rejects executable and special permission modes after extraction', {
  skip: process.platform === 'win32' ? 'Windows does not expose POSIX executable and special permission bits' : false
}, async (t) => {
  for (const [mode, expected] of [
    [0o744, /is executable/],
    [0o4644, /special permission bits/]
  ]) {
    await t.test(mode.toString(8), async (subtest) => {
      const { dataDirectory } = await copiedData(subtest);
      const pricesPath = path.join(dataDirectory, 'prices.json');
      await chmod(pricesPath, mode);
      assert.equal((await lstat(pricesPath)).mode & 0o7777, mode);
      await assert.rejects(validateExtractedDataArtifact(dataDirectory), expected);
    });
  }
});
