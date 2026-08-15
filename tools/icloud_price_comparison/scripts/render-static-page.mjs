import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertStaticPageMatches, renderStaticFragments, replaceStaticFragments } from './static-page.mjs';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function renderStaticPage({
  write = false,
  indexPath = path.join(projectDirectory, 'index.html'),
  pricesPath = path.join(projectDirectory, 'data/prices.json')
} = {}) {
  const [html, payloadText] = await Promise.all([readFile(indexPath, 'utf8'), readFile(pricesPath, 'utf8')]);
  const payload = JSON.parse(payloadText);
  if (!write) {
    assertStaticPageMatches(html, payload);
    return { changed: false, bytes: Buffer.byteLength(html), countries: payload.countries.length, tiers: payload.tiers.length };
  }
  const rendered = replaceStaticFragments(html, renderStaticFragments(payload));
  if (rendered !== html) await writeFile(indexPath, rendered, 'utf8');
  assertStaticPageMatches(rendered, payload);
  return { changed: rendered !== html, bytes: Buffer.byteLength(rendered), countries: payload.countries.length, tiers: payload.tiers.length };
}

const args = process.argv.slice(2);
const mode = args[0];
if (!['--write', '--check'].includes(mode)) throw new Error('Usage: node scripts/render-static-page.mjs (--write | --check)');
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const result = await renderStaticPage({
  write: mode === '--write',
  indexPath: valueFor('--index-file') ?? path.join(projectDirectory, 'index.html'),
  pricesPath: valueFor('--prices-file') ?? path.join(projectDirectory, 'data/prices.json')
});
console.log(`Static iCloud page ${mode === '--write' ? 'rendered' : 'verified'}: ${JSON.stringify(result)}`);
