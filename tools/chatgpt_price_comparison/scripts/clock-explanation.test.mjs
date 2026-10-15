import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const now = Date.parse('2026-10-15T00:00:00Z');
const stamp = offset => new Date(now + offset).toISOString();
function functionSource(name) {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, 'exercise shipped function ' + name);
  return match[0];
}
function startupHandlerSource() {
  const match = source.match(/  start\(\)\.catch\(([^]*?)\);\n\}\)\(\);\s*$/);
  assert.ok(match, 'exercise shipped startup rejection handler');
  return /^\w+$/.test(match[1]) ? functionSource(match[1]) + '\n' + match[1] : match[1];
}
function harness(data, current = now) {
  const usable = source.match(/  const usable = \(value\) => \{[^]*?\n  \};/);
  assert.ok(usable);
  class ClockDate extends Date { static now() { return current; } }
  const el = {
    updatedAt: {}, fxStatus: {}, freshnessWarning: {},
    priceRows: { children: [{}] }
  };
  const context = { state: { data }, el, Date: ClockDate, dateTime: value => value, console: { error() {} } };
  runInNewContext(usable[0] + '\n' + functionSource('priceDateLabel') + '\n' + functionSource('renderFreshness') + '\nrenderFreshness();', context);
  return { el, context };
}
function data() {
  return {
    generated_at: stamp(-60000), fx: { updated_at: stamp(-120000) },
    markets: [
      { offers: [{}], last_verified_at: stamp(-60000), status: 'verified' },
      { offers: [{}], last_verified_at: stamp(-86400000), status: 'retained' }
    ]
  };
}
function assertExplained(el) {
  assert.equal(el.freshnessWarning.hidden, false, 'suppressed comparison needs a visible reason');
  assert.match(el.freshnessWarning.textContent, /时间/);
  assert.match(el.freshnessWarning.textContent, /可能.*设备时间/);
  assert.match(el.freshnessWarning.textContent, /检查/);
}
test('explains an all-future clock rollback and clears the explanation after correction', () => {
  const value = data();
  const before = JSON.stringify(value);
  assertExplained(harness(value, now - 600000).el);
  const recovered = harness(value).el;
  assert.equal(recovered.freshnessWarning.hidden, true);
  assert.equal(recovered.freshnessWarning.textContent, '');
  assert.equal(JSON.stringify(value), before, 'explanation must not mutate accepted evidence');
});
test('explains only affected future FX or market comparisons', () => {
  for (const mutate of [
    value => { value.fx.updated_at = stamp(300001); },
    value => { value.markets[1].last_verified_at = stamp(300001); }
  ]) {
    const value = data();
    mutate(value);
    assertExplained(harness(value).el);
  }
});
test('accepted old retained evidence, missing FX and allowed skew do not trigger a clock warning', () => {
  const old = data();
  old.generated_at = stamp(-3650 * 86400000);
  old.fx.updated_at = old.generated_at;
  for (const market of old.markets) market.last_verified_at = old.generated_at;
  const boundary = data();
  boundary.generated_at = stamp(300000);
  boundary.fx.updated_at = stamp(300000);
  boundary.markets[0].last_verified_at = stamp(300000);
  const noFx = data(); noFx.fx = null;
  for (const value of [old, boundary, noFx]) {
    const { el } = harness(value);
    assert.equal(el.freshnessWarning.hidden, true);
    assert.equal(el.freshnessWarning.textContent, '');
  }
});
test('initial future snapshot gets a specific explanation without requiring static rows', () => {
  const value = {
    schema: 1, channel: 'ios-app-store', billing_period: 'not_disclosed',
    purchase_eligibility: 'not_verified', revision: 'a'.repeat(64),
    generated_at: stamp(600000), markets: [{}]
  };
  for (const rows of [0, 1]) {
    class ClockDate extends Date { static now() { return now; } }
    const el = { freshnessWarning: {}, priceRows: { children: Array(rows).fill({}) } };
    const context = { Date: ClockDate, el, console: { error() {} }, value };
    runInNewContext(functionSource('validate') + '\nconst startupHandler = ' + startupHandlerSource() +
      ';\ntry { validate(value); throw Error("future snapshot unexpectedly accepted"); } catch (error) { startupHandler(error); }', context);
    assertExplained(el);
    assert.equal(el.priceRows.children.length, rows, 'startup explanation must preserve existing fallback rows');
  }
});
test('ordinary startup failure retains its original generic explanation', () => {
  const el = { freshnessWarning: {} };
  const context = { el, console: { error() {} } };
  runInNewContext('const startupHandler = ' + startupHandlerSource() + ';\nstartupHandler(Error("fixture network failure"));', context);
  assert.equal(el.freshnessWarning.hidden, false);
  assert.equal(el.freshnessWarning.textContent, '交互功能未能启动，当前仍显示静态价格');
  assert.doesNotMatch(el.freshnessWarning.textContent, /设备时间/);
});
