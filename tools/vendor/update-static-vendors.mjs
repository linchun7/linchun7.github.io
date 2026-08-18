import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

const vendors = [
    {
        name: 'Nzh',
        packageName: 'nzh',
        packagePath: 'package/dist/nzh.min.js',
        targetPath: 'tools/rmb_converter/dist/nzh.min.js',
        versionPattern: /\bnzh v([^\s*]+)/i,
        test: testNzh
    },
    {
        name: 'Pangu.js',
        packageName: 'pangu',
        packagePath: 'package/dist/browser/pangu.min.js',
        targetPath: 'tools/space/dist/browser/pangu.min.js',
        versionPattern: /@version:\s*([^\s*]+)/i,
        test: testPangu
    }
];

function evaluateBrowserBundle(code) {
    const sandbox = { console };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    new vm.Script(code, { filename: 'vendor-candidate.js' }).runInContext(sandbox, { timeout: 3000 });
    return sandbox;
}

function testNzh(code) {
    const sandbox = evaluateBrowserBundle(code);
    assert.equal(typeof sandbox.Nzh?.cn?.toMoney, 'function', 'Nzh.cn.toMoney missing');
    assert.equal(
        sandbox.Nzh.cn.toMoney('123456.78'),
        '人民币壹拾贰万叁仟肆佰伍拾陆元柒角捌分',
        'Nzh money conversion changed unexpectedly'
    );
    assert.equal(sandbox.Nzh.cn.toMoney('0.5'), '人民币伍角', 'Nzh decimal conversion changed unexpectedly');
}

function testPangu(code) {
    const sandbox = evaluateBrowserBundle(code);
    assert.equal(typeof sandbox.pangu?.spacing, 'function', 'pangu.spacing missing');
    assert.equal(sandbox.pangu.spacing('中文ABC123'), '中文 ABC123', 'Pangu CJK/Latin spacing changed unexpectedly');
    assert.equal(
        sandbox.pangu.spacing('中文ABC\n第二行123'),
        '中文 ABC\n第二行 123',
        'Pangu must preserve line breaks while spacing text'
    );
}

async function readPackageMetadata(packageName) {
    const { stdout } = await execFile(
        'npm',
        ['view', `${packageName}@latest`, 'version', 'dist.tarball', '--json'],
        { cwd: repoRoot, encoding: 'utf8', timeout: 30000 }
    );
    const metadata = JSON.parse(stdout);
    const version = metadata.version;
    const tarball = metadata['dist.tarball'];
    assert.equal(typeof version, 'string', `${packageName}: latest version missing`);
    assert.equal(typeof tarball, 'string', `${packageName}: tarball URL missing`);
    const url = new URL(tarball);
    assert.equal(url.protocol, 'https:', `${packageName}: tarball must use HTTPS`);
    assert.equal(url.hostname, 'registry.npmjs.org', `${packageName}: unexpected tarball host`);
    return { version, tarball };
}

async function download(url, destination) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 1024) throw new Error(`Downloaded file is unexpectedly small: ${bytes.length} bytes`);
    await writeFile(destination, bytes);
}

async function loadCandidate(vendor, tempRoot) {
    const target = path.join(repoRoot, vendor.targetPath);
    const currentCode = await readFile(target, 'utf8');
    const currentVersion = vendor.versionPattern.exec(currentCode)?.[1];
    assert.equal(typeof currentVersion, 'string', `${vendor.name}: current version cannot be parsed`);

    const metadata = await readPackageMetadata(vendor.packageName);
    console.log(`${vendor.name}: current=${currentVersion}, latest=${metadata.version}`);
    if (currentVersion === metadata.version) return null;

    const vendorDir = path.join(tempRoot, vendor.packageName);
    const archive = path.join(vendorDir, `${vendor.packageName}.tgz`);
    const extracted = path.join(vendorDir, 'extracted');
    await mkdir(extracted, { recursive: true });
    await download(metadata.tarball, archive);
    await execFile('tar', ['-xzf', archive, '-C', extracted], { timeout: 30000 });

    const candidatePath = path.join(extracted, vendor.packagePath);
    const code = await readFile(candidatePath, 'utf8');
    if (code.length < 1000 || /<html[\s>]/i.test(code)) {
        throw new Error(`${vendor.name}: candidate bundle looks invalid`);
    }

    const candidateVersion = vendor.versionPattern.exec(code)?.[1];
    assert.equal(candidateVersion, metadata.version, `${vendor.name}: bundle version does not match npm metadata`);
    vendor.test(code);
    console.log(`validated ${vendor.name}@${metadata.version}`);
    return { vendor, version: metadata.version, code };
}

async function main() {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'linchun-static-vendors-'));
    try {
        const candidates = [];
        for (const vendor of vendors) {
            const candidate = await loadCandidate(vendor, tempRoot);
            if (candidate) candidates.push(candidate);
        }

        if (candidates.length === 0) {
            console.log('all vendor bundles are already current');
            return;
        }

        for (const candidate of candidates) {
            const target = path.join(repoRoot, candidate.vendor.targetPath);
            await writeFile(target, candidate.code, 'utf8');
            console.log(`updated ${candidate.vendor.targetPath} -> ${candidate.version}`);
        }
        console.log(`updated ${candidates.length} vendor bundle(s)`);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
}

await main();
