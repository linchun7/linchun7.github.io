import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium, firefox, webkit } from 'playwright';

// Temporary, non-gating behavioral comparison. Production files are loaded unchanged.
// Target profiles are independent observations, not an engine ranking or an
// assertion that the current narrow contract is the user's immutable preference.
// Loading errors, exceptions and timeouts invalidate the run rather than count as differences.
const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, 'unsupported browser');
const fixtures = [];
const add = (id, group, input, currentExpected, typographyExpected) => fixtures.push({ id, group, input, currentExpected, typographyExpected });
add('empty', 'ordinary', '', '');
add('han-ascii', 'ordinary', '中A文B字1汉2', '中 A 文 B 字 1 汉 2');
add('ascii-runs', 'ordinary', 'A中B文12号3C', 'A 中 B 文 12 号 3C');
add('supplementary-han', 'ordinary', '𠀀A中B', '𠀀 A 中 B');
add('already-spaced', 'ordinary', '中文 ABC 与 123 数字', '中文 ABC 与 123 数字');
add('bracket-boundaries', 'ordinary', '中文(A)与[B]再{C}', '中文 (A) 与 [B] 再 {C}');
add('punctuation-must-survive', 'preservation', '王·小明', '王·小明');
add('existing-bracket-spaces', 'preservation', '中文( A )与[ B ]再{ C }', '中文 ( A ) 与 [ B ] 再 { C }');
add('existing-quote-spaces', 'preservation', '中文" A ":B,中文!数字1', '中文" A ":B,中文!数字 1');
add('existing-whitespace', 'preservation', '中文  ABC\t第二行 123', '中文  ABC\t第二行 123');
add('whitespace-only', 'preservation', ' \t \r\n\r ', ' \t \r\n\r ');
add('mixed-line-endings', 'preservation', '中文ABC\r\n\r\n第二行123\r段落Z\n结束', '中文 ABC\r\n\r\n第二行 123\r段落 Z\n结束');
add('emoji-content', 'preservation', '中文😀ABC👩‍💻数字123🧑🏽‍🚀完成', '中文😀ABC👩‍💻数字 123🧑🏽‍🚀完成');
add('plain-url', 'urls', '访问https://example.com/中文ABC?q=测试123，继续ABC', '访问 https://example.com/中文ABC?q=测试123，继续 ABC');
add('uppercase-url', 'urls', '访问HTTPS://example.com/中文ABC，继续ABC', '访问 HTTPS://example.com/中文ABC，继续 ABC');
add('mixedcase-url', 'urls', '前文ABC HtTpS://example.com/目录ABC?key=中文123，后文XYZ', '前文 ABC HtTpS://example.com/目录ABC?key=中文123，后文 XYZ');
add('fullwidth-url-letter', 'urls', 'https://example.com/Ａ中文ABC', 'https://example.com/Ａ中文ABC');
add('fullwidth-url-number', 'urls', 'https://example.com/１２中文ABC', 'https://example.com/１２中文ABC');
add('halfwidth-katakana-url', 'urls', 'https://example.com/ｶﾀｶﾅ中文ABC', 'https://example.com/ｶﾀｶﾅ中文ABC');
add('url-currency', 'urls', 'https://example.com/￥中文ABC！正文DEF', 'https://example.com/￥中文ABC！正文 DEF');
add('url-ideographic-zero', 'urls', 'https://example.com/〇中文ABC', 'https://example.com/〇中文ABC');
add('explicit-url-punctuation', 'urls', '<https://example.com/目录，中文ABC>', '<https://example.com/目录，中文ABC>');
add('nested-fullwidth-url', 'urls', 'https://example.com/目录（中文ABC（测试DEF，甲GHI））', 'https://example.com/目录（中文ABC（测试DEF，甲GHI））');
add('unclosed-fullwidth-url', 'urls', 'https://example.com/目录（中文ABC，正文DEF。继续XYZ', 'https://example.com/目录（中文 ABC，正文 DEF。继续 XYZ');
add('fullwidth-url-hard-boundary', 'urls', 'https://example.com/目录（中文ABC\n正文DEF）继续XYZ', 'https://example.com/目录（中文 ABC\n正文 DEF）继续 XYZ');
add('outer-round-url', 'url-boundaries', '(https://example.com/中文ABC)后文DEF', '(https://example.com/中文ABC) 后文 DEF');
add('outer-square-url', 'url-boundaries', '[https://example.com/中文ABC]后文DEF', '[https://example.com/中文ABC] 后文 DEF');
add('outer-curly-url', 'url-boundaries', '{https://example.com/中文ABC}后文DEF', '{https://example.com/中文ABC} 后文 DEF');
add('markdown-target-url', 'url-boundaries', '中文[链接](https://example.com/中文ABC)后文DEF', '中文 [链接](https://example.com/中文ABC) 后文 DEF');
add('internal-round-url', 'url-boundaries', 'https://example.com/a(b(c)d)e?x=(中文ABC)', 'https://example.com/a(b(c)d)e?x=(中文ABC)');
add('internal-square-query', 'url-boundaries', 'https://example.com/?q=[中文ABC]&x=1，后文DEF', 'https://example.com/?q=[中文ABC]&x=1，后文 DEF');
add('internal-curly-query', 'url-boundaries', 'https://example.com/?q={中文ABC}&x=1，后文DEF', 'https://example.com/?q={中文ABC}&x=1，后文 DEF');
add('ipv6-authority', 'url-boundaries', '访问https://[2001:db8::1]/中文ABC，后文DEF', '访问 https://[2001:db8::1]/中文ABC，后文 DEF');
add('outer-square-ipv6', 'url-boundaries', '[https://[2001:db8::1]/中文ABC]后文DEF', '[https://[2001:db8::1]/中文ABC] 后文 DEF');
add('outer-curly-ipv6', 'url-boundaries', '{https://[2001:db8::1]/中文ABC}后文DEF', '{https://[2001:db8::1]/中文ABC} 后文 DEF');
add('crossing-parentheses', 'url-boundaries', '(https://example.com/a（(中文ABC）)d中文XYZ)后文DEF', '(https://example.com/a（(中文ABC）)d中文XYZ) 后文 DEF');
add('inline-code', 'code', '中文\x60ABC中文123\x60继续ABC', '中文\x60ABC中文123\x60继续 ABC');
add('double-backtick', 'code', '中文\x60\x60变量\x60ABC中文123\x60尾Z\x60\x60继续ABC', '中文\x60\x60变量\x60ABC中文123\x60尾Z\x60\x60继续 ABC');
add('unmatched-inline', 'code', '中文\x60\x60变量ABC', '中文\x60\x60变量 ABC');
add('complete-fence', 'code', '前文ABC\n\x60\x60\x60js\nconst label = \x60变量ABC\x60;\n变量ABC\n\x60\x60\x60\n后文XYZ', '前文 ABC\n\x60\x60\x60js\nconst label = \x60变量ABC\x60;\n变量ABC\n\x60\x60\x60\n后文 XYZ');
add('fence-crlf', 'code', '前文ABC\r\n\x60\x60\x60js\r\n变量ABC\r\n\x60\x60\x60\r\n后文123', '前文 ABC\r\n\x60\x60\x60js\r\n变量ABC\r\n\x60\x60\x60\r\n后文 123');
add('fence-tail-not-closer', 'code', '\x60\x60\x60js\n变量ABC\n\x60\x60\x60tail\n继续123\n\x60\x60\x60', '\x60\x60\x60js\n变量ABC\n\x60\x60\x60tail\n继续123\n\x60\x60\x60');
add('unmatched-longer-before-fence', 'code', '\x60\x60\x60\x60js\n前文ABC\n\x60\x60\x60js\n变量ABC\n\x60\x60\x60\n后文123', '\x60\x60\x60\x60js\n前文 ABC\n\x60\x60\x60js\n变量ABC\n\x60\x60\x60\n后文 123');
const nestedFullwidth = 'https://example.com/' + '（'.repeat(20000) + '中文ABC，测试DEF' + '）'.repeat(20000);
add('long-nested-fullwidth', 'bounded-stress', nestedFullwidth, nestedFullwidth);
add('long-repeated-outer-round', 'bounded-stress', '(https://example.com/a(b)c)后文DEF\n'.repeat(3000), '(https://example.com/a(b)c) 后文 DEF\n'.repeat(3000));
add('long-repeated-outer-square', 'bounded-stress', '[https://example.com/中文ABC]后文DEF\n'.repeat(3000), '[https://example.com/中文ABC] 后文 DEF\n'.repeat(3000));
const unmatchedFences = '\x60\x60\x60js\n'.repeat(30000);
add('long-unmatched-fences', 'bounded-stress', unmatchedFences + '中文ABC', unmatchedFences + '中文 ABC');
const runs = Array.from({ length: 600 }, (_, i) => '\x60'.repeat(i + 1));
add('long-unmatched-runs', 'bounded-stress', runs.map(run => 'x' + run + '变量ABC').join('\n'), runs.map(run => 'x' + run + '变量 ABC').join('\n'));
add('long-line-endings', 'bounded-stress', '中文ABC\r\n第二行123\r尾Z\n'.repeat(3000), '中文 ABC\r\n第二行 123\r尾 Z\n'.repeat(3000));

// These are optional, conventional typography goals, not demands that the
// current narrow engine implement every script or symbol. The two profiles
// are reported independently; neither profile is the user's immutable preference.
add('greek-letter-typography', 'optional-typography', '中文β漢字', '中文β漢字', '中文 β 漢字');
add('latin-1-typography', 'optional-typography', '中文Ø漢字', '中文Ø漢字', '中文 Ø 漢字');
add('unit-symbol-typography', 'optional-typography', '摄氏25℃到30℃之间', '摄氏 25℃到 30℃之间', '摄氏 25℃ 到 30℃ 之间');
add('operator-typography', 'optional-typography', '中文+ABC', '中文+ABC', '中文 + ABC');
add('kana-typography', 'optional-typography', 'abcあ123', 'abcあ123', 'abc あ 123');
for (const id of ['han-ascii', 'ascii-runs', 'already-spaced', 'plain-url']) {
  const fixture = fixtures.find(row => row.id === id);
  fixture.typographyExpected = fixture.currentExpected;
}
fixtures.find(row => row.id === 'punctuation-must-survive').typographyExpected = '王・小明';
fixtures.find(row => row.id === 'existing-bracket-spaces').typographyExpected = '中文 (A) 与 [B] 再 {C}';

const sha256 = value => createHash('sha256').update(value).digest('hex');
function describe(value) {
  return value.length <= 1000 ? value : {
    utf16Units: value.length, sha256: sha256(value), start: value.slice(0, 100), end: value.slice(-100)
  };
}
function firstDifference(expected, actual) {
  let at = 0;
  while (at < expected.length && at < actual.length && expected[at] === actual[at]) at++;
  return at === expected.length && at === actual.length ? null : {
    utf16Offset: at, expectedContext: expected.slice(Math.max(0, at - 30), at + 70),
    actualContext: actual.slice(Math.max(0, at - 30), at + 70)
  };
}
function insertionOnly(input, output) {
  let i = 0;
  for (const character of output) {
    if (input.codePointAt(i) === character.codePointAt(0)) i += character.length;
    else if (character !== ' ') return false;
  }
  return i === input.length;
}
async function deadline(operation, label, milliseconds = 15000) {
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timeout')), milliseconds); })
    ]);
  } finally { clearTimeout(timer); }
}

const engines = [
  { id: 'content-preserving', path: 'tools/space/spacing.js', functionName: 'spaceTextPreservingContent' },
  { id: 'pangu-10.4.1', path: 'tools/space/dist/browser/pangu.min.js', functionName: 'pangu' }
];
// Run conventional inputs before stress, and restart a dedicated browser server
// after a blocked renderer. No timeout is converted into a matching output.
fixtures.sort((a, b) => Number(a.group === 'bounded-stress') - Number(b.group === 'bounded-stress'));
const totals = [];
let invalid = false;
let server;
let browser;
let page;
let errors;
const watchdog = setTimeout(() => {
  console.error('SPACE_ENGINE_DIAGNOSTIC ' + JSON.stringify({ status: 'invalid', reason: '180s global deadline' }));
  process.exit(2);
}, 180000);
async function stopEngine(force = false) {
  const active = server;
  server = undefined;
  page = undefined;
  browser = undefined;
  if (active) await deadline(() => force ? active.kill() : active.close(), 'browser server cleanup', 10000);
}
async function startEngine(engine) {
  server = await deadline(() => browserType.launchServer({ headless: true }), 'browser server launch', 30000);
  browser = await deadline(() => browserType.connect(server.wsEndpoint()), 'browser connect');
  const context = await deadline(() => browser.newContext(), 'context');
  page = await deadline(() => context.newPage(), 'page');
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await deadline(() => page.addScriptTag({ path: engine.path }), engine.id + ' load');
  if (engine.id === 'pangu-10.4.1') {
    assert.equal(await page.evaluate(() => window.pangu?.version), '10.4.1', 'comparison version must be pinned');
  }
}
async function evaluate(engine, input, label) {
  return deadline(() => page.evaluate(({ engine, input }) => {
    if (engine === 'pangu-10.4.1') return window.pangu.spacing(input);
    return window.spaceTextPreservingContent(input);
  }, { engine: engine.id, input }), label);
}
try {
  for (const engine of engines) {
    const source = await readFile(engine.path, 'utf8');
    const rows = [];
    try {
      for (const fixture of fixtures) {
        if (!page) await startEngine(engine);
        const base = {
          browser: browserName, engine: engine.id, fixture: fixture.id, group: fixture.group,
          input: describe(fixture.input), currentContractExpected: describe(fixture.currentExpected),
          optionalTypographyExpected: fixture.typographyExpected === undefined ? null : describe(fixture.typographyExpected)
        };
        let phase = 'initial-output';
        try {
          const previousErrorCount = errors.length;
          const actual = await evaluate(engine, fixture.input, engine.id + '/' + fixture.id);
          assert.equal(typeof actual, 'string', 'engine must return string');
          phase = 'idempotence';
          const repeated = await evaluate(engine, actual, engine.id + '/' + fixture.id + '/repeat');
          assert.equal(errors.length, previousErrorCount, 'unexpected browser error invalidates fixture');
          const row = {
            ...base, status: 'output', matchesCurrentContract: actual === fixture.currentExpected,
            matchesOptionalTypography: fixture.typographyExpected === undefined ? null : actual === fixture.typographyExpected,
            insertionOnly: insertionOnly(fixture.input, actual), idempotent: repeated === actual,
            actual: describe(actual), firstDifference: firstDifference(fixture.currentExpected, actual)
          };
          rows.push(row);
          console.log('SPACE_ENGINE_DIAGNOSTIC ' + JSON.stringify(row));
        } catch (error) {
          invalid = true;
          const row = { ...base, status: error.message.endsWith(' timeout') ? 'timeout' : 'invalid', phase, reason: error.message };
          rows.push(row);
          console.error('SPACE_ENGINE_DIAGNOSTIC ' + JSON.stringify(row));
          // BrowserServer.kill terminates the blocked browser process independently
          // of page evaluation; later fixtures get a fresh isolated browser.
          await stopEngine(true);
        }
      }
    } finally {
      await stopEngine();
    }
    const outputs = rows.filter(row => row.status === 'output');
    const total = {
      browser: browserName, engine: engine.id, sourceSha256: sha256(source),
      attemptedCases: rows.length, availableOutputs: outputs.length,
      timeouts: rows.filter(row => row.status === 'timeout').map(row => ({ fixture: row.fixture, phase: row.phase })),
      invalidFixtures: rows.filter(row => row.status === 'invalid').map(row => ({ fixture: row.fixture, reason: row.reason })),
      currentContractMatches: outputs.filter(row => row.matchesCurrentContract).length,
      currentContractDifferences: outputs.filter(row => !row.matchesCurrentContract).map(row => row.fixture),
      optionalTypographyCases: outputs.filter(row => row.matchesOptionalTypography !== null).length,
      optionalTypographyMatches: outputs.filter(row => row.matchesOptionalTypography === true).length,
      optionalTypographyDifferences: outputs.filter(row => row.matchesOptionalTypography === false).map(row => row.fixture),
      notInsertionOnly: outputs.filter(row => !row.insertionOnly).map(row => row.fixture),
      notIdempotent: outputs.filter(row => !row.idempotent).map(row => row.fixture),
      groups: Object.fromEntries([...new Set(fixtures.map(row => row.group))].map(group => {
        const selected = outputs.filter(row => row.group === group);
        return [group, { availableOutputs: selected.length, currentContractMatches: selected.filter(row => row.matchesCurrentContract).length }];
      }))
    };
    assert.equal(total.attemptedCases, fixtures.length, 'every fixture must be attempted');
    totals.push(total);
    console.log('SPACE_ENGINE_SUMMARY ' + JSON.stringify(total));
  }
  assert.equal(totals.length, engines.length, 'both engines must be attempted');
  console.log('SPACE_ENGINE_COMPARISON_COMPLETED ' + JSON.stringify({
    browser: browserName, casesPerEngine: fixtures.length, status: invalid ? 'completed-with-invalid-or-timeout-fixtures' : 'diagnostic-completed',
    meaning: 'Target-profile matches are independent observations, not a quality ranking. Timeout/invalid fixtures have no matching output and are reported separately.'
  }));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['\n## Space engine diagnostic (' + browserName + ')',
      'Diagnostic completion is not quality acceptance. Both unchanged engines receive identical inputs and separately labelled target profiles.',
      'Current insertion-only behavior is not presumed to be the user\'s immutable preference; intentional Pangu normalization is not automatically a bug.',
      'Bounded stress cases are regressions, not a comparative speed benchmark. Timeout/invalid fixtures are excluded from output-match denominators and invalidate full acceptance.', ''];
    for (const total of totals) {
      lines.push('- ' + total.engine + ': attempted ' + total.attemptedCases + '; available outputs ' + total.availableOutputs +
        '; current-contract matches ' + total.currentContractMatches + '/' + total.availableOutputs +
        '; optional-typography matches ' + total.optionalTypographyMatches + '/' + total.optionalTypographyCases +
        '; insertion-only violations ' + total.notInsertionOnly.length + '; idempotence violations ' + total.notIdempotent.length + '.');
      lines.push('  Current-contract differences: ' + (total.currentContractDifferences.join(', ') || 'none'));
      lines.push('  Optional-typography differences: ' + (total.optionalTypographyDifferences.join(', ') || 'none'));
      lines.push('  Timeout/invalid fixtures: ' + JSON.stringify([...total.timeouts, ...total.invalidFixtures]));
    }
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
  }
  if (invalid) process.exitCode = 2;
} catch (error) {
  invalid = true;
  console.error('SPACE_ENGINE_DIAGNOSTIC ' + JSON.stringify({ browser: browserName, status: 'invalid', reason: error.message }));
  process.exitCode = 2;
} finally {
  try { await stopEngine(true); }
  catch (error) { invalid = true; console.error('SPACE_ENGINE_DIAGNOSTIC cleanup invalid: ' + error.message); process.exitCode = 2; }
  clearTimeout(watchdog);
  if (invalid) console.error('Timeout or infrastructure-invalid observations remain; do not describe this evaluation as all passed.');
}
