import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CORPUS } from '../scripts/corpus.mjs';
import { BEGIN, END, LANGUAGES, escapeHtml, renderCorpus, renderPage, renderPages, validateCorpus } from '../scripts/render-pages.mjs';

test('canonical corpus contains six languages, 16 categories and 48 samples each', () => {
  validateCorpus();
  assert.equal(LANGUAGES.length, 6);
  for (const language of LANGUAGES) {
    assert.equal(CORPUS[language].length, 16);
    assert.equal(CORPUS[language].flatMap(([, samples]) => samples).length, 48);
  }
  assert.throws(() => validateCorpus({ ...CORPUS, zh: [] }), /six supported/);
  assert.throws(() => validateCorpus({ ...CORPUS, en: CORPUS.en.slice(1) }), /16 categories/);
  const broken = structuredClone(CORPUS);
  broken.en[0][1].pop();
  assert.throws(() => validateCorpus(broken), /3 samples/);
  broken.en[0][1].push('');
  assert.throws(() => validateCorpus(broken), /Invalid sample/);
});

test('escape preserves Unicode and encodes HTML control characters exactly once', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(escapeHtml('日本語 한국어 Français 1½ 25–30 €'), '日本語 한국어 Français 1½ 25–30 €');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  const groups = structuredClone(CORPUS.en);
  groups[0][0] = '<img src=x onerror="alert(1)">';
  groups[0][1][0] = '</p><script>alert("x")</script>&';
  const html = renderCorpus('en', groups);
  assert.doesNotMatch(html, /<img|<script/);
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'));
  assert.ok(html.includes('&lt;/p&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;'));
  assert.throws(() => renderCorpus('en" onload="x'), /Unsupported/);
});

test('every checked-in page matches generated corpus, with stable semantic hooks and no runtime payload', async () => {
  assert.deepEqual(await renderPages(), []);
  for (const language of LANGUAGES) {
    const html = await readFile(new URL('../' + language + '.html', import.meta.url), 'utf8');
    assert.equal(renderPage(html, language), html);
    assert.equal(renderPage(renderPage(html, language), language), html);
    assert.equal((html.match(/class="category-section"/g) ?? []).length, 16);
    assert.equal((html.match(/class="sample-item"/g) ?? []).length, 48);
    assert.equal((html.match(/class="sample-text"/g) ?? []).length, 48);
    assert.equal((html.match(/aria-labelledby="category-/g) ?? []).length, 16);
    assert.doesNotMatch(html, /<script\b|corpus-load-status|notranslate|translate="no"/i);
    assert.ok(html.includes('id="categoryList" class="category-list" lang="' + language + '"'));
    assert.ok(html.includes('aria-current="page" href="' + language + '.html"'));
    for (const [title, samples] of CORPUS[language]) {
      assert.ok(html.includes(escapeHtml(title)), title);
      for (const sample of samples) assert.ok(html.includes(escapeHtml(sample)), sample);
    }
    for (const foreign of LANGUAGES.filter(value => value !== language)) {
      assert.ok(!html.includes(escapeHtml(CORPUS[foreign][0][1][0])), 'no foreign corpus: ' + foreign);
    }
  }
});

test('generator rejects malformed, missing, duplicate or reversed regions and language mismatches', () => {
  const shell = '<html lang="en"><body data-language="en">' + BEGIN + END + '</body></html>';
  const expected = renderPage(shell, 'en');
  assert.notEqual(expected, shell, 'drift is detectable');
  assert.throws(() => renderPage(shell.replace(BEGIN, ''), 'en'), /one generated region/);
  assert.throws(() => renderPage(shell + BEGIN, 'en'), /one generated region/);
  assert.throws(() => renderPage(shell.replace(BEGIN + END, END + BEGIN), 'en'), /out of order/);
  assert.throws(() => renderPage(shell, 'ja'), /language mismatch/);
  assert.throws(() => renderPage(shell + '<script src="script.js"></script>', 'en'), /runtime JavaScript/);
});
