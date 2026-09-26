import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { minimumChangeCause, validateMinimumHistoryPayload, validatePricePayload } from '../data-contract.js';
import { attachDerivedCnyPrices, publicExchangeRateMetadata } from '../scripts/update-prices.mjs';
import { advanceMinimumHistory, assertMinimumHistoryMatches, buildMinimumSnapshot, comparisonFxFingerprint,
  emptyMinimumHistory, updateMinimumHistory, writeMinimumHistory } from '../scripts/minimum-history.mjs';
const production = JSON.parse(await readFile(new URL('../data/prices.json', import.meta.url), 'utf8'));
const existing = JSON.parse(await readFile(new URL('../data/minimum-history.json', import.meta.url), 'utf8'));
const T = Date.parse(production.generatedAt);
function fixture({ day = 0, values = [100,100,100], rates = [10,5,2.5], fingerprint = true } = {}) {
  const d = structuredClone(production);
  d.tiers = d.tiers.filter((t) => t.id === '6TB');
  d.countries = ['mx','ca','tw'].map((id, i) => {
    const c = structuredClone(production.countries.find((c) => c.marketId === id));
    c.plans = { '6TB': { price: values[i], formattedPrice: String(values[i]) } };
    return c;
  });
  const at = new Date(T + day * 86400000).toISOString();
  d.generatedAt = at;
  Object.assign(d.run, { startedAtUtc: at, finishedAtUtc: at, observedAtUtc: at,
    observedAtBeijing: new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)),
    countries: d.countries.length, pricePoints: d.countries.length });
  const fx = { ...d.fx, fetchedAt: at, stale: false, rates: { USD:1,CNY:1,MXN:rates[0],CAD:rates[1],TWD:rates[2] } };
  d.countries = attachDerivedCnyPrices(d.countries, {fx});
  d.fx = publicExchangeRateMetadata(fx, d.countries);
  if (!fingerprint) delete d.fx.comparisonFingerprint;
  validatePricePayload(d);
  return d;
}
const first = (d = fixture()) => advanceMinimumHistory(emptyMinimumHistory(), d);
const changed = (before, after) => advanceMinimumHistory(first(before), after).events.at(-1);

test('minimum history is separate, current-data-bound and deterministic', async () => {
  assert.equal(assertMinimumHistoryMatches(existing, production), true);
  assert.deepEqual(advanceMinimumHistory(existing, production), existing);
  const tmp = await mkdtemp(path.join(tmpdir(), 'minimum-history-'));
  try {
    const file = path.join(tmp, 'minimum-history.json');
    assert.equal(await writeMinimumHistory(file, existing), true);
    assert.equal(await updateMinimumHistory(production, file), false);
    await updateMinimumHistory(production, file, {check:true});
    await writeFile(file, '{}');
    await assert.rejects(updateMinimumHistory(production,file), /invalid comparison history/);
    await assert.rejects(updateMinimumHistory(production,path.join(tmp,'missing.json')), /ENOENT/);
  } finally { await rm(tmp, {recursive:true,force:true}); }
});

test('classifies FX, Apple-only, mixed and unknown without pretending to prove sole causality', () => {
  const a = fixture();
  assert.equal(changed(a,fixture({day:1,rates:[2,5,2.5]})).cause,'fx');
  assert.equal(changed(a,fixture({day:1,values:[1000,100,100]})).cause,'apple');
  assert.equal(changed(a,fixture({day:1,values:[1000,100,100],rates:[11,6,2.5]})).cause,'mixed');
  assert.equal(changed(fixture({fingerprint:false}),fixture({day:1,fingerprint:false,values:[1000,100,100]})).cause,'unknown');
  assert.equal(changed(fixture({fingerprint:false}),fixture({day:1,fingerprint:false,rates:[2,5,2.5]})).cause,'fx');
  assert.equal(minimumChangeCause({pricesChanged:false,scopeChanged:false,fxChanged:false,gap:false,basisChanged:false}),'unknown');
});

test('only winner-set changes create events; preserve same-price ties and name-independent identity', () => {
  const a = fixture();
  const same = fixture({day:1,rates:[11,6,3]});
  const initial = first(a);
  const h = advanceMinimumHistory(initial,same);
  assert.equal(h.events.length,1); assert.equal(h.observations,2);
  assert.deepEqual(h.events,initial.events);
  const tied = fixture({day:2,rates:[5,5,2.5]});
  const tie = advanceMinimumHistory(h,tied);
  assert.deepEqual(tie.events.at(-1).to.map((r)=>r.id),['ca','mx']);
  const renamed = fixture({day:3,rates:[5,5,2.5]});
  renamed.countries.reverse(); renamed.countries.find(c=>c.marketId==='ca').nameZh = '加拿大（显示名）';
  const still = advanceMinimumHistory(tie,renamed);
  assert.equal(still.events.length,tie.events.length);
  const exit = advanceMinimumHistory(still,fixture({day:4,rates:[2,5,2.5]}));
  assert.deepEqual(exit.events.at(-1).from.map(r=>r.id),['ca','mx']);
  assert.deepEqual(exit.events.at(-1).to.map(r=>r.id),['ca']);
});

test('scope and capacity changes are not mislabelled Apple repricing', () => {
  const a = fixture(); const b = fixture({day:1});
  b.countries = b.countries.filter(c=>c.marketId!=='mx');
  b.countries[0].plans['6TB'].cnyRank=1; b.countries[1].plans['6TB'].cnyRank=2;
  b.run.countries=2; b.run.pricePoints=2;
  assert.equal(changed(a,b).cause,'scope');
  const c = fixture({day:2});
  c.tiers = [{id:'12TB',label:'12 TB',capacityGb:12288}];
  c.countries.forEach(c=> {c.plans['12TB']=c.plans['6TB'];delete c.plans['6TB'];});
  const h = advanceMinimumHistory(first(a),c);
  assert.equal(h.events.find(e=>e.kind==='change').cause,'scope');
  assert.deepEqual(h.events.find(e=>e.kind==='change').to,[]);
});

test('stale observations are gaps rather than synthetic winner changes, and recovery is conservative', () => {
  const initial = first(); const stale = fixture({day:1,rates:[2,5,2.5]});
  stale.fx.stale = true; delete stale.fx.comparisonFingerprint;
  // Existing data contract requires fallback metadata for stale derived values.
  stale.fx.fallbackUsed=true; stale.fx.fallbackReason='source-unavailable';
  const h = advanceMinimumHistory(initial,stale);
  assert.equal(h.events.length,1);assert.equal(h.pendingGap,true);
  assert.equal(assertMinimumHistoryMatches(h,stale),true);
  const next=advanceMinimumHistory(h,fixture({day:2,rates:[2,5,2.5]}));
  assert.equal(next.events.at(-1).cause,'unknown');assert.equal(next.gaps.length,1);
  assert.equal(next.pendingGap,false);
});

test('same timestamps are idempotent but conflicting data and backwards observations fail', () => {
  const a=fixture(),h=first(a);
  assert.deepEqual(advanceMinimumHistory(h,a),h);
  const renamed=structuredClone(a);
  renamed.countries.find(c=>c.marketId==='mx').nameZh='墨西哥（显示名更新）';
  const projection=advanceMinimumHistory(h,renamed);
  assert.equal(projection.observations,h.observations,'display-only changes are not new observations');
  assert.deepEqual(projection.events,h.events,'historical labels stay immutable');
  assert.equal(assertMinimumHistoryMatches(projection,renamed),true);
  assert.throws(()=>advanceMinimumHistory(h,fixture({values:[900,100,100]})), /Conflicting/);
  assert.throws(()=>advanceMinimumHistory(h,fixture({day:-1})), /roll back/);
  assert.throws(()=>assertMinimumHistoryMatches(h,fixture({day:1})), /does not match/);
});

test('FX fingerprint excludes unused currencies, does not expose quotes and detects used factor changes', () => {
  const countries=fixture().countries;
  const fx={stale:false,rates:{USD:1,CNY:7,MXN:20,CAD:2,TWD:30,EUR:1}};
  const a=comparisonFxFingerprint(fx,countries);assert.match(a,/^[a-f0-9]{64}$/);
  fx.rates.EUR=999;assert.equal(comparisonFxFingerprint(fx,countries),a);
  fx.rates.CAD=3;assert.notEqual(comparisonFxFingerprint(fx,countries),a);
  fx.stale=true;assert.equal(comparisonFxFingerprint(fx,countries),null);
  assert.equal(comparisonFxFingerprint({},countries),null);
});

test('uses stored precision ranks, and rejects ambiguous rounded-only historical winners', () => {
  const d=fixture({rates:[10,10,5]});
  d.countries[0].plans['6TB'].cnyPrice=10;
  d.countries[1].plans['6TB'].cnyPrice=10.01;
  assert.deepEqual(buildMinimumSnapshot(d).tiers[0].winners.map(r=>r.id),['ca','mx']);
  const v3=fixture(); v3.schemaVersion=3;
  v3.countries.forEach(c=>{delete c.marketId;delete c.plans['6TB'].cnyRank;});
  const s=buildMinimumSnapshot(v3);assert.equal(s.basis,'saved-cny');
  v3.countries[1].plans['6TB'].cnyPrice=10;
  assert.throws(()=>buildMinimumSnapshot(v3), /cannot resolve/);
  v3.countries[1].plans['6TB'].cnyPrice=10.01;
  assert.throws(()=>buildMinimumSnapshot(v3), /cannot resolve/);
});

test('history contract rejects malformed rows, corrupt causes, chronology, chain and checkpoint mismatches', () => {
  const good=advanceMinimumHistory(first(),fixture({day:1,rates:[2,5,2.5]}));
  const mutations=[
    h=>h.events.at(-1).cause='apple', h=>h.events.at(-1).from[0].id='other',
    h=>h.events[0].to[0].id=12, h=>h.events[0].to[0].name='unsafe\u202e',
    h=>h.events[0].to[0].local=Infinity, h=>h.events[0].to[0].cny=1.234,
    h=>h.events.at(-1).previousAt=h.events.at(-1).at,
    h=>h.checkpoint.tiers[0].winners[0].id='other', h=>h.checkpoint.at=h.events[0].at,
    h=>h.firstObservedAt=h.checkedAt, h=>h.events.push(h.events.at(-1)),
    h=>h.gaps.push({from:h.checkedAt,to:h.firstObservedAt})
  ];
  for(const [i,mutate] of mutations.entries()) {const h=structuredClone(good);mutate(h);assert.throws(()=>validateMinimumHistoryPayload(h), undefined, `mutation ${i}`);}
});
