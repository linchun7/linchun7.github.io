import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFile = promisify(execFileCallback);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');

const vendors = [
    {
        id: 'nzh',
        name: 'Nzh',
        packageName: 'nzh',
        packagePaths: ['package/dist/nzh.min.js'],
        targetPath: 'tools/rmb_converter/dist/nzh.min.js',
        currentVersionPatterns: [/\bnzh v([^\s*]+)/i],
        candidateVersionPatterns: [/\bnzh v([^\s*]+)/i],
        test: testNzh
    },
    {
        id: 'pangu',
        name: 'Pangu.js',
        packageName: 'pangu',
        packagePaths: [
            'package/dist/browser/pangu.umd.js',
            'package/dist/browser/pangu.min.js'
        ],
        targetPath: 'tools/space/dist/browser/pangu.min.js',
        currentVersionPatterns: [
            /linchun-vendor:\s*pangu@([^\s*]+)/i,
            /@version:\s*([^\s*]+)/i
        ],
        prepareCode: preparePanguCode,
        test: testPangu
    }
];

export function evaluateBrowserBundle(code) {
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

export function preparePanguCode(code, version) {
    return `/*! linchun-vendor: pangu@${version} */\n${code}\n;(() => {\n    const pangu = globalThis.pangu;\n    if (pangu && typeof pangu.spacing !== 'function' && typeof pangu.spacingText === 'function') {\n        pangu.spacing = pangu.spacingText.bind(pangu);\n    }\n})();\n`;
}

function getPanguSpacingFunction(pangu) {
    if (typeof pangu?.spacingText === 'function') return pangu.spacingText.bind(pangu);
    if (typeof pangu?.spacing === 'function') return pangu.spacing.bind(pangu);
    return null;
}

export function testPangu(code) {
    const sandbox = evaluateBrowserBundle(code);
    const spacing = getPanguSpacingFunction(sandbox.pangu);
    assert.equal(typeof spacing, 'function', 'Pangu spacing API missing');
    assert.equal(spacing('中文ABC123'), '中文 ABC123', 'Pangu CJK/Latin spacing changed unexpectedly');
    assert.equal(
        spacing('中文ABC\n第二行123'),
        '中文 ABC\n第二行 123',
        'Pangu must preserve line breaks while spacing text'
    );
    assert.equal(spacing('中文 ABC123'), '中文 ABC123', 'Pangu spacing must remain idempotent for already-spaced text');
}

function parseVersionFromPatterns(patterns, code) {
    for (const pattern of patterns ?? []) {
        const version = pattern.exec(code)?.[1];
        if (version) return version;
    }
    return null;
}

function parseCurrentVersion(vendor, code) {
    return parseVersionFromPatterns(vendor.currentVersionPatterns, code);
}

export function assertCandidateBundleVersion(vendor, code, expectedVersion) {
    if (!vendor.candidateVersionPatterns?.length) return;
    const candidateVersion = parseVersionFromPatterns(vendor.candidateVersionPatterns, code);
    assert.equal(typeof candidateVersion, 'string', `${vendor.name}: candidate bundle version cannot be parsed`);
    assert.equal(candidateVersion, expectedVersion, `${vendor.name}: bundle version does not match npm metadata`);
}

export function selectedVendors(argv = process.argv.slice(2)) {
    assert.equal(argv.length, 2, 'Usage: node update-static-vendors.mjs --vendor <id>');
    assert.equal(argv[0], '--vendor', 'Usage: node update-static-vendors.mjs --vendor <id>');
    const vendor = vendors.find(({ id }) => id === argv[1]);
    assert.ok(vendor, `Unknown vendor: ${argv[1]}`);
    return [vendor];
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

async function readFirstExistingFile(root, candidates, vendorName) {
    for (const relativePath of candidates) {
        try {
            return {
                code: await readFile(path.join(root, relativePath), 'utf8'),
                relativePath
            };
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    throw new Error(`${vendorName}: no supported browser bundle found (${candidates.join(', ')})`);
}

async function loadCandidate(vendor, tempRoot) {
    const target = path.join(repoRoot, vendor.targetPath);
    const currentCode = await readFile(target, 'utf8');
    const currentVersion = parseCurrentVersion(vendor, currentCode);
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

    const packageJson = JSON.parse(await readFile(path.join(extracted, 'package/package.json'), 'utf8'));
    assert.equal(packageJson.version, metadata.version, `${vendor.name}: package version does not match npm metadata`);

    const { code: rawCode, relativePath } = await readFirstExistingFile(extracted, vendor.packagePaths, vendor.name);
    if (rawCode.length < 1000 || /<html[\s>]/i.test(rawCode)) {
        throw new Error(`${vendor.name}: candidate bundle looks invalid`);
    }
    assertCandidateBundleVersion(vendor, rawCode, metadata.version);

    const code = vendor.prepareCode ? vendor.prepareCode(rawCode, metadata.version) : rawCode;
    vendor.test(code);
    console.log(`validated ${vendor.name}@${metadata.version} from ${relativePath}`);
    return { vendor, version: metadata.version, code };
}

export async function main(argv = process.argv.slice(2)) {
    const targets = selectedVendors(argv);
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'linchun-static-vendors-'));
    try {
        const candidates = [];
        for (const vendor of targets) {
            const candidate = await loadCandidate(vendor, tempRoot);
            if (candidate) candidates.push(candidate);
        }

        if (candidates.length === 0) {
            console.log(`${targets.map(({ name }) => name).join(', ')} already current`);
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

const isDirectRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
    await main();
}
