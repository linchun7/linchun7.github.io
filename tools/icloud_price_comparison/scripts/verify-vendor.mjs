import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [manifest, packageJson, notices] = await Promise.all([
  readFile(path.join(projectDir, 'vendor/manifest.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectDir, 'package.json'), 'utf8').then(JSON.parse),
  readFile(path.join(projectDir, 'THIRD_PARTY_NOTICES.md'), 'utf8')
]);

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length) {
  throw new Error('Vendor manifest has an unsupported structure');
}

for (const asset of manifest.assets) {
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(asset.file) || path.basename(asset.file) !== asset.file) {
    throw new Error(`Unsafe vendor filename: ${asset.file}`);
  }
  const pinnedVersion = packageJson.devDependencies?.[asset.package];
  if (pinnedVersion !== asset.version) {
    throw new Error(`${asset.package} vendor version ${asset.version} does not match package.json ${pinnedVersion ?? 'missing'}`);
  }
  const bytes = await readFile(path.join(projectDir, 'vendor', asset.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== asset.sha256) throw new Error(`${asset.file} does not match its reviewed SHA-256`);
  if (!notices.includes(`${asset.package === 'chart.js' ? 'Chart.js' : 'Lucide'} ${asset.version}`)) {
    throw new Error(`${asset.package} ${asset.version} is missing from THIRD_PARTY_NOTICES.md`);
  }
}

console.log(`Verified ${manifest.assets.length} vendored assets, pinned versions, hashes, and notices.`);
