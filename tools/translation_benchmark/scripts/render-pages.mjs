import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CORPUS } from './corpus.mjs';

export const LANGUAGES = Object.freeze(['en', 'ja', 'ko', 'fr', 'de', 'es']);
export const BEGIN = '<!-- BEGIN GENERATED CORPUS -->';
export const END = '<!-- END GENERATED CORPUS -->';
const root = new URL('../', import.meta.url);

export function escapeHtml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function validateGroups(groups) {
  if (!Array.isArray(groups) || groups.length !== 16) throw new Error('Expected 16 categories');
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== 2) throw new Error('Invalid category');
    const [title, samples] = group;
    if (typeof title !== 'string' || !title.trim()) throw new Error('Invalid category title');
    if (!Array.isArray(samples) || samples.length !== 3) throw new Error('Expected 3 samples per category');
    if (samples.some(text => typeof text !== 'string' || !text.trim())) throw new Error('Invalid sample text');
  }
}

export function validateCorpus(corpus = CORPUS) {
  if (Object.keys(corpus).sort().join(',') !== [...LANGUAGES].sort().join(',')) {
    throw new Error('Expected exactly six supported languages');
  }
  for (const language of LANGUAGES) validateGroups(corpus[language]);
}

export function renderCorpus(language, groups = CORPUS[language]) {
  if (!LANGUAGES.includes(language)) throw new Error('Unsupported language');
  validateGroups(groups);
  return groups.map(([title, samples], category) => {
    const start = category * 3 + 1;
    const heading = 'category-' + language + '-' + String(category + 1).padStart(2, '0');
    const items = samples.map((text, index) => {
      const number = String(start + index).padStart(2, '0');
      return '        <li class="sample-item"><span class="sample-index" aria-hidden="true">' + number
        + '</span><p class="sample-text">' + escapeHtml(text) + '</p></li>';
    }).join('\n');
    return '      <section class="category-section" aria-labelledby="' + heading + '">\n'
      + '        <header class="category-header"><h2 id="' + heading + '">' + escapeHtml(title)
      + '</h2><span class="category-count">3</span></header>\n'
      + '        <ol class="sample-list" start="' + start + '">\n' + items + '\n        </ol>\n      </section>';
  }).join('\n');
}

export function renderPage(html, language, groups = CORPUS[language]) {
  if (!LANGUAGES.includes(language)) throw new Error('Unsupported language');
  if (!html.includes('<html lang="' + language + '">')
      || !html.includes('<body data-language="' + language + '">')) throw new Error('Page language mismatch');
  if (/<script\b/i.test(html)) throw new Error('Benchmark pages must not require runtime JavaScript');
  if (html.split(BEGIN).length !== 2 || html.split(END).length !== 2) throw new Error('Expected one generated region');
  const start = html.indexOf(BEGIN) + BEGIN.length;
  const end = html.indexOf(END);
  if (end < start) throw new Error('Generated markers are out of order');
  return html.slice(0, start) + '\n' + renderCorpus(language, groups) + '\n      ' + html.slice(end);
}

export async function renderPages({ check = true } = {}) {
  validateCorpus();
  const stale = [];
  for (const language of LANGUAGES) {
    const file = new URL(language + '.html', root);
    const html = await readFile(file, 'utf8');
    const expected = renderPage(html, language);
    if (html !== expected) {
      stale.push(language + '.html');
      if (!check) await writeFile(file, expected);
    }
  }
  if (check && stale.length) throw new Error('Stale generated pages: ' + stale.join(', ') + '. Run node tools/translation_benchmark/scripts/render-pages.mjs --write in GitHub Actions.');
  return stale;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) throw new Error('Use --check or --write');
  const changed = await renderPages({ check: args[0] === '--check' });
  console.log((args[0] === '--check' ? 'Verified' : 'Generated') + ' six language pages; changed=' + changed.length);
}
