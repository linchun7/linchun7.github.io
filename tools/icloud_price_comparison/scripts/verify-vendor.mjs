import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [manifest, packageJson, notices, indexHtml, scriptSource, vendorEntries, lucide] = await Promise.all([
  readFile(path.join(projectDir, 'vendor/manifest.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectDir, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectDir, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
  readFile(path.join(projectDir, 'index.html'), 'utf8'),
  readFile(path.join(projectDir, 'script.js'), 'utf8'),
  readdir(path.join(projectDir, 'vendor'), { withFileTypes: true }),
  import('lucide')
]);

if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.assets) || !manifest.assets.length) {
  throw new Error('Vendor manifest has an unsupported structure');
}

const manifestFiles = new Set();
const manifestPackages = new Set();
const pinnedVersions = new Map();
for (const [packageName, version] of Object.entries({
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
})) {
  pinnedVersions.set(packageName, version);
}

for (const asset of manifest.assets) {
  if (Object.keys(asset).sort().join(',') !== 'file,license,package,sha256'
    || !/^[a-z0-9][a-z0-9.-]*$/i.test(asset.file)
    || path.basename(asset.file) !== asset.file
    || !/^[a-f0-9]{64}$/.test(asset.sha256)
    || manifestFiles.has(asset.file)
    || manifestPackages.has(asset.package)) {
    throw new Error(`Unsafe vendor filename: ${asset.file}`);
  }
  manifestFiles.add(asset.file);
  manifestPackages.add(asset.package);

  const pinnedVersion = pinnedVersions.get(asset.package);
  if (!pinnedVersion) {
    throw new Error(`${asset.package} vendor asset is not pinned in package.json`);
  }

  const installedPackage = JSON.parse(await readFile(
    path.join(projectDir, 'node_modules', ...asset.package.split('/'), 'package.json'),
    'utf8'
  ));
  if (installedPackage.version !== pinnedVersion) {
    throw new Error(`${asset.package} installed version ${installedPackage.version ?? 'missing'} does not match package.json ${pinnedVersion}`);
  }
  if (installedPackage.license !== asset.license) {
    throw new Error(`${asset.package} installed license ${installedPackage.license ?? 'missing'} does not match reviewed license ${asset.license}`);
  }

  const bytes = await readFile(path.join(projectDir, 'vendor', asset.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256) throw new Error(`${asset.file} does not match its reviewed SHA-256`);
}

if (!notices.includes('## Lucide\n') && !notices.includes('## Lucide\r\n')) {
  throw new Error('Lucide notice is missing from THIRD_PARTY_NOTICES.md');
}

const vendoredScripts = vendorEntries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
  .map((entry) => entry.name)
  .sort();
if (JSON.stringify(vendoredScripts) !== JSON.stringify([...manifestFiles].sort())) {
  throw new Error('Vendor manifest and served JavaScript files do not exactly match');
}

const lucideAsset = manifest.assets.find(({ package: packageName }) => packageName === 'lucide');
if (!lucideAsset) throw new Error('Lucide vendor asset is missing');
const lucideVersion = pinnedVersions.get('lucide');
const lucideSource = await readFile(path.join(projectDir, 'vendor', lucideAsset.file), 'utf8');
const lucideObjectMatch = lucideSource.match(/const ICONS = (\{[\s\S]*?\n\});\n\nfunction setAttributes/);
if (!lucideObjectMatch) throw new Error('Unable to parse the reviewed Lucide subset');
const lucideSubset = JSON.parse(lucideObjectMatch[1]);
const usedLucideIcons = new Set([...indexHtml.matchAll(/data-lucide="([a-z0-9-]+)"/g)].map((match) => match[1]));
for (const assignment of scriptSource.matchAll(/\.dataset\.lucide\s*=([^;\n]+);/g)) {
  for (const literal of assignment[1].matchAll(/['"]([a-z0-9-]+)['"]/g)) {
    if (Object.hasOwn(lucideSubset, literal[1])) usedLucideIcons.add(literal[1]);
  }
}
if (JSON.stringify(Object.keys(lucideSubset).sort()) !== JSON.stringify([...usedLucideIcons].sort())) {
  throw new Error('Lucide subset does not exactly match static and dynamic icon usage');
}
for (const [iconName, iconNode] of Object.entries(lucideSubset)) {
  const exportName = iconName.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
  if (!isDeepStrictEqual(iconNode, lucide[exportName])) {
    throw new Error(`Lucide icon ${iconName} does not match package.json-pinned lucide ${lucideVersion}`);
  }
}

console.log(`Verified ${manifest.assets.length} vendored assets, installed package metadata, package pins, upstream icon nodes, hashes, usage, and notices (Lucide ${lucideVersion}).`);
