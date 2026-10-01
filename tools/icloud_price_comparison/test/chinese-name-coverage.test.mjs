import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { compareMarketNameSets, findUnappliedChineseLabels } from '../scripts/check-apple-zh-markets.mjs';
const data = (names) => ({schemaVersion:4,countries:names.map((nameZh,i)=>({marketId:'id-'+i,country:'English '+i,nameZh}))});
test('reviewed names still alert until present in display data',()=>{
  const labels=['日本','新名称'];
  assert.deepEqual(compareMarketNameSets(labels,labels).added,[]);
  assert.deepEqual(findUnappliedChineseLabels(labels,data(['日本','English 1'])),['新名称']);
});
test('completed display removes pending label without inferring identity',()=>{
  assert.deepEqual(findUnappliedChineseLabels(['日本','新名称'],data(['日本','新名称'])),[]);
});
test('repeated checks preserve unresolved labels and ignore row order or equal prices',()=>{
  const labels=['日本','新名称'];const d=data(['日本','English 1']);
  d.countries.forEach(m=>m.price=0.99);
  const before=JSON.stringify(d);
  for(let i=0;i<3;i++)assert.deepEqual(findUnappliedChineseLabels([...labels].reverse(),d),['新名称']);
  assert.equal(JSON.stringify(d),before);
});
test('temporary source disappearance never deletes existing names',()=>{
  const d=data(['日本','新名称']);const before=JSON.stringify(d);
  assert.deepEqual(findUnappliedChineseLabels(['日本'],d),[]);
  assert.equal(JSON.stringify(d),before);
});
test('new spelling remains pending even if its old spelling is displayed',()=>{
  assert.deepEqual(findUnappliedChineseLabels(['摩尔多瓦'],data(['莫尔多瓦'])),['摩尔多瓦']);
});
test('invalid or empty data is monitoring failure, never no-change',()=>{
  for(const d of [null,{},data([]),{schemaVersion:4,countries:[{}]}])
    assert.throws(()=>findUnappliedChineseLabels(['日本'],d));
  const d=data(['日本']);d.countries.push({...d.countries[0]});
  assert.throws(()=>findUnappliedChineseLabels(['日本'],d));
});
test('whitespace normalization and repeated labels do not create false alarms',()=>{
  assert.deepEqual(findUnappliedChineseLabels([' 日本 ','日本'],data(['日本'])),[]);
});

test('published Chinese labels come only from the reviewed Apple name list', () => {
  const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const mapping = read('../scripts/country-names.zh.json');
  const reviewed = read('../scripts/apple-zh-reviewed-markets.json');
  const prices = read('../data/prices.json');
  assert.equal(reviewed.source, 'https://support.apple.com/zh-cn/108047');
  const official = new Set(reviewed.markets);
  for (const [id, name] of Object.entries(mapping)) {
    assert.ok(name === null || (typeof name === 'string' && name.trim() === name
      && name.length > 0 && official.has(name)), id + ': unreviewed Chinese wording');
  }
  for (const market of prices.countries) {
    assert.equal(market.nameZh, mapping[market.marketId] ?? market.country,
      market.marketId + ': display must use the reviewed mapping or original English');
  }
});
