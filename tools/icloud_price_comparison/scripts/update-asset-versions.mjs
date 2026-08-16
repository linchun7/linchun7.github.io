import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hash8(contents) {
  return createHash('sha256').update(contents).digest('hex').slice(0, 8);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceVersion(contents, reference, version) {
  const pattern = new RegExp(`${escaped(reference)}\\?v=[a-zA-Z0-9.-]+`, 'g');
  const matches = contents.match(pattern) ?? [];
  if (!matches.length) throw new Error(`Asset reference is missing: ${reference}`);
  return contents.replace(pattern, `${reference}?v=${version}`);
}

async function readProjectFile(projectDir, relativePath) {
  return readFile(path.join(projectDir, relativePath), 'utf8');
}

export async function computeAssetUpdates(projectDir = PROJECT_DIR) {
  const names = [
    'index.html', 'script.js', 'data-contract.js', 'data-model.js',
    'style.css', 'vendor/lucide-subset.js'
  ];
  const originals = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readProjectFile(projectDir, name)])));
  const versions = {
    'data-model.js': hash8(originals['data-model.js']),
    'style.css': hash8(originals['style.css']),
    'vendor/lucide-subset.js': hash8(originals['vendor/lucide-subset.js'])
  };

  let contract = replaceVersion(originals['data-contract.js'], './data-model.js', versions['data-model.js']);
  versions['data-contract.js'] = hash8(contract);

  let script = replaceVersion(originals['script.js'], './data-contract.js', versions['data-contract.js']);
  script = replaceVersion(script, './data-model.js', versions['data-model.js']);
  script = replaceVersion(script, './vendor/lucide-subset.js', versions['vendor/lucide-subset.js']);
  versions['script.js'] = hash8(script);

  let html = originals['index.html'];
  for (const name of ['style.css', 'script.js', 'data-contract.js', 'data-model.js', 'vendor/lucide-subset.js']) {
    html = replaceVersion(html, name, versions[name]);
  }

  return {
    versions,
    updates: new Map([
      ['data-contract.js', contract],
      ['script.js', script],
      ['index.html', html]
    ]),
    originals
  };
}

async function writeTextAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, filePath);
}

export async function updateAssetVersions({ projectDir = PROJECT_DIR, check = false } = {}) {
  const result = await computeAssetUpdates(projectDir);
  const mismatches = [...result.updates]
    .filter(([name, contents]) => result.originals[name] !== contents)
    .map(([name]) => name);
  if (check) {
    if (mismatches.length) throw new Error(`Static asset versions are stale in: ${mismatches.join(', ')}. Run pnpm assets:update.`);
    return result;
  }
  await Promise.all([...result.updates].map(([name, contents]) => (
    result.originals[name] === contents ? null : writeTextAtomic(path.join(projectDir, name), contents)
  )));
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  updateAssetVersions({ check }).then(
    ({ versions }) => console.log(`${check ? 'Verified' : 'Updated'} static asset versions: ${Object.entries(versions).map(([name, version]) => `${name}=${version}`).join(', ')}`),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    }
  );
}
