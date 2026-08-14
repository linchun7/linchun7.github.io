import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMarket, validateMarketRegistry } from './market-registry.mjs';
import { validateHistoryPayload, validatePriceHistoryConsistency, validatePricePayload } from '../data-contract.js';

const EPSILON = 1e-9;
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function assignRanks(countries, tiers) {
  const result = structuredClone(countries);
  for (const { id: tierId } of tiers) {
    const ordered = [...result].sort((first, second) => (
      first.plans[tierId].cnyPrice - second.plans[tierId].cnyPrice
      || first.marketId.localeCompare(second.marketId, 'en')
    ));
    let rank = 0;
    let previousPrice = null;
    for (const country of ordered) {
      const price = country.plans[tierId].cnyPrice;
      if (previousPrice === null || Math.abs(price - previousPrice) > EPSILON) {
        rank += 1;
        previousPrice = price;
      }
      country.plans[tierId].cnyRank = rank;
    }
  }
  return result;
}

export function migratePricesSchema3To4(prices) {
  if (prices?.schemaVersion === 4) return structuredClone(prices);
  if (prices?.schemaVersion !== 3 || !Array.isArray(prices.countries) || !Array.isArray(prices.tiers)) {
    throw new Error('prices.json must use schema 3 for migration');
  }
  validateMarketRegistry();
  const countries = prices.countries.map((country) => {
    const market = resolveMarket(country.country);
    return {
      marketId: market.id,
      ...structuredClone(country),
      nameZh: country.nameZh || market.zh
    };
  });
  const migrated = { ...structuredClone(prices), schemaVersion: 4, countries: assignRanks(countries, prices.tiers) };
  validatePricePayload(migrated, { minCountries: 1 });
  return migrated;
}

export function migrateHistoryToSchema4(history, prices) {
  if (history?.schemaVersion === 4) return structuredClone(history);
  if (![2, 3].includes(history?.schemaVersion) || history.countries === null || typeof history.countries !== 'object') {
    throw new Error('history.json must use schema 2 or 3 for migration');
  }
  const currentByName = new Map(prices.countries.map((country) => [country.country, country]));
  const markets = {};
  for (const [countryName, record] of Object.entries(history.countries)) {
    const current = currentByName.get(countryName);
    const market = current ?? resolveMarket(countryName);
    if (Object.hasOwn(markets, market.marketId ?? market.id)) {
      throw new Error(`history marketId collision while migrating ${countryName}`);
    }
    markets[market.marketId ?? market.id] = {
      country: countryName,
      ...structuredClone(record)
    };
  }
  const migrated = {
    schemaVersion: 4,
    updatedAt: history.updatedAt,
    markets,
    sourcePublishedDates: structuredClone(history.sourcePublishedDates)
  };
  validateHistoryPayload(migrated);
  return migrated;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function main({
  pricesPath = path.join(PROJECT_DIR, 'data/prices.json'),
  historyPath = path.join(PROJECT_DIR, 'data/history.json')
} = {}) {
  const [prices, history] = await Promise.all([
    readFile(pricesPath, 'utf8').then(JSON.parse),
    readFile(historyPath, 'utf8').then(JSON.parse)
  ]);
  const migratedPrices = migratePricesSchema3To4(prices);
  const migratedHistory = migrateHistoryToSchema4(history, migratedPrices);
  validatePriceHistoryConsistency(migratedPrices, migratedHistory);
  await Promise.all([
    writeJsonAtomic(pricesPath, migratedPrices),
    writeJsonAtomic(historyPath, migratedHistory)
  ]);
  return { prices: migratedPrices, history: migratedHistory };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    ({ prices, history }) => console.log(`Migrated ${prices.countries.length} markets and ${Object.keys(history.markets).length} history records to schema 4.`),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
