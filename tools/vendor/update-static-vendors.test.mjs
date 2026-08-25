import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertCandidateBundleVersion,
    evaluateBrowserBundle,
    preparePanguCode,
    selectedVendors,
    testPangu
} from './update-static-vendors.mjs';

const PANGU_V9_STYLE_FIXTURE = `
globalThis.pangu = {
    spacingText(text) {
        return text
            .replaceAll('中文ABC123', '中文 ABC123')
            .replaceAll('中文ABC', '中文 ABC')
            .replaceAll('第二行123', '第二行 123');
    }
};
`;

test('requires an explicit vendor so one updater failure cannot couple unrelated vendors', () => {
    assert.throws(() => selectedVendors([]), /--vendor <id>/);
    assert.throws(() => selectedVendors(['--vendor', 'unknown']), /Unknown vendor/);
    assert.equal(selectedVendors(['--vendor', 'nzh'])[0].id, 'nzh');
    assert.equal(selectedVendors(['--vendor', 'pangu'])[0].id, 'pangu');
});

test('keeps Nzh bundle metadata pinned to the npm package version', () => {
    const nzh = {
        name: 'Nzh',
        candidateVersionPatterns: [/\bnzh v([^\s*]+)/i],
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

test('allows vendors without a reliable bundle version header to use package metadata plus functional validation', () => {
    assert.doesNotThrow(() => assertCandidateBundleVersion({ name: 'Pangu.js' }, PANGU_V9_STYLE_FIXTURE, '9.1.0'));
});

test('adapts the Pangu 9 spacingText API to the existing page spacing API', () => {
    const prepared = preparePanguCode(PANGU_V9_STYLE_FIXTURE, '9.1.0');
    assert.match(prepared, /linchun-vendor: pangu@9\.1\.0/);

    const sandbox = evaluateBrowserBundle(prepared);
    assert.equal(typeof sandbox.pangu.spacingText, 'function');
    assert.equal(typeof sandbox.pangu.spacing, 'function');
    assert.equal(sandbox.pangu.spacing('中文ABC123'), '中文 ABC123');
    assert.equal(sandbox.pangu.spacing('中文ABC\n第二行123'), '中文 ABC\n第二行 123');
});

test('keeps the minimal Pangu core behavior contract across API generations', () => {
    const prepared = preparePanguCode(PANGU_V9_STYLE_FIXTURE, '9.1.0');
    assert.doesNotThrow(() => testPangu(prepared));

    const oldApiFixture = `
        globalThis.pangu = {
            spacing(text) {
                return text
                    .replaceAll('中文ABC123', '中文 ABC123')
                    .replaceAll('中文ABC', '中文 ABC')
                    .replaceAll('第二行123', '第二行 123');
            }
        };
    `;
    assert.doesNotThrow(() => testPangu(oldApiFixture));
});
