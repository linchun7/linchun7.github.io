import { readFile } from 'node:fs/promises';
import { assertStaticPageMatches, staticPageShell } from './static-page.mjs';

const [baseFile, candidateFile, pricesFile] = process.argv.slice(2);
if (!baseFile || !candidateFile || !pricesFile) {
  throw new Error('usage: validate-static-page-update.mjs BASE_INDEX CANDIDATE_INDEX PRICES_JSON');
}

const [base, candidate, pricesText] = await Promise.all([
  readFile(baseFile, 'utf8'),
  readFile(candidateFile, 'utf8'),
  readFile(pricesFile, 'utf8')
]);
assertStaticPageMatches(candidate, JSON.parse(pricesText));
if (staticPageShell(base) !== staticPageShell(candidate)) {
  throw new Error('STATIC_PAGE_SHELL_CHANGED');
}
console.log('Static page update is limited to validated generated regions.');
