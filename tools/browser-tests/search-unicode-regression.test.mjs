import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../scripts.js', import.meta.url), 'utf8');
const elements = {
    toolList: { innerHTML: '', getElementsByTagName: () => [] },
    searchInput: { addEventListener() {} },
    noResults: { style: {} }
};
const context = vm.createContext({
    document: { getElementById: id => elements[id] },
    console,
    setTimeout,
    clearTimeout
});
vm.runInContext(source, context, { timeout: 1000 });
const normalizeQuery = vm.runInContext('normalizeQuery', context);

test('keeps the existing NFKC, trim and UTF-16 length budgets', () => {
    assert.equal(normalizeQuery('  ＡＢＣ１２３  '), 'ABC123');
    assert.equal(normalizeQuery('a'.repeat(160) + 'tail'), 'a'.repeat(160));
    assert.equal(normalizeQuery('a'.repeat(158) + '😀'), 'a'.repeat(158) + '😀');
    assert.equal(normalizeQuery('汉'.repeat(1_000_000)), '汉'.repeat(160));
});

test('does not split a pair after NFKC expansion of an input within maxlength', () => {
    // Only 55 UTF-16 code units before normalization, below the native maxlength=160.
    const input = 'ﬃ'.repeat(53) + '😀';
    assert.ok(input.length <= 160);
    assert.equal(normalizeQuery(input), 'ffi'.repeat(53));
});

test('does not split a pair at the final UTF-16 boundary', () => {
    assert.equal(normalizeQuery('a'.repeat(159) + '😀'), 'a'.repeat(159));
});

test('does not split a pair at the bounded raw prefix before NFKC contraction', () => {
    // 106 Hangul syllables each use three Jamo units before NFKC.
    const jamo = '\u1100\u1161\u11a8'.repeat(106);
    assert.equal(jamo.length, 318);
    assert.equal(normalizeQuery(jamo + 'x😀'), '각'.repeat(106) + 'x');
    assert.equal(normalizeQuery(jamo + '😀'), '각'.repeat(106) + '😀');
});
