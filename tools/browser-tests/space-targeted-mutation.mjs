import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, firefox, webkit } from 'playwright';

// Run from repository root; place this script under tools/browser-tests so
// its Playwright import resolves against the existing installed dependency.
// No application source is changed, imported into Node, or served publicly.
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
const sourcePath = resolve('tools/space/spacing.js');
const cases = [
  ['fullwidth-url-letter', 'https://example.com/Ａ中文ABC', 'https://example.com/Ａ中文ABC'],
  ['cjk-url-number', 'https://example.com/〇中文ABC', 'https://example.com/〇中文ABC'],
  ['han-ascii', '𠀀A中B', '𠀀 A 中 B'],
  ['case-fold-control', '中文K数字ſ结束', '中文K数字ſ结束'],
  ['uppercase-url', '访问HTTPS://example.com/中文ABC，继续ABC', '访问 HTTPS://example.com/中文ABC，继续 ABC'],
  ['nested-url', 'https://example.com/目录（中文ABC（测试DEF，甲GHI））', 'https://example.com/目录（中文ABC（测试DEF，甲GHI））'],
  ['line-boundary', 'https://example.com/目录（中文ABC\n正文DEF）继续XYZ', 'https://example.com/目录（中文 ABC\n正文 DEF）继续 XYZ'],
  ['inline-code', '中文``变量`ABC中文123`尾Z``继续ABC', '中文``变量`ABC中文123`尾Z``继续 ABC'],
  ['fence-tail', '```js\n变量ABC\n```tail\n继续123\n```', '```js\n变量ABC\n```tail\n继续123\n```'],
  ['explicit-url', '<https://example.com/目录，中文ABC>', '<https://example.com/目录，中文ABC>'],
  ['line-endings', '中文ABC\r\n第二行123\r段落Z', '中文 ABC\r\n第二行 123\r段落 Z']
];
const mutants = [
  { id: 'unicode-block-mistaken-for-punctuation', witness: 'fullwidth-url-letter',
    from: String.raw`const bareUrlBoundary = /(?:[\u2018\u2019\u201c\u201d\u2026]|(?=[\u3000-\u303f\uff00-\uffef])\p{P})/u;`,
    to: String.raw`const bareUrlBoundary = /[\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026]/u;`
  },
  {
    id: 'scheme-becomes-case-sensitive', witness: 'uppercase-url',
    from: String.raw`const urlStart = /<?[hH][tT][tT][pP][sS]?:\/\//g;`,
    to: String.raw`const urlStart = /<?https?:\/\//g;`
  },
  {
    id: 'paired-url-treated-as-unclosed', witness: 'nested-url',
    from: 'const closing = pairs.get(end);',
    to: 'const closing = undefined;'
  },
  {
    id: 'parenthesis-pairs-cross-hard-boundary', witness: 'line-boundary',
    from: 'if (hardUrlBoundary.test(character)) openings.length = 0;',
    to: 'if (false) openings.length = 0;'
  },
  {
    id: 'disable-whole-backtick-run-pairing', witness: 'inline-code',
    from: 'nextSameLength[i] = nextByLength.get(length);',
    to: 'nextSameLength[i] = undefined;'
  },
  {
    id: 'allow-text-after-closing-fence', witness: 'fence-tail',
    from: String.raw`if (line[1].length < opening[1].length || !/^[ \t]*$/.test(line[2])) continue;`,
    to: 'if (line[1].length < opening[1].length) continue;'
  }
];

let temp;
let browser;
let watchdog;
const report = [];
const emit = row => { report.push(row); console.log(JSON.stringify(row)); };
async function deadline(operation, label, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}
async function probe(file) {
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 10000 });
  if (checked.error || checked.status !== 0) throw new Error('syntax infrastructure: ' + (checked.error?.message || checked.stderr));
  const context = await deadline(() => browser.newContext(), 'context');
  const errors = [];
  try {
    const page = await deadline(() => context.newPage(), 'page');
    page.on('pageerror', error => errors.push(error.message));
    await deadline(() => page.addScriptTag({ path: file }), 'script load');
    const differences = [];
    for (const [id, input, expected] of cases) {
      const actual = await deadline(() => page.evaluate(value => window.spaceTextPreservingContent(value), input), id);
      // Loading, exceptions, absent helper, non-string results and timeouts
      // never count as a mutation kill. Only an exact-output assertion does.
      if (typeof actual !== 'string') throw new Error(id + ': helper did not return a string');
      try { assert.equal(actual, expected); }
      catch (error) {
        if (!(error instanceof assert.AssertionError)) throw error;
        differences.push({ id, input, expected, actual });
      }
    }
    if (errors.length) throw new Error('unhandled browser errors: ' + errors.join('; '));
    return differences;
  } finally { await deadline(() => context.close(), 'context cleanup'); }
}

try {
  if (!browserType) throw new Error('unsupported browser: ' + browserName);
  // A stuck browser cannot turn the Actions run into an unbounded wait.
  // It is infrastructure-invalid, never killed.
  watchdog = setTimeout(() => {
    console.error(JSON.stringify({ id: 'harness', status: 'invalid', reason: '180s global deadline' }));
    process.exit(2);
  }, 180000);
  temp = await mkdtemp(join(tmpdir(), 'space-mutation-'));
  const original = await readFile(sourcePath, 'utf8');
  const baseline = join(temp, 'baseline.js');
  await writeFile(baseline, original);
  browser = await deadline(() => browserType.launch({ headless: true }), 'browser launch', 30000);
  const baselineDifferences = await probe(baseline);
  if (baselineDifferences.length) {
    emit({ id: 'baseline', status: 'failed', differences: baselineDifferences });
    throw new Error('baseline behavior failed; no mutation results are valid');
  }
  emit({ id: 'baseline', status: 'passed', assertions: cases.length, browser: browserName });
  for (const mutant of mutants) {
    try {
      const occurrences = original.split(mutant.from).length - 1;
      if (occurrences !== 1) throw new Error('exact replacement occurrence count: ' + occurrences);
      const file = join(temp, mutant.id + '.js');
      await writeFile(file, original.replace(mutant.from, mutant.to));
      const differences = await probe(file);
      const witness = differences.find(item => item.id === mutant.witness);
      // Unrelated output failures are insufficient: require the named witness.
      emit({ id: mutant.id, status: witness ? 'killed' : 'survived', witness: witness || null, otherDifferences: differences.filter(item => item.id !== mutant.witness) });
    } catch (error) { emit({ id: mutant.id, status: 'invalid', reason: error.message }); }
  }
  if (report.some(row => row.status === 'invalid')) process.exitCode = 2;
  else if (report.some(row => row.status === 'survived')) process.exitCode = 1;
} catch (error) {
  emit({ id: 'harness', status: 'invalid', reason: error.message });
  process.exitCode = 2;
} finally {
  try { if (browser) await deadline(() => browser.close(), 'browser cleanup'); }
  catch (error) { emit({ id: 'cleanup', status: 'invalid', reason: error.message }); process.exitCode = 2; }
  if (temp) await rm(temp, { recursive: true, force: true });
  clearTimeout(watchdog);
}
