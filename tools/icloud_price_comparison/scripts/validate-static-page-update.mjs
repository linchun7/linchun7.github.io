import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertSafeStaticPageUpdate } from './validate-static-page-projection.mjs';

const [baseFile, candidateFile, pricesFile] = process.argv.slice(2);
if (!baseFile || !candidateFile || !pricesFile) {
  throw new Error('usage: validate-static-page-update.mjs BASE_INDEX CANDIDATE_INDEX PRICES_JSON');
}

const historyFile = path.join(path.dirname(path.resolve(pricesFile)), 'history.json');
const [base, candidate, pricesText, historyText] = await Promise.all([
  readFile(baseFile, 'utf8'),
  readFile(candidateFile, 'utf8'),
  readFile(pricesFile, 'utf8'),
  readFile(historyFile, 'utf8')
]);
assertSafeStaticPageUpdate(base, candidate, JSON.parse(pricesText), JSON.parse(historyText));
console.log('Static page update is limited to validated generated regions and exact SEO projections.');
