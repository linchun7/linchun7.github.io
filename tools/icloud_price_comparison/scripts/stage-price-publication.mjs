import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {validateExtractedDataArtifact} from './validate-data-artifact.mjs';
import {assertStaticPageMatches, staticPageShell} from './static-page.mjs';

const DATA = 'tools/icloud_price_comparison/data';
const INDEX = 'tools/icloud_price_comparison/index.html';
async function files(directory, prefix = '') {
  const out = [];
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) out.push(...await files(path.join(directory, entry.name), relative + '/'));
    else if (entry.isFile()) out.push(relative);
    else throw new Error('STAGED_ARTIFACT_UNSAFE_ENTRY');
  }
  return out.sort();
}

export async function stagePricePublication({repoRoot, validatedData, validatedIndex, baseIndex}) {
  await validateExtractedDataArtifact(validatedData);
  const git = (...args) => execFileSync('git', args, {cwd:repoRoot, maxBuffer:64*1024*1024});
  // A repository ignore rule must not omit a validated new snapshot.
  git('add', '--all', '--force', '--', DATA, INDEX);
  const changed = git('diff','--cached','--name-only','-z').toString().split('\0').filter(Boolean);
  if (changed.some(name => name !== INDEX && !name.startsWith(DATA + '/'))) throw new Error('UNEXPECTED_STAGED_PATH');
  const tree = git('write-tree').toString().trim();
  const directory = await mkdtemp(path.join(tmpdir(), 'icloud-staged-'));
  try {
    const stagedData = path.join(directory,DATA), stagedIndex = path.join(directory,INDEX);
    const expectedFiles = await files(validatedData);
    const expectedPaths = [...expectedFiles.map(name => DATA+'/'+name),INDEX].sort();
    const actualPaths = git('ls-tree','-r','--name-only','-z',tree,'--',DATA,INDEX).toString().split('\0').filter(Boolean).sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) throw new Error('STAGED_ARTIFACT_FILE_SET_CHANGED');
    // Read raw Git blobs. Archive/checkout filters must not conceal a transformed committed blob.
    for (const relative of expectedPaths) {
      const expected = await readFile(relative === INDEX ? validatedIndex : path.join(validatedData,relative.slice(DATA.length+1)));
      const actual = git('cat-file','blob',tree+':'+relative);
      if (!expected.equals(actual)) throw new Error('STAGED_ARTIFACT_BYTES_CHANGED: '+relative);
      const destination = path.join(directory,relative);
      await mkdir(path.dirname(destination),{recursive:true});
      await writeFile(destination,actual);
    }
    const [actualIndex,base] = await Promise.all([readFile(stagedIndex),readFile(baseIndex,'utf8')]);
    await validateExtractedDataArtifact(stagedData);
    const prices = JSON.parse(await readFile(path.join(stagedData,'prices.json'),'utf8'));
    const history = JSON.parse(await readFile(path.join(stagedData,'history.json'),'utf8'));
    assertStaticPageMatches(actualIndex.toString('utf8'), prices, history);
    if (staticPageShell(base) !== staticPageShell(actualIndex.toString('utf8'))) throw new Error('STATIC_PAGE_SHELL_CHANGED');
    return {tree, files:expectedFiles.length};
  } finally {await rm(directory,{recursive:true,force:true});}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [validatedData,validatedIndex,baseIndex] = process.argv.slice(2);
  if (!validatedData || !validatedIndex || !baseIndex || process.argv.length !== 5) throw new Error('Usage: stage-price-publication.mjs VALIDATED_DATA VALIDATED_INDEX BASE_INDEX');
  console.log('Staged publication verified:', await stagePricePublication({repoRoot:process.cwd(),validatedData,validatedIndex,baseIndex}));
}
