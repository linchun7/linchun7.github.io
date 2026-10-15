import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute shipped functions, not browser-oracle.mjs or a second implementation.
const source = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/price-contracts.json', import.meta.url), 'utf8'));
const constants = source.slice(source.indexOf('  const ORDER ='), source.indexOf('  const STATUS ='));
const helpers = source.slice(source.indexOf('  const canonical ='), source.indexOf('  const dateTime ='));
assert.ok(constants.includes('PLAN_ALIASES'));
assert.ok(helpers.includes('const comparePlans ='));
const names = ['orderedPlans', 'offerFor', 'displayAmounts', 'minCny', 'calculateMinimums', 'calculateRanks', 'rankFor'];
const functions = names.map(name => {
  const match = source.match(new RegExp('  function ' + name + '\\([^]*?\\n  \\}'));
  assert.ok(match, 'Missing shipped function: ' + name);
  return match[0];
}).join('\n');
const now = Date.parse(fixture.generated_at);
class SnapshotDate extends Date { static now() { return now; } }
const projectionCode = [
  '(data => {',
  'state.data = data;',
  'state.plans = orderedPlans();',
  'calculateMinimums();',
  'return state.plans.map(label => {',
  'state.sortPlan = label;',
  'calculateRanks();',
  'const result = state.minimums.get(label);',
  'return {',
  'label,',
  'local: data.markets.map(market => {',
  'const offer = offerFor(market, label);',
  'return offer ? displayAmounts(offer)[0]?.amount ?? null : null;',
  '}),',
  'cny: data.markets.map(market => {',
  'const value = minCny(market, label);',
  'return Number.isFinite(value) ? value.toFixed(2) : null;',
  '}),',
  'ranks: data.markets.map(rankFor),',
  'minimum: Number.isFinite(result.value) ? result.value.toFixed(2) : null,',
  'winners: result.markets.map(market => market.code),',
  '};',
  '});',
  '})',
].join('\n');
const project = runInNewContext(constants + '\n' + helpers + '\n' + functions + '\n' + projectionCode,
  { state: {}, Date: SnapshotDate });
const results = fixture.cases.map(example => {
  const data = { generated_at: fixture.generated_at, revision: fixture.revision, fx: example.fx, markets: example.markets };
  const before = JSON.stringify(data);
  const actual = JSON.parse(JSON.stringify(project(data)));
  assert.deepEqual(actual, example.expected, example.name);
  assert.equal(JSON.stringify(data), before, 'projection must not mutate accepted evidence');
  return { name: example.name, projection: actual };
});
process.stdout.write(JSON.stringify(results));
