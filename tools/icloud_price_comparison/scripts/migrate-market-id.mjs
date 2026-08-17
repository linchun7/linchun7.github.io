import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePayload, validatePriceHistoryConsistency } from '../data-contract.js';
import { resolveMarket, validateMarketIdentityContinuity } from './market-registry.mjs';
import { renderStaticPage } from './render-static-page.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function validateMarketId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,95}$/.test(value)) {
    throw new Error(`${label} is not a valid marketId: ${value}`);
  }
  return value;
}

export function migrateMarketIdentityPayloads(prices, history, {
  from,
  to,
  resolve = resolveMarket
}) {
  const sourceId = validateMarketId(from, 'Source marketId');
  const targetId = validateMarketId(to, 'Target marketId');
  if (sourceId === targetId) throw new Error('Source and target marketId are identical');
  if (!sourceId.startsWith('apple-')) {
    throw new Error('Only deterministic apple-* fallback identities may be migrated with this tool');
  }
  if (prices?.schemaVersion !== 4 || history?.schemaVersion !== 4 || !history.markets) {
    throw new Error('Market ID migration requires schema 4 prices/history payloads');
  }

  const currentMatches = prices.countries.filter(({ marketId }) => marketId === sourceId);
  if (currentMatches.length > 1) throw new Error(`Source marketId appears multiple times in prices.json: ${sourceId}`);
  if (prices.countries.some(({ marketId }) => marketId === targetId)) {
    throw new Error(`Target marketId is already active in prices.json: ${targetId}`);
  }
  const sourceHistory = history.markets[sourceId];
  if (!sourceHistory) throw new Error(`Source marketId is missing from history.json: ${sourceId}`);
  if (history.markets[targetId]) throw new Error(`Target marketId already exists in history.json: ${targetId}`);

  const sourceName = currentMatches[0]?.country ?? sourceHistory.country;
  if (!sourceName || sourceHistory.country !== sourceName) {
    throw new Error(`Source market identity is inconsistent across prices/history: ${sourceId}`);
  }
  const reviewedTarget = resolve(sourceName);
  if (reviewedTarget.unknown || reviewedTarget.id !== targetId) {
    throw new Error(
      `Target marketId must first be reviewed into the active/reserved registry for ${sourceName}: expected ${reviewedTarget.id}`
    );
  }

  const nextPrices = structuredClone(prices);
  const nextHistory = structuredClone(history);
  for (const country of nextPrices.countries) {
    if (country.marketId === sourceId) country.marketId = targetId;
  }
  const nextMarkets = {};
  for (const [marketId, record] of Object.entries(nextHistory.markets)) {
    nextMarkets[marketId === sourceId ? targetId : marketId] = record;
  }
  nextHistory.markets = nextMarkets;

  validatePayload('prices.json', nextPrices);
  validatePayload('history.json', nextHistory);
  validatePriceHistoryConsistency(nextPrices, nextHistory);
  validateMarketIdentityContinuity(nextPrices, nextHistory);

  return {
    prices: nextPrices,
    history: nextHistory,
    sourceName,
    from: sourceId,
    to: targetId,
    active: currentMatches.length === 1
  };
}

async function atomicWrite(filePath, text) {
  const tempPath = `${filePath}.tmp-market-id-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, text, 'utf8');
  await rename(tempPath, filePath);
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function migrateMarketIdFiles({
  from,
  to,
  write = false,
  pricesPath = path.join(projectDirectory, 'data/prices.json'),
  historyPath = path.join(projectDirectory, 'data/history.json'),
  indexPath = path.join(projectDirectory, 'index.html')
}) {
  const [pricesText, historyText, indexText] = await Promise.all([
    readFile(pricesPath, 'utf8'),
    readFile(historyPath, 'utf8'),
    readFile(indexPath, 'utf8')
  ]);
  const migration = migrateMarketIdentityPayloads(
    JSON.parse(pricesText),
    JSON.parse(historyText),
    { from, to }
  );
  if (!write) return { ...migration, prices: undefined, history: undefined, changed: false };

  try {
    await atomicWrite(pricesPath, `${JSON.stringify(migration.prices, null, 2)}\n`);
    await atomicWrite(historyPath, `${JSON.stringify(migration.history, null, 2)}\n`);
    await renderStaticPage({ write: true, indexPath, pricesPath });
    return { ...migration, prices: undefined, history: undefined, changed: true };
  } catch (error) {
    await Promise.all([
      atomicWrite(pricesPath, pricesText),
      atomicWrite(historyPath, historyText),
      atomicWrite(indexPath, indexText)
    ]).catch(() => {});
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = argumentValue(args, '--from');
  const to = argumentValue(args, '--to');
  if (!from || !to) {
    throw new Error('Usage: node scripts/migrate-market-id.mjs --from <apple-...> --to <reviewed-id> [--write]');
  }
  const result = await migrateMarketIdFiles({ from, to, write: args.includes('--write') });
  console.log(`${result.changed ? 'Migrated' : 'Validated migration'} ${result.from} -> ${result.to} (${result.sourceName})`);
}
