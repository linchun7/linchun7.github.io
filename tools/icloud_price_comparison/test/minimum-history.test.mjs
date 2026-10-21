import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir, devNull } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { minimumChangeCause, validateMinimumHistoryPayload, validatePricePayload } from '../data-contract.js';
import { attachDerivedCnyPrices, publicExchangeRateMetadata } from '../scripts/update-prices.mjs';
import { advanceMinimumHistory, assertMinimumHistoryMatches, buildMinimumSnapshot, comparisonFxFingerprint,
  emptyMinimumHistory, updateMinimumHistory, writeMinimumHistory, backfillMinimumHistory, minimumEventComparison, enrichMinimumEvent } from '../scripts/minimum-history.mjs';
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

// Build history within the test, rather than relying on old SHA objects being
// present in CI's depth-one checkout or pinning future production event counts.
test('backfill is reproducible in a self-contained Git fixture and rejects shallow evidence', async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), 'minimum-backfill-'));
  const repo = path.join(tmp, 'repo');
  const projectDir = path.join(repo, 'tools/icloud_price_comparison');
  const pricePath = 'tools/icloud_price_comparison/data/prices.json';
  const git = (args, cwd = repo) => execFileSync('git', args, {
    cwd, encoding:'utf8', stdio:['ignore','pipe','pipe'],
    env:{...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:devNull}
  }).trim();
  try {
    await mkdir(path.join(projectDir,'data'), {recursive:true});
    git(['init','--initial-branch=main']);
    await writeFile(path.join(projectDir,'data/history.json'),
      await readFile(new URL('../data/history.json',import.meta.url)));
    const save = async (data, message) => {
      await writeFile(path.join(repo,pricePath),JSON.stringify(data));
      git(['add','.']);
      git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
        '-c','commit.gpgSign=false','commit','-m',message]);
      return git(['rev-parse','HEAD']);
    };
    const a=fixture(), b=fixture({day:1,rates:[2,5,2.5]});
    const firstSha=await save(a,'initial observation');
    const secondSha=await save(b,'FX winner change');
    const actual=await backfillMinimumHistory({projectDir});
    const expected=advanceMinimumHistory(advanceMinimumHistory(advanceMinimumHistory(null,a,{sourceCommit:firstSha}),b,{sourceCommit:secondSha}),b);
    assert.equal(actual.versions,2);
    assert.deepEqual(actual.ledger,expected);
    assert.deepEqual(await backfillMinimumHistory({projectDir}),actual);
    assert.deepEqual(actual.ledger.events.at(-1).from.map(r=>r.id),['mx']);
    assert.deepEqual(actual.ledger.events.at(-1).to.map(r=>r.id),['ca']);
    assert.equal(actual.ledger.events.at(-1).cause,'fx');
    const shallow=path.join(tmp,'shallow');
    git(['clone','--depth=1',pathToFileURL(repo).href,shallow]);
    await assert.rejects(backfillMinimumHistory({projectDir:path.join(shallow,'tools/icloud_price_comparison')}),/shallow checkout/);
    await assert.rejects(backfillMinimumHistory({projectDir,ref:'--all'}),/Invalid Git ref/);
    for (const failure of ['deleted', 'malformed']) {
      git(['checkout', '--detach', secondSha]);
      if (failure === 'deleted') git(['rm', pricePath]);
      else {
        await writeFile(path.join(repo, pricePath), '{invalid json');
        git(['add', pricePath]);
      }
      git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
        '-c','commit.gpgSign=false','commit','-m', failure + ' evidence']);
      const brokenSha = git(['rev-parse','HEAD']);
      await save(fixture({day:2}), 'restore valid current prices');
      await assert.rejects(backfillMinimumHistory({projectDir}), error =>
        error.message.includes('Backfill cannot read price evidence at ' + brokenSha));
    }
  } finally {await rm(tmp,{recursive:true,force:true});}
});

test('same-observation comparison preserves old facts while repricing the former winners', () => {
  const a = fixture({ rates: [5,5,2.5] }), b = fixture({ day:1, rates:[2,5,2.5] });
  const event = changed(a,b);
  assert.deepEqual(event.from.map(r=>r.cny), [20,20]);
  assert.deepEqual(event.comparison.from.map(r=>r.cny), [20,50]);
  assert.deepEqual(event.comparison.to, event.to);
  assert.equal(event.comparison.at, b.generatedAt);
  assert.equal(event.comparison.from.find(r=>r.id==='ca').cny, event.to[0].cny);
  const original = structuredClone(event); delete original.comparison;
  assert.deepEqual(enrichMinimumEvent(original,b), event);
  assert.deepEqual(original.from.map(r=>r.cny), [20,20]);
  assert.throws(()=>minimumEventComparison(original,a), /event price snapshot/);
  assert.throws(()=>minimumEventComparison(original,b,{sourceCommit:'a'.repeat(40)}), /source commit/);
  const wrongWinner = structuredClone(original); wrongWinner.to[0].cny += 1;
  assert.throws(()=>minimumEventComparison(wrongWinner,b), /winners do not match/);
});

test('same-observation comparison marks removed markets and capacities instead of old-price fallback', () => {
  const a=fixture(), b=fixture({day:1});
  b.countries=b.countries.filter(c=>c.marketId!=='mx');
  b.countries[0].plans['6TB'].cnyRank=1; b.countries[1].plans['6TB'].cnyRank=2;
  b.run.countries=2;b.run.pricePoints=2;
  const event=changed(a,b);
  assert.deepEqual(event.comparison.from, []);
  assert.deepEqual(event.comparison.missing, [{id:'mx',name:event.from[0].name}]);
  const c=fixture({day:2});
  c.tiers=[{id:'12TB',label:'12 TB',capacityGb:12288}];
  c.countries.forEach(c=>{c.plans['12TB']=c.plans['6TB'];delete c.plans['6TB'];});
  const removed=advanceMinimumHistory(first(a),c).events.find(e=>e.kind==='change');
  assert.deepEqual(removed.comparison.from, []);
  assert.deepEqual(removed.comparison.to, []);
  assert.equal(removed.comparison.missing.length,removed.from.length);
});

test('comparison contract rejects inconsistent evidence and accepts legacy events without it', () => {
  const good=advanceMinimumHistory(first(fixture({rates:[5,5,2.5]})),fixture({day:1,rates:[2,5,2.5]}));
  const legacy=structuredClone(good); legacy.events.forEach(e=>delete e.comparison);
  validateMinimumHistoryPayload(legacy);
  const mutations=[
    e=>e.comparison=null, e=>e.comparison.at=e.previousAt,
    e=>e.comparison.extra=true, e=>e.comparison.fingerprint='bad',
    e=>e.comparison.sourceCommit='a'.repeat(40),
    e=>e.comparison.basis='saved-fx',
    e=>e.comparison.fxFetchedAt='2099-01-01T00:00:00Z',
    e=>e.comparison.from.push(e.comparison.from[0]),
    e=>e.comparison.from[0].id='aa',
    e=>e.comparison.from[0].cny+=1,
    e=>e.comparison.to[0].cny+=1,
    e=>e.comparison.from.pop(),
    e=>e.comparison.missing.push({id:'ca',name:e.from[0].name})
  ];
  mutations.forEach((mutate,i)=>{
    const h=structuredClone(good);mutate(h.events.at(-1));
    assert.throws(()=>validateMinimumHistoryPayload(h),undefined,'comparison mutation '+i);
  });
});

test('history display uses only same-observation evidence and lists every tied market', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../script.js',import.meta.url),'utf8');
  const context={moneyFormatter:new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})};
  for(const name of ['minimumWinnerSummary','minimumEventSummary']){
    const match=source.match(new RegExp('function '+name+'\\([^]*?\\n\\}'));
    assert.ok(match,name);
    context[name]=runInNewContext('('+match[0]+')',context);
  }
  const event=changed(fixture({rates:[5,5,2.5]}),fixture({day:1,rates:[2,5,2.5]}));
  assert.equal(context.minimumEventSummary(event),'加拿大（¥20.00）、墨西哥（¥50.00）此前并列最低 → 加拿大（¥20.00）');
  const legacy=structuredClone(event);delete legacy.comparison;
  assert.equal(context.minimumEventSummary(legacy),'加拿大（同期价未记录）、墨西哥（同期价未记录）此前并列最低 → 加拿大（¥20.00）');
  const missing=structuredClone(event);missing.comparison.from.pop();
  assert.equal(context.minimumEventSummary(missing),'加拿大（¥20.00）、墨西哥（同期价缺失）此前并列最低 → 加拿大（¥20.00）');
  const many=['甲','乙','丙','丁','戊'].map((name,i)=>({id:String(i),name,cny:1}));
  assert.equal(context.minimumEventSummary({from:many,to:many,comparison:{from:many,to:many}}),
    '甲（¥1.00）、乙（¥1.00）、丙（¥1.00）、丁（¥1.00）、戊（¥1.00）此前并列最低 → 甲（¥1.00）、乙（¥1.00）、丙（¥1.00）、丁（¥1.00）、戊（¥1.00）并列最低');
  assert.equal(context.minimumEventSummary({from:[],to:[]}), '暂无 → 暂无');
  assert.equal(context.minimumEventSummary({from:[],to:[many[0]]}), '暂无 → 甲（¥1.00）');
  assert.equal(context.minimumEventSummary({from:[many[0]],to:[],comparison:{from:[many[0]],to:[]}}), '甲（¥1.00） → 暂无');
  assert.equal(context.minimumEventSummary({from:[many[0]],to:many.slice(0,2),comparison:{from:[many[0]],to:many.slice(0,2)}}), '甲（¥1.00） → 甲（¥1.00）、乙（¥1.00）并列最低');
});

test('published changes retain original facts and carry source-bound same-observation amounts', () => {
  const august=existing.events.find(e=>e.at==='2026-08-10T00:05:56.887Z' && e.tier==='50GB');
  const september=existing.events.find(e=>e.at==='2026-09-25T04:51:35.064Z' && e.tier==='6TB');
  assert.equal(august.from[0].cny,4.87);
  assert.equal(august.comparison.from[0].cny,4.86);
  assert.equal(august.comparison.to[0].cny,4.86);
  assert.notEqual(august.from[0].id,august.to[0].id,'rounded display equality must not rewrite the exact ranking');
  assert.equal(september.from[0].cny,190.36);
  assert.equal(september.comparison.from[0].cny,189.96);
  assert.equal(september.comparison.to[0].cny,189.67);
  for(const event of [august,september]){
    assert.equal(event.comparison.at,event.at);
    assert.equal(event.comparison.sourceCommit,event.sourceCommit);
    assert.deepEqual(event.comparison.to,event.to);
    assert.match(event.comparison.fingerprint,/^[a-f0-9]{64}$/);
  }
});
