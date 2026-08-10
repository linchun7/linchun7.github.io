import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPLE_SUPPORT_URL,
  canonicalTierDefinition,
  isPlainObject,
  isPublicFxFallbackReason,
  isValidPublicationChanges,
  isValidDateOnly,
  isValidIsoTimestamp,
  isValidPublishedDate,
  publicationDateKey,
  validatePayload,
  validatePriceHistoryConsistency
} from '../data-contract.js';

const ARCHIVE_ROOT = 'tools/icloud_price_comparison/data';
const REQUIRED_FILES = new Set([
  'prices.json',
  'history.json',
  'run-log.json',
  'apple-snapshots/README.md',
  'apple-snapshots/index.json'
]);
const ALLOWED_DIRECTORIES = new Set(['', 'apple-snapshots']);
const SNAPSHOT_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:-[a-f0-9]{12})?\.json$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_SNAPSHOT_TIERS = 20;
const MAX_SNAPSHOT_COUNTRIES = 250;
const MAX_SNAPSHOT_PUBLICATIONS = 1000;
const MAX_SNAPSHOT_REVISIONS_PER_PUBLICATION = 100;
const MAX_RUN_LOG_RETENTION = 1000;
const SNAPSHOT_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'publishedDate', 'tiers', 'countries']);
const SNAPSHOT_TIER_KEYS = new Set(['id', 'label', 'capacityGb']);
const SNAPSHOT_COUNTRY_KEYS = new Set(['country', 'region', 'currency', 'plans']);
const SNAPSHOT_INDEX_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'snapshots']);
const SNAPSHOT_INDEX_ENTRY_KEYS = new Set(['publishedDate', 'activeDataFile', 'activeContentHash', 'revisions']);
const SNAPSHOT_INDEX_REVISION_KEYS = new Set(['publishedDate', 'firstConfirmedDate', 'contentHash', 'dataSha256', 'dataFile', 'sourceUrl', 'archiveUrl', 'parser', 'countries', 'pricePoints']);
const SNAPSHOT_PARSER_VALUES = new Set(['legacy-archive-cross-checked', 'cross-checked', 'document-order', 'apple-markers-fallback']);
const WAYBACK_APPLE_URL_PATTERN = /^https:\/\/web\.archive\.org\/web\/\d{14}(?:id_)?\/https:\/\/support\.apple\.com\/en-us\/108047$/;
const RUN_LOG_TOP_LEVEL_KEYS = new Set(['schemaVersion', 'retention', 'updatedAtUtc', 'runs']);
const RUN_LOG_ENTRY_KEYS = new Set(['schemaVersion', 'id', 'status', 'trigger', 'automaticRunDateBeijing', 'startedAtUtc', 'finishedAtUtc', 'durationMs', 'observedAtBeijing', 'source', 'counts', 'changes']);
const RUN_LOG_SOURCE_KEYS = new Set(['appleUrl', 'applePublishedDate', 'appleParser', 'appleParserStatus', 'exchangeRatesFetchedAtUtc', 'exchangeRatesStale', 'exchangeRatesSourceMode', 'exchangeRatesFallbackUsed', 'exchangeRatesFallbackReason']);
const RUN_LOG_COUNT_KEYS = new Set(['countries', 'pricePoints', 'currencies', 'tiers']);
const RUN_LOG_TIER_KEYS = new Set(['id', 'label']);
const RUN_LOG_CHANGE_KEYS = new Set(['publishedDate', 'addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries']);
const RUN_LOG_PUBLICATION_CHANGE_KEYS = new Set(['changed', 'from', 'to']);
const RUN_LOG_TRIGGER_VALUES = new Set(['workflow_dispatch', 'schedule', 'github-schedule', 'cloudflare', 'manual', 'local']);
const RUN_LOG_AUTOMATIC_TRIGGER_VALUES = new Set(['github-schedule', 'cloudflare']);
const RUN_LOG_PARSER_VALUES = new Set(['cross-checked', 'document-order', 'apple-markers-fallback']);
const RUN_LOG_FX_SOURCE_MODE_VALUES = new Set(['api-key', 'open-access']);
const MAX_RUN_FX_AGE_MS = (36 * 60 * 60 * 1000) + MAX_FUTURE_SKEW_MS;
const UNSAFE_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FORBIDDEN_PUBLIC_TEXT_PATTERN = /[\0-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/u;
const BEIJING_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function latestAllowedSnapshotDate(nowMs = Date.now()) {
  if (!Number.isFinite(nowMs)) throw new Error('Current timestamp must be finite');
  const parts = BEIJING_DATE_FORMATTER.formatToParts(new Date(nowMs + MAX_FUTURE_SKEW_MS));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
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

function fail(message) {
  throw new Error(`Invalid iCloud data artifact: ${message}`);
}

function hasAllowedKeys(value, allowedKeys, requiredKeys = []) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowedKeys.has(key))
    && requiredKeys.every((key) => Object.hasOwn(value, key));
}

function hasExactKeys(value, expectedKeys) {
  return hasAllowedKeys(value, expectedKeys, [...expectedKeys])
    && Object.keys(value).length === expectedKeys.size;
}

function safeNonEmptyText(value, maxLength = 512) {
  return typeof value === 'string'
    && value.length <= maxLength
    && Boolean(value.trim())
    && !/[\0-\x1f\x7f]/.test(value);
}

function formatBeijingDate(value) {
  const parts = BEIJING_DATE_FORMATTER.formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
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

function assertSafeJsonStrings(value, label) {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (FORBIDDEN_PUBLIC_TEXT_PATTERN.test(current) || hasUnpairedSurrogate(current)) {
        fail(`${label} contains unsafe Unicode or control characters`);
      }
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isPlainObject(current)) {
      for (const [key, child] of Object.entries(current)) {
        if (UNSAFE_JSON_KEYS.has(key)
          || FORBIDDEN_PUBLIC_TEXT_PATTERN.test(key)
          || hasUnpairedSurrogate(key)) fail(`${label} contains an unsafe object key`);
        pending.push(child);
      }
    }
  }
}

function assertNoDuplicateJsonKeys(text, label) {
  const containers = [];
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
        } else if (text[index] === '"') {
          index += 1;
          break;
        } else {
          index += 1;
        }
      }
      let next = index;
      while (/\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === ':') {
        const container = containers.at(-1);
        if (container?.type !== 'object') fail(`${label} has an invalid object-key context`);
        const key = JSON.parse(text.slice(start, index));
        if (container.keys.has(key)) fail(`${label} contains duplicate object key ${JSON.stringify(key)}`);
        container.keys.add(key);
      }
      continue;
    }
    if (character === '{') containers.push({ type: 'object', keys: new Set() });
    else if (character === '[') containers.push({ type: 'array' });
    else if (character === '}' || character === ']') containers.pop();
    index += 1;
  }
}

function normalizePath(value, { directory = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[\0-\x1f\x7f]/.test(value)) {
    fail(`unsafe path ${JSON.stringify(value)}`);
  }
  const normalized = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!normalized
    || normalized.startsWith('/')
    || /^[A-Za-z]:/.test(normalized)
    || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail(`unsafe path ${JSON.stringify(value)}`);
  }
  return normalized;
}

function relativeArchivePath(value, options) {
  const normalized = normalizePath(value, options);
  if (normalized === ARCHIVE_ROOT) return '';
  if (!normalized.startsWith(`${ARCHIVE_ROOT}/`)) fail(`entry escapes ${ARCHIVE_ROOT}: ${normalized}`);
  return normalized.slice(ARCHIVE_ROOT.length + 1);
}

function assertAllowedEntry(relativePath, type) {
  if (type === 'directory') {
    if (!ALLOWED_DIRECTORIES.has(relativePath)) fail(`unexpected directory ${relativePath || '.'}`);
    return;
  }
  if (REQUIRED_FILES.has(relativePath)) return;
  const snapshotName = relativePath.startsWith('apple-snapshots/')
    ? relativePath.slice('apple-snapshots/'.length)
    : '';
  if (!SNAPSHOT_FILE_PATTERN.test(snapshotName)) fail(`unexpected file ${relativePath}`);
}

function tarText(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  const end = field.indexOf(0);
  const value = field.subarray(0, end < 0 ? field.length : end).toString('utf8');
  if (value.includes('\uFFFD') || /[\0-\x1f\x7f]/.test(value)) fail(`${label} contains invalid text`);
  return value;
}

function tarOctal(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if (field[0] & 0x80) fail(`${label} uses unsupported base-256 encoding`);
  const text = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) fail(`${label} is not valid octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is out of range`);
  return value;
}

function verifyTarChecksum(header) {
  const expected = tarOctal(header, 148, 8, 'archive checksum');
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) fail('archive checksum mismatch');
}

function verifyUstarHeader(header) {
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0', 'ascii'))) {
    fail('archive entry is not POSIX ustar');
  }
  if (!header.subarray(263, 265).equals(Buffer.from('00', 'ascii'))) {
    fail('archive entry has an unsupported ustar version');
  }
}

function assertSafeMode(mode, label, { directory = false } = {}) {
  if (mode > 0o7777) fail(`${label} has an unsupported permission mode`);
  if ((mode & 0o7000) !== 0) fail(`${label} has special permission bits`);
  if (!directory && (mode & 0o111) !== 0) fail(`${label} is executable`);
}

function isZeroBlock(block) {
  return block.every((value) => value === 0);
}
export async function validateTarArchive(archivePath) {
  const archiveStats = await lstat(archivePath).catch((error) => fail(`cannot stat archive: ${error.message}`));
  if (!archiveStats.isFile() || archiveStats.nlink !== 1) fail('archive must be a regular, non-hardlinked file');
  if (archiveStats.size <= TAR_BLOCK_BYTES * 2 || archiveStats.size > MAX_ARCHIVE_BYTES) {
    fail(`archive size ${archiveStats.size} is outside the allowed range`);
  }
  if (archiveStats.size % TAR_BLOCK_BYTES !== 0) fail('archive is not block-aligned');

  const archive = await readFile(archivePath);
  const entries = new Map();
  let offset = 0;
  let ended = false;
  while (offset < archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (isZeroBlock(header)) {
      if (archive.length - offset < TAR_BLOCK_BYTES * 2
        || !archive.subarray(offset).every((value) => value === 0)) fail('archive has a malformed end marker');
      ended = true;
      break;
    }
    verifyTarChecksum(header);
    verifyUstarHeader(header);
    const name = tarText(header, 0, 100, 'archive name');
    const prefix = tarText(header, 345, 155, 'archive prefix');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const typeFlag = String.fromCharCode(header[156] || 0);
    const linkName = tarText(header, 157, 100, 'archive link target');
    if (!['\0', '0', '5'].includes(typeFlag)) fail(`entry ${fullName} has forbidden type ${typeFlag}`);
    if (linkName) fail(`entry ${fullName} declares a link target`);
    const directory = typeFlag === '5';
    const mode = tarOctal(header, 100, 8, 'archive mode');
    assertSafeMode(mode, `entry ${fullName}`, { directory });
    const size = tarOctal(header, 124, 12, 'archive size');
    if (directory && size !== 0) fail(`directory ${fullName} has non-zero content`);
    if (!directory && size > MAX_FILE_BYTES) fail(`file ${fullName} is too large`);
    const relativePath = relativeArchivePath(fullName, { directory });
    assertAllowedEntry(relativePath, directory ? 'directory' : 'file');
    if (entries.has(relativePath)) fail(`duplicate archive path ${relativePath || '.'}`);
    entries.set(relativePath, directory ? 'directory' : 'file');

    offset += TAR_BLOCK_BYTES + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset > archive.length) fail(`entry ${fullName} is truncated`);
  }
  if (!ended) fail('archive has no valid end marker');
  for (const directory of ALLOWED_DIRECTORIES) {
    if (entries.get(directory) !== 'directory') fail(`missing required directory ${directory || '.'}`);
  }
  for (const file of REQUIRED_FILES) {
    if (entries.get(file) !== 'file') fail(`missing required file ${file}`);
  }
  return { entries: entries.size, bytes: archive.length };
}

async function listExtractedEntries(rootPath) {
  const entries = new Map();
  let totalBytes = 0;
  async function visit(directoryPath, relativeDirectory = '') {
    const children = await readdir(directoryPath, { withFileTypes: true });
    for (const child of children) {
      if (child.name.includes('/') || child.name.includes('\\')) fail(`unsafe extracted name ${child.name}`);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const absolutePath = path.join(directoryPath, child.name);
      const entryStats = await lstat(absolutePath);
      if (entryStats.isSymbolicLink()) fail(`symbolic link ${relativePath}`);
      assertSafeMode(entryStats.mode & 0o7777, `extracted entry ${relativePath}`, {
        directory: entryStats.isDirectory()
      });
      if (entryStats.isDirectory()) {
        assertAllowedEntry(relativePath, 'directory');
        entries.set(relativePath, { type: 'directory', absolutePath });
        await visit(absolutePath, relativePath);
      } else if (entryStats.isFile()) {
        if (entryStats.nlink !== 1) fail(`hardlinked file ${relativePath}`);
        if (entryStats.size > MAX_FILE_BYTES) fail(`oversized file ${relativePath}`);
        assertAllowedEntry(relativePath, 'file');
        totalBytes += entryStats.size;
        if (totalBytes > MAX_TOTAL_BYTES) fail('files exceed the total size limit');
        entries.set(relativePath, { type: 'file', absolutePath });
      } else {
        fail(`forbidden filesystem type ${relativePath}`);
      }
    }
  }
  await visit(rootPath);
  return entries;
}

async function readJsonStrict(filePath, label) {
  const buffer = await readFile(filePath).catch((error) => fail(`cannot read ${label}: ${error.message}`));
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    fail(`${label} must not contain a UTF-8 byte-order mark`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (error) {
    fail(`${label} is not valid UTF-8: ${error.message}`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
  assertNoDuplicateJsonKeys(text, label);
  assertSafeJsonStrings(value, label);
  return { value, buffer };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeSnapshotPricing(snapshot) {
  return {
    tiers: snapshot.tiers
      .map(({ id, label, capacityGb }) => ({ id, label, capacityGb }))
      .sort((first, second) => first.capacityGb - second.capacityGb),
    countries: snapshot.countries.map(({ country, region, currency, plans }) => ({
      country,
      region,
      currency,
      plans: Object.fromEntries(Object.entries(plans).sort(([first], [second]) => first.localeCompare(second)))
    })).sort((first, second) => first.country.localeCompare(second.country))
  };
}

function buildExpectedSnapshotChanges(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot) {
    return { addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: [] };
  }
  const previousCountries = new Map(previousSnapshot.countries.map((country) => [country.country, country]));
  const currentCountries = new Map(currentSnapshot.countries.map((country) => [country.country, country]));
  const previousTiers = new Map(previousSnapshot.tiers.map((tier) => [tier.id, tier]));
  const currentTiers = new Map(currentSnapshot.tiers.map((tier) => [tier.id, tier]));
  const addedTiers = currentSnapshot.tiers
    .filter(({ id }) => !previousTiers.has(id))
    .map(({ id, label }) => ({ id, label }));
  const removedTiers = previousSnapshot.tiers
    .filter(({ id }) => !currentTiers.has(id))
    .map(({ id, label }) => ({ id, label }));
  const addedCountries = currentSnapshot.countries
    .filter(({ country }) => !previousCountries.has(country))
    .map(({ country }) => ({ country }));
  const removedCountries = previousSnapshot.countries
    .filter(({ country }) => !currentCountries.has(country))
    .map(({ country }) => ({ country }));
  const changedCountries = [];
  for (const country of currentSnapshot.countries) {
    const previous = previousCountries.get(country.country);
    if (!previous) continue;
    const tiers = currentSnapshot.tiers
      .filter(({ id }) => previousTiers.has(id) && previous.plans[id] !== country.plans[id])
      .map(({ id }) => ({ id, from: previous.plans[id] ?? null, to: country.plans[id] ?? null }));
    if (previous.currency !== country.currency || previous.region !== country.region || tiers.length) {
      changedCountries.push({
        country: country.country,
        fromCurrency: previous.currency,
        toCurrency: country.currency,
        fromRegion: previous.region,
        toRegion: country.region,
        tiers
      });
    }
  }
  return { addedTiers, removedTiers, addedCountries, removedCountries, changedCountries };
}

function canonicalPublicationChanges(changes = {}) {
  const byId = (first, second) => first.id.localeCompare(second.id);
  const byCountry = (first, second) => first.country.localeCompare(second.country);
  return {
    addedTiers: (changes.addedTiers ?? []).map(({ id, label }) => ({ id, label })).sort(byId),
    removedTiers: (changes.removedTiers ?? []).map(({ id, label }) => ({ id, label })).sort(byId),
    addedCountries: (changes.addedCountries ?? []).map(({ country }) => ({ country })).sort(byCountry),
    removedCountries: (changes.removedCountries ?? []).map(({ country }) => ({ country })).sort(byCountry),
    changedCountries: (changes.changedCountries ?? []).map((country) => ({
      country: country.country,
      fromCurrency: country.fromCurrency,
      toCurrency: country.toCurrency,
      fromRegion: country.fromRegion,
      toRegion: country.toRegion,
      tiers: (country.tiers ?? []).map(({ id, from, to }) => ({ id, from, to })).sort(byId)
    })).sort(byCountry)
  };
}

function validateNormalizedSnapshot(snapshot, expectedDate) {
  if (!hasExactKeys(snapshot, SNAPSHOT_TOP_LEVEL_KEYS)
    || snapshot.schemaVersion !== 1
    || snapshot.publishedDate !== expectedDate
    || !Array.isArray(snapshot.tiers)
    || !snapshot.tiers.length
    || snapshot.tiers.length > MAX_SNAPSHOT_TIERS
    || !Array.isArray(snapshot.countries)
    || snapshot.countries.length < 60
    || snapshot.countries.length > MAX_SNAPSHOT_COUNTRIES) fail(`snapshot ${expectedDate} has an unsupported structure`);

  const tierIds = new Set();
  const capacities = new Set();
  let previousCapacity = 0;
  for (const tier of snapshot.tiers) {
    const canonical = canonicalTierDefinition(tier?.id);
    if (!hasExactKeys(tier, SNAPSHOT_TIER_KEYS)
      || canonical === null
      || tier.label !== canonical.label
      || tier.capacityGb !== canonical.capacityGb
      || tierIds.has(tier.id)
      || capacities.has(tier.capacityGb)
      || tier.capacityGb <= previousCapacity) fail(`snapshot ${expectedDate} has invalid tiers`);
    tierIds.add(tier.id);
    capacities.add(tier.capacityGb);
    previousCapacity = tier.capacityGb;
  }
  const countryNames = new Set();
  for (const country of snapshot.countries) {
    const planIds = isPlainObject(country?.plans) ? Object.keys(country.plans) : [];
    if (!hasExactKeys(country, SNAPSHOT_COUNTRY_KEYS)
      || typeof country.country !== 'string'
      || !country.country.trim()
      || countryNames.has(country.country)
      || typeof country.region !== 'string'
      || !country.region.trim()
      || typeof country.currency !== 'string'
      || !/^[A-Z]{3}$/.test(country.currency)
      || planIds.length !== tierIds.size
      || [...tierIds].some((tierId) => !Object.hasOwn(country.plans, tierId))
      || Object.values(country.plans).some((price) => (
        !Number.isFinite(price) || price <= 0 || price > Number.MAX_SAFE_INTEGER
      ))) {
      fail(`snapshot ${expectedDate} has an invalid country entry`);
    }
    countryNames.add(country.country);
  }
  return normalizeSnapshotPricing(snapshot);
}

function validateSnapshotIndex(index) {
  if (!hasExactKeys(index, SNAPSHOT_INDEX_TOP_LEVEL_KEYS)
    || index.schemaVersion !== 2
    || !Array.isArray(index.snapshots)
    || !index.snapshots.length
    || index.snapshots.length > MAX_SNAPSHOT_PUBLICATIONS) {
    fail('apple-snapshots/index.json has an unsupported structure');
  }
  const dates = new Set();
  const files = new Set();
  const snapshots = [];
  let previousDate = '';
  const latestAllowedDate = latestAllowedSnapshotDate();
  for (const snapshot of index.snapshots) {
    const publishedDate = snapshot?.publishedDate;
    if (!hasExactKeys(snapshot, SNAPSHOT_INDEX_ENTRY_KEYS)
      || !isValidDateOnly(publishedDate)
      || publishedDate <= previousDate
      || dates.has(publishedDate)
      || !Array.isArray(snapshot.revisions)
      || !snapshot.revisions.length
      || snapshot.revisions.length > MAX_SNAPSHOT_REVISIONS_PER_PUBLICATION) fail('snapshot index has invalid or unsorted publication entries');
    dates.add(publishedDate);
    previousDate = publishedDate;
    const hashes = new Set();
    const revisions = [];
    let previousConfirmedDate = '';
    for (const revision of snapshot.revisions) {
      const filePattern = new RegExp(`^${publishedDate}(?:-[a-f0-9]{12})?\\.json$`);
      if (!hasAllowedKeys(
        revision,
        SNAPSHOT_INDEX_REVISION_KEYS,
        ['publishedDate', 'firstConfirmedDate', 'contentHash', 'dataSha256', 'dataFile', 'sourceUrl', 'parser', 'countries', 'pricePoints']
      )
        || revision.publishedDate !== publishedDate
        || !isValidDateOnly(revision.firstConfirmedDate)
        || revision.firstConfirmedDate < publishedDate
        || revision.firstConfirmedDate < previousConfirmedDate
        || revision.firstConfirmedDate > latestAllowedDate
        || revision.sourceUrl !== APPLE_SUPPORT_URL
        || (revision.archiveUrl !== undefined && !WAYBACK_APPLE_URL_PATTERN.test(revision.archiveUrl))
        || !SNAPSHOT_PARSER_VALUES.has(revision.parser)
        || !Number.isInteger(revision.countries)
        || revision.countries < 60
        || !Number.isInteger(revision.pricePoints)
        || revision.pricePoints <= 0
        || !filePattern.test(revision.dataFile ?? '')
        || !SHA256_PATTERN.test(revision.contentHash ?? '')
        || !SHA256_PATTERN.test(revision.dataSha256 ?? '')
        || files.has(revision.dataFile)
        || hashes.has(revision.contentHash)) fail(`snapshot index has an invalid revision for ${publishedDate}`);
      previousConfirmedDate = revision.firstConfirmedDate;
      files.add(revision.dataFile);
      hashes.add(revision.contentHash);
      revisions.push(revision);
    }
    const active = revisions.at(-1);
    if (snapshot.activeDataFile !== active.dataFile || snapshot.activeContentHash !== active.contentHash) {
      fail(`snapshot index has an invalid active revision for ${publishedDate}`);
    }
    snapshots.push({ ...snapshot, revisions });
  }
  return { snapshots, files };
}

function isValidRunLogSource(source, run, futureLimit) {
  if (!isPlainObject(source)) return false;
  const hasParser = Object.hasOwn(source, 'appleParser');
  const hasParserStatus = Object.hasOwn(source, 'appleParserStatus');
  const hasFxMode = Object.hasOwn(source, 'exchangeRatesSourceMode');
  const hasFxFallbackUsed = Object.hasOwn(source, 'exchangeRatesFallbackUsed');
  const hasFxFallbackReason = Object.hasOwn(source, 'exchangeRatesFallbackReason');
  const hasCompleteFxMetadata = hasFxMode && hasFxFallbackUsed && hasFxFallbackReason;
  const parserMetadataValid = hasParser === hasParserStatus && (!hasParser || (
    (source.appleParser === null && source.appleParserStatus === null)
    || (RUN_LOG_PARSER_VALUES.has(source.appleParser) && safeNonEmptyText(source.appleParserStatus))
  ));
  const fallbackReasonRequired = source.exchangeRatesStale || source.exchangeRatesFallbackUsed;
  const fallbackMetadataValid = (!hasCompleteFxMetadata && !source.exchangeRatesStale) || (
    RUN_LOG_FX_SOURCE_MODE_VALUES.has(source.exchangeRatesSourceMode)
    && typeof source.exchangeRatesFallbackUsed === 'boolean'
    && isPublicFxFallbackReason(source.exchangeRatesFallbackReason)
    && (fallbackReasonRequired
      ? typeof source.exchangeRatesFallbackReason === 'string'
      : source.exchangeRatesFallbackReason === null)
    && (source.exchangeRatesStale
      || !source.exchangeRatesFallbackUsed
      || source.exchangeRatesSourceMode === 'open-access')
  );
  const finishedAtMs = Date.parse(run.finishedAtUtc);
  const fetchedAtMs = Date.parse(source.exchangeRatesFetchedAtUtc);
  return hasAllowedKeys(
    source,
    RUN_LOG_SOURCE_KEYS,
    ['appleUrl', 'applePublishedDate', 'exchangeRatesFetchedAtUtc', 'exchangeRatesStale']
  )
    && source.appleUrl === APPLE_SUPPORT_URL
    && safeNonEmptyText(source.applePublishedDate, 100)
    && isValidPublishedDate(source.applePublishedDate)
    && publicationDateKey(source.applePublishedDate) <= run.observedAtBeijing
    && parserMetadataValid
    && (hasFxMode === hasFxFallbackUsed && hasFxFallbackUsed === hasFxFallbackReason)
    && fallbackMetadataValid
    && typeof source.exchangeRatesStale === 'boolean'
    && isValidIsoTimestamp(source.exchangeRatesFetchedAtUtc)
    && fetchedAtMs <= futureLimit
    && fetchedAtMs <= finishedAtMs + MAX_FUTURE_SKEW_MS
    && finishedAtMs - fetchedAtMs <= MAX_RUN_FX_AGE_MS;
}

function isValidRunLogCounts(counts) {
  if (!hasExactKeys(counts, RUN_LOG_COUNT_KEYS)
    || !Number.isSafeInteger(counts.countries)
    || counts.countries < 60
    || counts.countries > MAX_SNAPSHOT_COUNTRIES
    || !Number.isSafeInteger(counts.pricePoints)
    || counts.pricePoints <= 0
    || !Number.isSafeInteger(counts.currencies)
    || counts.currencies <= 0
    || counts.currencies > counts.countries
    || !Array.isArray(counts.tiers)
    || !counts.tiers.length
    || counts.tiers.length > MAX_SNAPSHOT_TIERS
    || counts.pricePoints !== counts.countries * counts.tiers.length) return false;

  const tierIds = new Set();
  const capacities = new Set();
  let previousCapacity = 0;
  return counts.tiers.every((tier) => {
    const canonical = canonicalTierDefinition(tier?.id);
    if (!hasExactKeys(tier, RUN_LOG_TIER_KEYS)
      || canonical === null
      || tier.label !== canonical.label
      || tierIds.has(tier.id)
      || capacities.has(canonical.capacityGb)
      || canonical.capacityGb <= previousCapacity) return false;
    tierIds.add(tier.id);
    capacities.add(canonical.capacityGb);
    previousCapacity = canonical.capacityGb;
    return true;
  });
}

function isValidRunLogChanges(changes, sourcePublishedDate) {
  if (!hasAllowedKeys(
    changes,
    RUN_LOG_CHANGE_KEYS,
    ['addedTiers', 'removedTiers', 'addedCountries', 'removedCountries', 'changedCountries']
  )) return false;
  const { publishedDate, ...publicationChanges } = changes;
  if (!isValidPublicationChanges(publicationChanges)) return false;
  if (publishedDate === undefined) return true;
  if (!hasExactKeys(publishedDate, RUN_LOG_PUBLICATION_CHANGE_KEYS)
    || typeof publishedDate.changed !== 'boolean'
    || (publishedDate.from !== null && !isValidPublishedDate(publishedDate.from))
    || (publishedDate.to !== null && !isValidPublishedDate(publishedDate.to))
    || publishedDate.to === null
    || publicationDateKey(publishedDate.to) !== publicationDateKey(sourcePublishedDate)) return false;
  const fromKey = publishedDate.from === null ? null : publicationDateKey(publishedDate.from);
  const toKey = publicationDateKey(publishedDate.to);
  return publishedDate.changed === (fromKey !== toKey);
}

function validateRunLog(runLog, prices) {
  if (!hasExactKeys(runLog, RUN_LOG_TOP_LEVEL_KEYS)
    || runLog.schemaVersion !== 1
    || !Number.isInteger(runLog.retention)
    || runLog.retention <= 0
    || runLog.retention > MAX_RUN_LOG_RETENTION
    || !isValidIsoTimestamp(runLog.updatedAtUtc)
    || !Array.isArray(runLog.runs)
    || !runLog.runs.length
    || runLog.runs.length > runLog.retention) fail('run-log.json has an unsupported structure');

  let previousFinishedAt = '';
  const futureLimit = Date.now() + MAX_FUTURE_SKEW_MS;
  for (const run of runLog.runs) {
    if (!hasAllowedKeys(
      run,
      RUN_LOG_ENTRY_KEYS,
      ['schemaVersion', 'id', 'status', 'trigger', 'startedAtUtc', 'finishedAtUtc', 'durationMs', 'observedAtBeijing', 'source', 'counts', 'changes']
    )
      || run.schemaVersion !== 1
      || run.id !== run.finishedAtUtc
      || run.status !== 'success'
      || !RUN_LOG_TRIGGER_VALUES.has(run.trigger)
      || !isValidIsoTimestamp(run.startedAtUtc)
      || !isValidIsoTimestamp(run.finishedAtUtc)
      || run.finishedAtUtc < run.startedAtUtc
      || run.finishedAtUtc <= previousFinishedAt
      || Date.parse(run.startedAtUtc) > futureLimit
      || Date.parse(run.finishedAtUtc) > futureLimit
      || !Number.isSafeInteger(run.durationMs)
      || run.durationMs < 0
      || run.durationMs !== Date.parse(run.finishedAtUtc) - Date.parse(run.startedAtUtc)
      || !isValidDateOnly(run.observedAtBeijing)
      || run.observedAtBeijing !== formatBeijingDate(run.finishedAtUtc)
      || (run.automaticRunDateBeijing !== undefined
        && run.automaticRunDateBeijing !== null
        && !isValidDateOnly(run.automaticRunDateBeijing))
      || (RUN_LOG_AUTOMATIC_TRIGGER_VALUES.has(run.trigger)
        && run.automaticRunDateBeijing !== run.observedAtBeijing)
      || (!RUN_LOG_AUTOMATIC_TRIGGER_VALUES.has(run.trigger)
        && !['schedule'].includes(run.trigger)
        && run.automaticRunDateBeijing !== undefined
        && run.automaticRunDateBeijing !== null)
      || !isValidRunLogSource(run.source, run, futureLimit)
      || !isValidRunLogCounts(run.counts)
      || !isValidRunLogChanges(run.changes, run.source?.applePublishedDate)) fail('run-log.json contains an invalid run');
    previousFinishedAt = run.finishedAtUtc;
  }
  const latest = runLog.runs.at(-1);
  const expectedTiers = prices.tiers.map(({ id, label }) => ({ id, label }));
  if (runLog.updatedAtUtc !== latest.finishedAtUtc
    || latest.finishedAtUtc !== (prices.run?.finishedAtUtc ?? prices.generatedAt)
    || latest.startedAtUtc !== prices.run?.startedAtUtc
    || latest.observedAtBeijing !== prices.run?.observedAtBeijing
    || latest.source?.appleUrl !== prices.source.url
    || publicationDateKey(latest.source?.applePublishedDate) !== publicationDateKey(prices.source.publishedDate)
    || latest.source?.appleParser !== prices.source.parser
    || latest.source?.appleParserStatus !== prices.source.parserStatus
    || latest.source?.exchangeRatesFetchedAtUtc !== prices.fx.fetchedAt
    || latest.source?.exchangeRatesStale !== prices.fx.stale
    || latest.source?.exchangeRatesSourceMode !== prices.fx.sourceMode
    || latest.source?.exchangeRatesFallbackUsed !== prices.fx.fallbackUsed
    || latest.source?.exchangeRatesFallbackReason !== prices.fx.fallbackReason
    || !isPlainObject(latest.changes?.publishedDate)
    || latest.counts?.countries !== prices.countries.length
    || latest.counts?.pricePoints !== prices.countries.length * prices.tiers.length
    || latest.counts?.currencies !== new Set(prices.countries.map(({ currency }) => currency)).size
    || JSON.stringify(latest.counts?.tiers) !== JSON.stringify(expectedTiers)) {
    fail('run-log.json latest run does not match prices.json');
  }
}
export async function validateExtractedDataArtifact(dataDirectory) {
  const rootStats = await lstat(dataDirectory).catch((error) => fail(`cannot stat data directory: ${error.message}`));
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) fail('data root must be a real directory');
  assertSafeMode(rootStats.mode & 0o7777, 'data root', { directory: true });
  const [rootRealPath, parentRealPath] = await Promise.all([realpath(dataDirectory), realpath(path.dirname(dataDirectory))]);
  if (path.dirname(rootRealPath) !== parentRealPath) fail('data root resolves outside its parent');

  const entries = await listExtractedEntries(dataDirectory);
  if (entries.get('apple-snapshots')?.type !== 'directory') fail('missing required directory apple-snapshots');
  for (const file of REQUIRED_FILES) {
    if (entries.get(file)?.type !== 'file') fail(`missing required file ${file}`);
  }

  const [{ value: prices }, { value: history }, { value: runLog }, { value: index }] = await Promise.all([
    readJsonStrict(path.join(dataDirectory, 'prices.json'), 'prices.json'),
    readJsonStrict(path.join(dataDirectory, 'history.json'), 'history.json'),
    readJsonStrict(path.join(dataDirectory, 'run-log.json'), 'run-log.json'),
    readJsonStrict(path.join(dataDirectory, 'apple-snapshots', 'index.json'), 'apple-snapshots/index.json')
  ]);
  try {
    validatePayload('prices.json', prices);
    validatePayload('history.json', history);
    validatePriceHistoryConsistency(prices, history);
  } catch (error) {
    fail(error.message);
  }
  validateRunLog(runLog, prices);

  const normalizedIndex = validateSnapshotIndex(index);
  const expectedFiles = new Set(REQUIRED_FILES);
  for (const fileName of normalizedIndex.files) expectedFiles.add(`apple-snapshots/${fileName}`);
  const actualFiles = new Set([...entries.entries()]
    .filter(([, entry]) => entry.type === 'file')
    .map(([relativePath]) => relativePath));
  const missingFiles = [...expectedFiles].filter((file) => !actualFiles.has(file));
  const unexpectedFiles = [...actualFiles].filter((file) => !expectedFiles.has(file));
  if (missingFiles.length || unexpectedFiles.length) {
    fail(`snapshot index and files differ; missing=[${missingFiles.join(', ')}], unexpected=[${unexpectedFiles.join(', ')}]`);
  }

  const publicationHistory = new Map(history.sourcePublishedDates.map((entry) => [publicationDateKey(entry.publishedDate), entry]));
  if (publicationHistory.size !== normalizedIndex.snapshots.length) fail('snapshot index and publication history date counts differ');
  const normalizedSnapshots = new Map();
  for (const snapshot of normalizedIndex.snapshots) {
    const historyEntry = publicationHistory.get(snapshot.publishedDate);
    if (!historyEntry || historyEntry.observedAt !== snapshot.revisions[0].firstConfirmedDate) {
      fail(`snapshot ${snapshot.publishedDate} does not match publication history`);
    }
    for (const revision of snapshot.revisions) {
      const snapshotPath = path.join(dataDirectory, 'apple-snapshots', revision.dataFile);
      const { value: snapshotData, buffer } = await readJsonStrict(snapshotPath, revision.dataFile);
      if (sha256(buffer) !== revision.dataSha256) fail(`snapshot ${revision.dataFile} raw SHA-256 mismatch`);
      const normalizedPricing = validateNormalizedSnapshot(snapshotData, snapshot.publishedDate);
      normalizedSnapshots.set(revision.dataFile, normalizedPricing);
      if (snapshotData.countries.length !== revision.countries
        || snapshotData.countries.length * snapshotData.tiers.length !== revision.pricePoints) {
        fail(`snapshot ${revision.dataFile} count mismatch`);
      }
      if (sha256(JSON.stringify(normalizedPricing)) !== revision.contentHash) {
        fail(`snapshot ${revision.dataFile} pricing hash mismatch`);
      }
    }
  }

  let previousActiveSnapshot = null;
  for (const snapshot of normalizedIndex.snapshots) {
    const firstSnapshot = normalizedSnapshots.get(snapshot.revisions[0].dataFile);
    const expectedChanges = canonicalPublicationChanges(
      buildExpectedSnapshotChanges(previousActiveSnapshot, firstSnapshot)
    );
    const actualChanges = canonicalPublicationChanges(publicationHistory.get(snapshot.publishedDate)?.changes);
    if (JSON.stringify(actualChanges) !== JSON.stringify(expectedChanges)) {
      fail(`publication changes do not match snapshot evidence for ${snapshot.publishedDate}`);
    }
    previousActiveSnapshot = normalizedSnapshots.get(snapshot.activeDataFile);
  }

  const latestSnapshot = normalizedIndex.snapshots.at(-1);
  if (latestSnapshot.publishedDate !== publicationDateKey(prices.source.publishedDate)) {
    fail('latest snapshot date does not match prices.json');
  }
  const currentPricing = {
    tiers: prices.tiers,
    countries: prices.countries.map(({ country, region, currency, plans }) => ({
      country,
      region,
      currency,
      plans: Object.fromEntries(Object.entries(plans).map(([tierId, plan]) => [tierId, plan.price]))
    }))
  };
  if (sha256(JSON.stringify(normalizeSnapshotPricing(currentPricing))) !== latestSnapshot.activeContentHash) {
    fail('latest snapshot pricing does not match prices.json');
  }
  return {
    files: actualFiles.size,
    snapshots: normalizedIndex.files.size,
    countries: prices.countries.length,
    pricePoints: prices.countries.length * prices.tiers.length
  };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || !['--archive', '--data-dir'].includes(argv[0])) {
    throw new Error('Usage: node scripts/validate-data-artifact.mjs (--archive <tar-path> | --data-dir <directory>)');
  }
  const target = path.resolve(argv[1]);
  const result = argv[0] === '--archive'
    ? await validateTarArchive(target)
    : await validateExtractedDataArtifact(target);
  console.log(`Validated iCloud data artifact: ${JSON.stringify(result)}`);
}

if (process.argv[1]) {
  const [entryPath, modulePath] = await Promise.all([
    realpath(process.argv[1]).catch(() => path.resolve(process.argv[1])),
    realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url))
  ]);
  if (entryPath === modulePath) {
    main().catch((error) => {
      console.error(`iCloud data artifact validation failed: ${logInline(error?.message ?? error)}`);
      process.exitCode = 1;
    });
  }
}
