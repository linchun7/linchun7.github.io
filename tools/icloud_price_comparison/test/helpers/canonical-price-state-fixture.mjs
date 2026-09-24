import { readFile } from 'node:fs/promises';

const pricesUrl = new URL('../../data/prices.json', import.meta.url);

export async function canonicalPriceStateFixture() {
  const payload = await readFile(pricesUrl, 'utf8').then(JSON.parse);
  const generatedAtMs = Date.parse(payload.generatedAt);

  Object.assign(payload.source, {
    parser: 'cross-checked',
    parserStatus: 'Both DOM association paths agreed'
  });

  Object.assign(payload.fx, {
    sourceUrl: 'https://v6.exchangerate-api.com/v6/latest/USD',
    sourceMode: 'api-key',
    fallbackUsed: false,
    fallbackReason: null,
    fetchedAt: new Date(generatedAtMs - 60_000).toISOString(),
    stale: false
  });

  return payload;
}
