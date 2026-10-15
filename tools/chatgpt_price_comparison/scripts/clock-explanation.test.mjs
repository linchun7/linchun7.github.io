import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const prices = JSON.parse(readFileSync(new URL('../data/prices.json', import.meta.url), 'utf8'));
const history = JSON.parse(readFileSync(new URL('../data/minimum-history.json', import.meta.url), 'utf8'));
const constants = source.slice(source.indexOf('  const ORDER ='), source.indexOf('  const $ ='));
const helpers = source.slice(source.indexOf('  const canonical ='), source.indexOf('  const dateTime ='));
function functionSource(name) {
  const first = source.split('\n').find(line => line.startsWith('  function ' + name + '('));
  assert.ok(first, 'exercise shipped function ' + name);
  if (first.endsWith(' }')) return first;
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match);
  return match[0];
}
function execute(names, body, extra = {}) {
  class DeviceDate extends Date { static now() { throw Error('visitor wall clock must not decide availability'); } }
  return runInNewContext(constants + '\n' + helpers + '\n' + names.map(functionSource).join('\n') + '\n' + body,
    { Date: DeviceDate, prices: structuredClone(prices), history: structuredClone(history), ...extra });
}
const validation = ['validateHistorySnapshot', 'validate', 'semantic', 'snapshotOffer', 'historySnapshotIdentity'];
test('accepted snapshot validation never reads the visitor clock', () => {
  assert.doesNotThrow(() => execute(validation, 'validate(prices);'));
  assert.doesNotMatch(source, /Date\.now\s*\(/, 'production frontend has no wall-clock availability gate');
});
test('price, rank, minimum and displayed dates depend on accepted evidence only', () => {
  const names = ['orderedPlans', 'offerFor', 'minCny', 'calculateMinimums', 'calculateRanks', 'rankFor', 'cnyText', 'priceDateLabel', 'renderFreshness'];
  const el = { updatedAt: {}, freshnessWarning: {}, fxStatus: {} };
  const result = execute(names, `
    state.data = prices; state.plans = orderedPlans(); state.sortPlan = state.plans[0];
    calculateMinimums(); calculateRanks(); renderFreshness();
    JSON.stringify({ ranks: prices.markets.map(rankFor), minimums: [...state.minimums],
      cny: prices.markets.map(m => { const o = offerFor(m, state.sortPlan); return o ? cnyText(m, o.amounts[0]) : null; }),
      priceDate: el.updatedAt.textContent, fxDate: el.fxStatus.textContent, warningHidden: el.freshnessWarning.hidden });
  `, { state: {}, el, dateTime: value => value });
  const actual = JSON.parse(result);
  assert.ok(actual.ranks.some(Number.isInteger));
  assert.equal(actual.warningHidden, true);
  assert.ok(actual.priceDate.includes('价格更新于'));
  assert.ok(actual.fxDate.includes(prices.fx.updated_at));
});
test('future or old minimum-history cutoffs are accepted independently of device time', () => {
  const shifted = structuredClone(history);
  const cutoff = Date.parse(shifted.checked_at);
  shifted.checked_at = new Date(cutoff + 3650 * 86400000).toISOString();
  shifted.checkpoint.at = shifted.checked_at;
  assert.doesNotThrow(() => execute(['validateMinimumHistoryTimes'], 'validateMinimumHistoryTimes(history);', { history: shifted }));
  assert.equal(execute(['minimumHistoryTimeUsable'], 'minimumHistoryTimeUsable(history);', { history: shifted }), true);
});
test('invalid formats and impossible package-internal chronology still fail', () => {
  for (const mutate of [
    value => { value.generated_at = 'not-a-date'; },
    value => { value.fx.updated_at = new Date(Date.parse(value.generated_at) + 300001).toISOString(); },
    value => { const market = value.markets.find(m => m.offers.length); market.last_verified_at = new Date(Date.parse(market.last_checked_at) + 1).toISOString(); }
  ]) {
    const value = structuredClone(prices); mutate(value);
    assert.throws(() => execute(validation, 'validate(prices);', { prices: value, Date }), /数据|时间|核验|汇率/);
  }
  const invalid = structuredClone(history);
  invalid.checked_at = 'not-a-date';
  assert.throws(() => execute(['validateMinimumHistoryTimes'], 'validateMinimumHistoryTimes(history);', { history: invalid, Date }), /历史|时间/);
  const inconsistent = structuredClone(history);
  inconsistent.checkpoint.at = new Date(Date.parse(inconsistent.checked_at) + 1).toISOString();
  assert.throws(() => execute(['validateMinimumHistoryTimes'], 'validateMinimumHistoryTimes(history);', { history: inconsistent, Date }), /历史|时间/);
});
