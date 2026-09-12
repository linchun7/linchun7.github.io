import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    assertCandidateBundleVersion,
    compareStableSemver,
    parseStableSemver,
    preparePanguCode,
    selectedVendors
} from './update-static-vendors.mjs';

test('requires an explicit vendor so one updater failure cannot couple unrelated vendors', () => {
    assert.throws(() => selectedVendors([]), /--vendor <id>/);
    assert.throws(() => selectedVendors(['--vendor', 'unknown']), /Unknown vendor/);
    assert.equal(selectedVendors(['--vendor', 'nzh'])[0].id, 'nzh');
    assert.equal(selectedVendors(['--vendor', 'pangu'])[0].id, 'pangu');
});

test('keeps Nzh bundle metadata pinned to the npm package version', () => {
    const nzh = {
        name: 'Nzh',
        candidateVersionPatterns: [/\bnzh v([^\s*]+)/i]
    };
    assert.doesNotThrow(() => assertCandidateBundleVersion(nzh, '/*! nzh v1.0.14 */', '1.0.14'));
    assert.throws(
        () => assertCandidateBundleVersion(nzh, '/*! nzh v1.0.13 */', '1.0.14'),
        /bundle version does not match npm metadata/
    );
    assert.throws(
        () => assertCandidateBundleVersion(nzh, '/*! Nzh bundle */', '1.0.14'),
        /candidate bundle version cannot be parsed/
    );
});

test('allows vendors without a reliable bundle version header to rely on package metadata plus browser validation', () => {
    assert.doesNotThrow(() => assertCandidateBundleVersion({ name: 'Pangu.js' }, '/* browser bundle */', '9.1.0'));
});

test('accepts only stable semantic versions and compares them numerically', () => {
    assert.deepEqual(parseStableSemver('9.1.0'), [9, 1, 0]);
    assert.equal(compareStableSemver('9.1.0', '4.0.7') > 0, true);
    assert.equal(compareStableSemver('1.0.14', '1.0.14'), 0);
    assert.equal(compareStableSemver('1.0.13', '1.0.14') < 0, true);
    assert.throws(() => parseStableSemver('9.2.0-beta.1'), /stable X\.Y\.Z/);
    assert.throws(() => parseStableSemver('v9.2.0'), /stable X\.Y\.Z/);
});

test('adapts both Pangu 9 spacingText and Pangu 10 spaceText without executing the candidate in Node', () => {
    const prepared = preparePanguCode('/* upstream browser bundle */', '10.0.0');
    assert.match(prepared, /linchun-vendor: pangu@10\.0\.0/);
    assert.match(prepared, /typeof pangu\.spaceText === 'function'/);
    assert.match(prepared, /pangu\.spaceText : pangu\.spacingText/);
    assert.match(prepared, /pangu\.spacing = spacingText\.bind\(pangu\)/);
});

test('never uses node:vm to execute registry-delivered browser bundles', async () => {
    const source = await readFile(new URL('./update-static-vendors.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from 'node:vm'|new vm\.Script|evaluateBrowserBundle/);
    assert.match(source, /exercised only in the real browser smoke tests/);
});

test('probe current pinyin-pro CDN sha384', async () => {
    const url = 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.29.3/dist/index.js';
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    assert.equal(response.ok, true, `probe failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.length > 1000, `probe bundle too small: ${bytes.length}`);
    const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
    console.log(`PINYIN_SRI=${integrity}`);
});
