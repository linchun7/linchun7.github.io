import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { minimumChangeCause, validateMinimumHistoryPayload, validatePricePayload } from '../data-contract.js';
import { publicPayloadFingerprint } from './static-page.mjs';
import { createPublishedMarketResolver, resolveMarket } from './market-registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRICE_PATH = 'tools/icloud_price_comparison/data/prices.json';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ids = (rows) => rows.map((row) => row.id).join('|');
const byId = (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const validRate = (x) => Number.isFinite(x) && x > 0;

// Keep only a fingerprint of the actually used conversion factors, not raw rates.
export function comparisonFxFingerprint(fx, countries) {
  if (fx?.stale || !countries?.length || !validRate(fx?.rates?.CNY)) return null;
  const currencies = [...new Set(countries.map((c) => c.currency))].sort();
  if (currencies.some((code) => !validRate(fx.rates[code]))) return null;
  return hash(currencies.map((code) => [code, code === 'CNY' ? 1 : fx.rates.CNY / fx.rates[code]]));
}

export function buildMinimumSnapshot(data, { sourceCommit = null, resolve = resolveMarket } = {}) {
  const fingerprint = publicPayloadFingerprint(data);
  // Older releases saved a whole provider table. Validate only the currencies
  // actually used by that historical snapshot; never use present-day quotes.
  if (data.schemaVersion < 3 && data.fx?.rates && Array.isArray(data.countries)) {
    data = structuredClone(data);
    data.fx.rates = Object.fromEntries([...new Set(['USD', 'CNY', ...data.countries.map((c) => c.currency)])].sort().map((code) => [code, data.fx.rates[code]]));
  }
  validatePricePayload(data);
  const fxAge = Date.parse(data.generatedAt) - Date.parse(data.fx.fetchedAt);
  if (data.fx.stale || fxAge < -300000 || fxAge > 36 * 3600000 + 300000) return null;
  const legacy = data.schemaVersion < 3;
  const rounded = data.schemaVersion === 3;
  const fx = data.fx.comparisonFingerprint ?? comparisonFxFingerprint(data.fx, data.countries);
  return {
    at: data.generatedAt, fingerprint, sourceCommit,
    basis: legacy ? 'saved-fx' : rounded ? 'saved-cny' : 'stored-ranks',
    tiers: data.tiers.map((tier) => {
      const rows = data.countries.map((c) => {
        const p = c.plans[tier.id];
        const full = legacy ? p.price * data.fx.rates.CNY / data.fx.rates[c.currency] : null;
        return {
          id: c.marketId ?? resolve(c.country).id, name: c.nameZh || c.country,
          currency: c.currency, local: p.price, cny: legacy ? Math.round(full * 100) / 100 : p.cnyPrice,
          rank: legacy ? null : p.cnyRank, full
        };
      }).sort(byId);
      if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('Ambiguous historical market identity');
      const minimum = legacy ? Math.min(...rows.map((r) => r.full)) : null;
      const roundedMinimum = rounded ? Math.min(...rows.map((r) => r.cny)) : null;
      const roundedWinners = rounded ? rows.filter((r) => r.cny === roundedMinimum) : [];
      if (rounded && (roundedWinners.some((r) => r.currency !== roundedWinners[0].currency || r.local !== roundedWinners[0].local)
        || rows.some((r) => r.cny > roundedMinimum && r.cny - roundedMinimum <= 0.010000001))) {
        throw new Error('Historical rounded prices cannot resolve the winner');
      }
      const winners = rows.filter((r) => legacy ? Math.abs(r.full - minimum) <= 1e-9 : rounded ? r.cny === roundedMinimum : r.rank === 1)
        .map(({ rank, full, ...r }) => r);
      if (!winners.length || winners.some((r) => !validRate(r.cny))) throw new Error('No reliable minimum');
      return {
        id: tier.id, label: tier.label,
        scope: hash(rows.map((r) => [r.id, r.currency])),
        prices: hash(rows.map((r) => [r.id, r.currency, r.local])),
        fx, winners
      };
    })
  };
}

export function emptyMinimumHistory(projectSince = '2024-12-08') {
  return {
    schemaVersion: 1, projectSince, firstObservedAt: null, checkedAt: null,
    observations: 0, excludedVersions: 0, pendingGap: false, gaps: [], events: [], checkpoint: null
  };
}

export function advanceMinimumHistory(previous, data, options = {}) {
  const result = structuredClone(previous ?? emptyMinimumHistory());
  validateMinimumHistoryPayload(result);
  const current = buildMinimumSnapshot(data, options);
  if (result.checkedAt && Date.parse(data.generatedAt) < Date.parse(result.checkedAt)) throw new Error('Minimum history cannot roll back');
  if (!current) {
    if (result.checkedAt !== data.generatedAt) result.excludedVersions += 1;
    result.checkedAt = data.generatedAt;
    result.pendingGap = true;
    return validateMinimumHistoryPayload(result);
  }
  const last = result.checkpoint;
  if (last?.at === current.at) {
    // A projection/schema-only rewrite is not a new price observation.
    const comparable = (s) => s.tiers.map(({ id, scope, prices, winners }) => ({ id, scope, prices, winners: winners.map(({ name, ...row }) => row) }));
    if (JSON.stringify(comparable(last)) !== JSON.stringify(comparable(current))) throw new Error('Conflicting minimum snapshots at the same timestamp');
    result.checkpoint = current;
    result.checkedAt = current.at;
    return validateMinimumHistoryPayload(result);
  }
  if (last && result.pendingGap) result.gaps.push({ from: last.at, to: current.at });
  const before = new Map((last?.tiers ?? []).map((t) => [t.id, t]));
  const after = new Map(current.tiers.map((t) => [t.id, t]));
  const seen = new Set(result.events.map((e) => e.tier));
  for (const tier of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const a = before.get(tier), b = after.get(tier);
    const from = a?.winners ?? [], to = b?.winners ?? [];
    if (ids(from) === ids(to)) continue;
    const initial = !seen.has(tier);
    const evidence = {
      pricesChanged: Boolean(a && b && a.prices !== b.prices),
      scopeChanged: !a || !b || a.scope !== b.scope,
      fxChanged: a?.fx && b?.fx ? a.fx !== b.fx : null,
      gap: result.pendingGap,
      basisChanged: Boolean(last && last.basis !== current.basis)
    };
    result.events.push({
      tier, at: current.at, previousAt: initial ? null : last.at,
      kind: initial ? 'initial' : 'change', cause: initial ? 'initial' : minimumChangeCause(evidence),
      from: structuredClone(from), to: structuredClone(to), evidence, sourceCommit: current.sourceCommit, basis: current.basis
    });
  }
  result.firstObservedAt ??= current.at;
  result.checkedAt = current.at;
  result.checkpoint = current;
  result.observations += 1;
  result.pendingGap = false;
  return validateMinimumHistoryPayload(result);
}

export function assertMinimumHistoryMatches(history, data) {
  validateMinimumHistoryPayload(history);
  if (history.checkedAt !== data.generatedAt) throw new Error('Minimum history does not match the current price snapshot');
  const snapshot = buildMinimumSnapshot(data);
  if (!snapshot) {
    if (!history.pendingGap) throw new Error('Unreliable FX must not create minimum events');
  } else if (history.pendingGap || history.checkpoint?.fingerprint !== snapshot.fingerprint
    || JSON.stringify(history.checkpoint.tiers) !== JSON.stringify(snapshot.tiers)) {
    throw new Error('Minimum history checkpoint does not match current prices');
  }
  return true;
}

export async function writeMinimumHistory(file, value) {
  validateMinimumHistoryPayload(value);
  const text = JSON.stringify(value, null, 2) + '\n';
  const old = await readFile(file, 'utf8').catch((e) => { if (e.code !== 'ENOENT') throw e; return null; });
  if (text === old) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } finally {
    await unlink(tmp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  return true;
}

export async function updateMinimumHistory(data, file, { check = false } = {}) {
  const oldText = await readFile(file, 'utf8'); // Missing/corrupt ledger must never silently reset history.
  const old = JSON.parse(oldText);
  if (check) return assertMinimumHistoryMatches(old, data);
  const next = advanceMinimumHistory(old, data);
  assertMinimumHistoryMatches(next, data);
  return writeMinimumHistory(file, next);
}

export async function backfillMinimumHistory({ ref = 'HEAD', projectDir = ROOT } = {}) {
  if (!/^[A-Za-z0-9_./-]+$/.test(ref) || ref.startsWith('-')) throw new Error('Invalid Git ref');
  const repo = path.resolve(projectDir, '../..');
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (git(['rev-parse', '--is-shallow-repository']).trim() !== 'false') throw new Error('Backfill requires full Git history, not a shallow checkout');
  const current = JSON.parse(await readFile(path.join(projectDir, 'data/prices.json'), 'utf8'));
  const appleHistory = JSON.parse(await readFile(path.join(projectDir, 'data/history.json'), 'utf8'));
  const resolve = createPublishedMarketResolver(current, appleHistory);
  const shas = git(['log', '--first-parent', '--reverse', '--format=%H', ref, '--', PRICE_PATH]).trim().split('\n').filter(Boolean);
  const groups = new Map();
  let excluded = 0;
  for (const sha of shas) {
    let data;
    try { data = JSON.parse(git(['show', `${sha}:${PRICE_PATH}`])); }
    catch { excluded += 1; continue; }
    if (!Number.isFinite(Date.parse(data.generatedAt)) || Date.parse(data.generatedAt) > Date.parse(current.generatedAt)) { excluded += 1; continue; }
    const group = groups.get(data.generatedAt) ?? [];
    group.push({ data, sha }); groups.set(data.generatedAt, group);
  }
  let ledger = emptyMinimumHistory();
  for (const [at, group] of [...groups].sort(([a], [b]) => Date.parse(a) - Date.parse(b))) {
    const valid = [];
    for (const record of group) {
      try {
        const snapshot = buildMinimumSnapshot(record.data, { sourceCommit: record.sha, resolve });
        if (snapshot) valid.push({ ...record, snapshot }); else excluded += 1;
      } catch { excluded += 1; }
    }
    const signature = (s) => JSON.stringify(s.tiers.map(({ id, scope, prices, winners }) => ({ id, scope, prices, winners: winners.map(({ name, ...row }) => row) })));
    if (!valid.length || new Set(valid.map((r) => signature(r.snapshot))).size > 1) {
      ledger.pendingGap = true;
      if (valid.length) excluded += valid.length;
      continue;
    }
    // Prefer the richest retained evidence among equivalent projections.
    valid.sort((a, b) => Number(Boolean(a.snapshot.tiers[0].fx)) - Number(Boolean(b.snapshot.tiers[0].fx)));
    const selected = valid.at(-1);
    try { ledger = advanceMinimumHistory(ledger, selected.data, { sourceCommit: selected.sha, resolve }); }
    catch (error) { throw new Error(`Backfill failed at ${at}: ${error.message}`); }
  }
  ledger.excludedVersions = excluded;
  ledger = advanceMinimumHistory(ledger, current, { resolve });
  assertMinimumHistoryMatches(ledger, current);
  return { ledger, versions: shas.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
  const file = at('--output', path.join(ROOT, 'data/minimum-history.json'));
  if (!args.includes('--backfill')) throw new Error('Usage: node scripts/minimum-history.mjs --backfill [--ref SHA] [--output FILE]');
  const { ledger, versions } = await backfillMinimumHistory({ ref: at('--ref', 'HEAD') });
  await writeMinimumHistory(file, ledger);
  console.log(JSON.stringify({ versions, observations: ledger.observations, excludedVersions: ledger.excludedVersions,
    firstObservedAt: ledger.firstObservedAt, checkedAt: ledger.checkedAt,
    events: ledger.events.length, changes: ledger.events.filter((e) => e.kind === 'change').length,
    causes: Object.fromEntries(Object.keys((await import('../data-contract.js')).MINIMUM_CAUSE_LABELS).map((cause) => [cause, ledger.events.filter((e) => e.cause === cause).length])) }, null, 2));
}
