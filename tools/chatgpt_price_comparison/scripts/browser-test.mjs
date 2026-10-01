// Dependency-free smoke tests against the runner's installed Chrome via CDP.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { plansFor, offerFor, comparisonFor } from './browser-oracle.mjs';

const scope = process.env.BROWSER_TEST_SCOPE || 'full';
assert.ok(['full', 'state'].includes(scope), 'Unknown BROWSER_TEST_SCOPE');
const fullUi = scope === 'full';
const responsiveUi = fullUi || ['pending', 'aliases'].includes(process.env.BROWSER_STATE_FIXTURE);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const chrome = process.env.CHROME_BIN || ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
assert.ok(chrome, 'A local Chrome/Chromium installation is required');
const profile = await mkdtemp(path.join(tmpdir(), 'chatgpt-browser-'));
const server = spawn('python3', ['-m','http.server','4177','--bind','127.0.0.1'], {cwd: root, stdio:'ignore'});
async function freePort() {
  const probe=createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});
  const address=probe.address();
  assert.ok(address && typeof address === 'object', 'Could not allocate Chrome debugging port');
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  return address.port;
}
const debugPort = process.env.CHROME_DEBUG_PORT ? Number(process.env.CHROME_DEBUG_PORT) : await freePort();
assert.ok(Number.isInteger(debugPort) && debugPort > 0 && debugPort < 65536, 'Invalid Chrome debugging port');
const browserEnv={...process.env};
delete browserEnv.DBUS_SESSION_BUS_ADDRESS; delete browserEnv.DBUS_STARTER_ADDRESS; delete browserEnv.DBUS_STARTER_BUS_TYPE;
const browser = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${debugPort}`,`--user-data-dir=${profile}`], {stdio:['ignore','ignore','pipe'],env:browserEnv});
let diagnostics = '', launchError;
browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-12000); });
browser.once('error', error => { launchError = error; });
const delay = ms => new Promise(r => setTimeout(r, ms));
let socket, serial = 0; const pending = new Map();
async function until(test, label, timeout=15000) {
  const deadline=Date.now()+timeout;
  do { try { const value=await test(); if(value) return value; } catch {} await delay(100); } while(Date.now()<deadline);
  throw Error('Timed out: '+label);
}
async function command(method, params={}) {
  const id=++serial;
  const response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id); reject(Error('CDP timeout: '+method));},15000);pending.set(id,{resolve,reject,timer});});
  socket.send(JSON.stringify({id,method,params})); return response;
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function pressKey(key) {
  const code = key === ' ' ? 'Space' : key;
  const virtualKey = key === ' ' ? 32 : key === 'Tab' ? 9 : 13;
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey });
}
try {
  // Use an isolated free loopback port; this avoids collisions with runner services.
  let port;
  // Hosted runners can take over 30 seconds to launch Chrome under load.
  // Only startup receives this bounded grace period; page assertions stay strict.
  const launchDeadline = Date.now() + 60000;
  while (Date.now() < launchDeadline) {
    if (launchError || browser.exitCode !== null) throw Error('Chrome exited before ready: ' + (launchError || browser.exitCode) + '\n' + diagnostics);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {signal: AbortSignal.timeout(1000)});
      if (response.ok) { port = String(debugPort); break; }
    } catch {}
    await delay(100);
  }
  assert.ok(port, 'Chrome readiness failed: ' + diagnostics);
  const origin = `http://127.0.0.1:${port}`;
  const tab=await (await fetch(origin+'/json/new?about:blank',{method:'PUT'})).json();
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message', ({data}) => {const m=JSON.parse(data), p=pending.get(m.id);if(m.method === 'Runtime.exceptionThrown') console.error('PAGE ERROR',JSON.stringify(m.params));if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  await command('Emulation.setTimezoneOverride', {timezoneId: 'Asia/Tokyo'});
  const url='http://127.0.0.1:4177/tools/chatgpt_price_comparison/';
  await until(async()=> (await fetch(url)).ok,'HTTP server');
  const testNow = Date.now();
  await command('Page.addScriptToEvaluateOnNewDocument', { source: `
    Date.now = () => ${testNow};
    globalThis.__chatgptTestIntervals = [];
    const originalSetInterval = globalThis.setInterval.bind(globalThis);
    globalThis.setInterval = (callback, milliseconds, ...args) => {
      if (milliseconds === 30000 && typeof callback === 'function') globalThis.__chatgptTestIntervals.push(() => callback(...args));
      return originalSetInterval(callback, milliseconds, ...args);
    };
  ` });
  await command('Page.navigate',{url});
  await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length > 0 && document.querySelector(".country-history-button:not(:disabled)")'),'interactive matrix');
  const expected = JSON.parse(await readFile(path.join(root, 'tools/chatgpt_price_comparison/data/prices.json'), 'utf8'));
  const plans = plansFor(expected);
  const defaultPlan = plans.includes('ChatGPT Plus') ? 'ChatGPT Plus' : plans[0];
  const sampleMarket = expected.markets.find(m => offerFor(m, defaultPlan)) || expected.markets.find(m => m.offers.length);
  assert.ok(defaultPlan && sampleMarket, 'at least one observed plan and market');
  const sampleOffer = offerFor(sampleMarket, defaultPlan);
  async function clickPlan(plan) {
    await evaluate(`{
      const button = [...document.querySelectorAll('button[data-sort-plan]')].find(node => node.dataset.sortPlan === ${JSON.stringify(plan)});
      if (!button) throw Error('Missing plan sort button');
      button.click();
    }`);
  }
  async function assertRanks(plan) {
    const oracle = comparisonFor(expected, plan, testNow);
    const actual = await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id]')].map(row => ({ code: row.dataset.marketId, rank: row.querySelector('td:first-child').textContent, accessible: row.querySelector('.mobile-rank-sr').textContent }))`);
    assert.equal(actual.length, expected.markets.length, 'every market remains visible');
    assert.equal(new Set(actual.map(row => row.code)).size, actual.length, 'no duplicate market rows');
    for (const row of actual) {
      const reference = oracle.rows.find(item => item.market.code === row.code);
      assert.ok(reference, `unexpected market ${row.code}`);
      const rank = reference.cents == null ? null : oracle.ranks.get(reference.cents);
      assert.equal(row.rank, rank == null ? '—' : String(rank), `${plan}/${row.code}: exact eligible rank`);
      assert.equal(row.accessible, rank == null ? '排名暂不可用' : `全球价格排名第 ${rank}`, `${plan}/${row.code}: accessible rank follows eligibility`);
    }
  }
  async function assertMinimums() {
    const actual = await evaluate(`[...document.querySelectorAll('.minimum-card')].map(card => ({ disabled: card.disabled, plan: card.dataset.plan || '', marketId: card.dataset.marketId || '', label: card.querySelector('.minimum-plan-label').textContent, country: card.querySelector('.minimum-country').textContent, price: card.querySelector('.minimum-price').textContent }))`);
    assert.equal(actual.length, plans.length);
    let expectedEnabled = 0;
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]; const oracle = comparisonFor(expected, plan, testNow); const card = actual[index];
      assert.equal(card.label, plan.replace(/^ChatGPT\s+/, ''));
      const badges = await evaluate(`[...document.querySelectorAll('#priceRows td[data-plan].is-minimum')].filter(cell => cell.dataset.plan === ${JSON.stringify(plan)}).map(cell => cell.closest('tr').dataset.marketId).sort()`);
      assert.deepEqual(badges, oracle.winners.map(m => m.code).sort(), `${plan}: exact minimum badge winners`);
      if (oracle.minimum == null) {
        assert.equal(card.disabled, true, `${plan}: no eligible price disables card`);
        assert.equal(card.country, '暂无可比较价格'); assert.equal(card.price, '—'); assert.equal(card.marketId, '');
      } else {
        expectedEnabled += 1;
        assert.equal(card.disabled, false); assert.equal(card.plan, plan); assert.equal(card.marketId, oracle.winners[0].code);
        assert.equal(card.country, oracle.winners.length > 3 ? `${oracle.winners.length} 个地区并列最低` : oracle.winners.map(m => m.name).join('、'));
        assert.equal(card.price, `¥${(oracle.minimum / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
      }
    }
    assert.equal(actual.filter(card => !card.disabled).length, expectedEnabled);
    return expectedEnabled;
  }

  if(process.env.REQUIRE_FUTURE_PLAN==='1') {
    assert.ok(plans.length>=5,'future-plan fixture exercises at least five plans');
  }
  assert.equal(await evaluate('document.querySelectorAll("[data-plan-header]").length'),plans.length,'one column per plan');
  assert.equal(await evaluate('document.querySelectorAll(".minimum-card").length'),plans.length,'one minimum card per plan');
  assert.equal(await evaluate(`document.querySelector('#overviewTitle').textContent`),'各套餐全球最低价','overview wording matches iCloud pattern');
  assert.equal(await evaluate(`document.querySelector('#priceWorkspace .workspace-heading h2').textContent`),'全球 ChatGPT App Store 标价','workspace wording matches iCloud pattern');
  assert.equal(await evaluate(`document.querySelector('#marketCount').textContent`),`${expected.markets.filter(m=>m.offers.length).length} 个地区`,'coverage uses the compact iCloud count wording');
  assert.equal(await evaluate('document.querySelectorAll("#mobilePlanControl button").length'),plans.length,'mobile plan selector includes every plan');
  assert.equal(await evaluate('document.querySelector(".search-field svg")!==null && document.querySelector("button[data-sort=country] svg")!==null'),true,'Lucide search and sort icons render');
  assert.equal(await evaluate('document.querySelector("#refresh")===null && document.querySelector("#plan")===null && document.querySelector("#status")===null'),true,'legacy reload and filters removed');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryButton").disabled'),false,'minimum history action becomes interactive');
  await evaluate('document.querySelector("#minimumHistoryButton").click()');
  await until(()=>evaluate('document.querySelector("#minimumHistoryDialog")?.open===true'),'minimum history dialog');
  await until(()=>evaluate(`document.querySelector("#minimumHistoryEvents").textContent.trim().length>0 || !document.querySelector("#minimumHistoryRetry").hidden`),'minimum history load');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryRetry").hidden'),true,'committed minimum history loads without entering the isolated error state');
  assert.match(await evaluate('document.querySelector("#minimumHistoryEvents").textContent'),/暂无最低价变更记录|→/,'minimum history renders an auditable timeline or explicit empty state');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryNote").hidden'),false,'minimum history displays its scope note');
  const acceptedHistoryText = await evaluate('document.querySelector("#minimumHistoryEvents").textContent');
  const acceptedHistoryDate = await evaluate('document.querySelector("#minimumHistoryStatus").textContent');
  assert.match(acceptedHistoryDate, /记录截至/);
  const badHistory = JSON.parse(await readFile(path.join(root,'tools/chatgpt_price_comparison/data/minimum-history.json'),'utf8'));
  const futureHistoryTime = new Date(Date.parse(expected.generated_at)+86400e3).toISOString();
  if (badHistory.events.length) badHistory.events.at(-1).at = futureHistoryTime;
  else badHistory.gaps = [{from:expected.generated_at,to:futureHistoryTime}];
  await evaluate(`{
    globalThis.__originalHistoryFetch = globalThis.fetch;
    const bad = ${JSON.stringify(badHistory)};
    globalThis.fetch = (input,init) => new URL(input.url || input,location.href).pathname.endsWith('/minimum-history.json')
      ? new Promise(resolve => { globalThis.__releaseHistory = () => resolve(new Response(JSON.stringify(bad),{status:200,headers:{'content-type':'application/json'}})); })
      : globalThis.__originalHistoryFetch(input,init);
    document.querySelector('#minimumHistoryRetry').click();
  }`);
  await until(()=>evaluate('typeof globalThis.__releaseHistory === "function"'), 'deferred history request');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryEvents").textContent'), acceptedHistoryText, 'pending refresh preserves accepted history');
  await evaluate('document.querySelector("#closeMinimumHistory").click(); document.querySelector("#minimumHistoryButton").click();');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryEvents").textContent'), acceptedHistoryText, 'pending reopen preserves accepted history');
  await evaluate('globalThis.__releaseHistory(); delete globalThis.__releaseHistory;');
  await until(()=>evaluate(`!document.querySelector('#minimumHistoryRetry').hidden && document.querySelector('#minimumHistoryStatus').textContent.includes('暂无法刷新')`),'future history is rejected without dropping old records');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryEvents").textContent'), acceptedHistoryText);
  assert.ok((await evaluate('document.querySelector("#minimumHistoryStatus").textContent')).startsWith(acceptedHistoryDate), 'failed refresh preserves actual cutoff');
  await evaluate('document.querySelector("#minimumHistoryPlanFilter").dispatchEvent(new Event("change")); document.querySelector("#minimumHistoryMore").click(); document.querySelector("#minimumHistoryPlanFilter").dispatchEvent(new Event("change"));');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryRetry").hidden'), false, 'filter/pagination retain retry');
  await evaluate(`globalThis.fetch = (input, init) => new URL(input.url || input, location.href).pathname.endsWith('/minimum-history.json') ? Promise.reject(Error('offline')) : globalThis.__originalHistoryFetch(input, init); document.querySelector('#minimumHistoryRetry').click();`);
  await until(()=>evaluate(`document.querySelector('#minimumHistoryStatus').textContent.includes('暂无法刷新') && !document.querySelector('#minimumHistoryRetry').disabled`), 'network failure preserves history');
  assert.equal(await evaluate('document.querySelector("#minimumHistoryEvents").textContent'), acceptedHistoryText);
  assert.ok(await evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length>0'),'bad history never removes current prices');
  await evaluate(`{globalThis.fetch=globalThis.__originalHistoryFetch;delete globalThis.__originalHistoryFetch;document.querySelector('#minimumHistoryRetry').click();}`);
  await until(()=>evaluate(`document.querySelector('#minimumHistoryRetry').hidden && !document.querySelector('#minimumHistoryRetry').disabled && !document.querySelector('#minimumHistoryNote').hidden`),'valid history recovers after retry');

  await evaluate('document.querySelector("#closeMinimumHistory").click()');

  assert.equal(await evaluate('document.activeElement?.id'), 'minimumHistoryButton', 'minimum history restores focus synchronously');
  await evaluate(`document.querySelector('button[data-sort="country"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel > [aria-hidden="true"]').textContent`),'序号','country sort switches rank header to sequence');
  assert.equal(await evaluate(`document.querySelector('#priceRows .mobile-rank').textContent`),'序1','country sort uses mobile sequence label');
  assert.equal(await evaluate(`document.querySelector('#priceRows .mobile-rank-sr').textContent`),'当前列表序号第 1','country sort exposes accessible sequence label');
  await clickPlan(defaultPlan);
  if (fullUi) for (const key of ['Enter', ' ']) {
    await evaluate(`[...document.querySelectorAll('button[data-sort-plan]')].find(button => button.dataset.sortPlan === ${JSON.stringify(defaultPlan)}).focus()`);
    await pressKey(key);
    assert.equal(await evaluate('document.activeElement?.dataset.sortPlan'), defaultPlan, 'keyboard sorting preserves the replaced header focus');
  }
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel > [aria-hidden="true"]').textContent`),'排名','plan sort restores ranking header');
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel .visually-hidden').textContent`),'全球参考排名','ranking label follows the global comparison wording');
  await assertRanks(defaultPlan);

  await evaluate(`document.querySelector('#searchInput').value=${JSON.stringify(sampleMarket.name)};document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length===1'),'sample market filter');
  assert.ok(await evaluate(`document.querySelector('#priceRows').textContent.includes(${JSON.stringify(sampleMarket.name)})`));
  assert.equal(await evaluate(`document.querySelector('#priceRows tr[data-market-id="${sampleMarket.code}"] td:nth-child(2) a')===null`),true,'country is not an App Store link');
  if(sampleOffer?.amounts.length) {
    const sortedAmounts=[...sampleOffer.amounts].sort((a,b)=>Number(a.amount)-Number(b.amount));
    const comparisonDisplay=sortedAmounts[0].display;
    const comparisonCellText = await evaluate(`{
      const row = document.querySelector(${JSON.stringify(`#priceRows tr[data-market-id="${sampleMarket.code}"]`)});
      [...row.querySelectorAll('[data-plan]')].find(cell => cell.dataset.plan === ${JSON.stringify(defaultPlan)}).textContent;
    }`);
    assert.ok(comparisonCellText.includes(comparisonDisplay),'main table shows the plan-local minimum public amount');
    for(const other of sortedAmounts.slice(1)) {
      assert.equal(comparisonCellText.includes(other.display),false,'main table excludes non-minimum same-label amounts');
    }
  }

  await evaluate(`document.querySelector('#priceRows tr[data-market-id="${sampleMarket.code}"] .country-history-button').click()`);
  await until(()=>evaluate('document.querySelector("#historyDialog").open'),'history dialog');
  assert.equal(await evaluate(`document.querySelector('#historyTitle').textContent`),sampleMarket.name,'history opens for country');
  assert.ok(await evaluate(`document.querySelector('#historyRows').children.length >= 1`),'history has at least current observation');
  if(sampleOffer?.amounts.length) {
    const historyLocal=await evaluate(`document.querySelector('#historyLocalPrice').textContent`);
    for(const amount of sampleOffer.amounts) assert.ok(historyLocal.includes(amount.display),'history preserves every same-label public amount');
  }
  const sampleVerifiedDate = await evaluate(`new Date(${JSON.stringify(sampleMarket.last_verified_at)}).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})`);
  assert.ok(await evaluate(`document.querySelector('#historySubtitle').textContent.includes(${JSON.stringify('价格更新于 ' + sampleVerifiedDate)})`), 'history exposes the actual market observation date');
  if (fullUi) for (const key of ['Enter', ' ']) {
    await evaluate(`[...document.querySelectorAll('#historyPlanControl button')].find(button => button.dataset.plan === ${JSON.stringify(defaultPlan)}).focus()`);
    await pressKey(key);
    assert.equal(await evaluate('document.activeElement?.dataset.plan'), defaultPlan, 'history plan activation retains keyboard focus');
    assert.equal(await evaluate('document.querySelector("#historyPlanControl").contains(document.activeElement)'), true);
    await pressKey('Tab');
    assert.equal(await evaluate('document.querySelector("#historyDialog").contains(document.activeElement)'), true, 'Tab after a plan change remains inside the modal');
  }
  assert.equal(await evaluate(`document.querySelector('.history-current div:nth-child(3) span').textContent`),'近期变更次数','history count is scoped to retained events');
  await evaluate(`document.querySelector('#closeHistory').click()`);

  if (process.env.BROWSER_STATE_FIXTURE === 'retired_plan') {
    await evaluate(`document.querySelector(${JSON.stringify(`#priceRows tr[data-market-id="${sampleMarket.code}"] .country-history-button`)}).click()`);
    await until(() => evaluate('document.querySelector("#historyDialog").open'), 'retired-plan country history');
    assert.equal(await evaluate(`[...document.querySelectorAll('#historyPlanControl button')].some(button => button.textContent === 'Retired Fixture')`), true, 'retired plan remains selectable in country history');
    await evaluate(`[...document.querySelectorAll('#historyPlanControl button')].find(button => button.textContent === 'Retired Fixture').click()`);
    assert.equal(await evaluate(`document.querySelector('#historyLocalPrice').textContent`), '—', 'retired plan has no invented current price');
    assert.ok(await evaluate(`document.querySelector('#historyRows').textContent.includes('42 USD')`), 'retired plan retains its historical amount');
    assert.equal(await evaluate(`[...document.querySelectorAll('[data-plan-header]')].some(header => header.dataset.plan === 'ChatGPT Retired Fixture')`), false, 'retired plan does not become a current comparison column');
    await evaluate(`document.querySelector('#closeHistory').click()`);
  }

  await evaluate(`document.querySelector('#searchInput').value='';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate('globalThis.__chatgptTestIntervals.length'), 1, 'one freshness refresh interval is registered');
  const observationTimes = [Date.parse(expected.generated_at), Date.parse(expected.fx?.updated_at || ''), ...expected.markets.filter(market => market.offers.length).map(market => Date.parse(market.last_verified_at))].filter(Number.isFinite);
  const latestObservation = Math.max(...observationTimes);
  const retainedUi = await evaluate(`JSON.stringify({
    table: document.querySelector('#priceRows').innerHTML,
    minimums: document.querySelector('#minimumSummary').innerHTML,
    priceDate: document.querySelector('#updatedAt').textContent,
    fxDate: document.querySelector('#fxStatus').textContent
  })`);
  await evaluate(`globalThis.__chatgptBeforeAgeTest = Date.now`);
  for (const days of [2, 8, 365, 3650]) {
    await evaluate(`{ Date.now = () => ${latestObservation + days * 86400e3}; globalThis.__chatgptTestIntervals.forEach(callback => callback()); }`);
    assert.equal(await evaluate(`JSON.stringify({
      table: document.querySelector('#priceRows').innerHTML,
      minimums: document.querySelector('#minimumSummary').innerHTML,
      priceDate: document.querySelector('#updatedAt').textContent,
      fxDate: document.querySelector('#fxStatus').textContent
    })`), retainedUi, days + '-day age must not erase or relabel accepted prices');
    assert.equal(await evaluate(`document.querySelector('#freshnessWarning').hidden`), true);
    await evaluate(`document.querySelector(${JSON.stringify(`#priceRows tr[data-market-id="${sampleMarket.code}"] .country-history-button`)}).click()`);
    await until(() => evaluate('document.querySelector("#historyDialog").open'), 'old prices keep country history usable');
    assert.ok(await evaluate(`document.querySelector('#historySubtitle').textContent.includes('价格更新于')`));
    await evaluate(`document.querySelector('#closeHistory').click()`);
  }
  await evaluate(`{ Date.now = globalThis.__chatgptBeforeAgeTest; delete globalThis.__chatgptBeforeAgeTest; document.dispatchEvent(new Event('visibilitychange')); }`);
  await assertRanks(defaultPlan); await assertMinimums();

  if (fullUi) {
  await evaluate(`document.querySelector('#searchInput').value='<img src=x onerror=alert(1)>';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelector('#emptyState').hidden`),false,'empty search state');
  assert.equal(await evaluate(`document.querySelectorAll('#priceRows img').length`),0,'search never becomes HTML');
  await evaluate(`document.querySelector('#searchInput').value='';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  }

  const missingFxMarket=expected.markets.find(m=>m.name==='缺汇率测试');
  if(missingFxMarket){
    await evaluate(`document.querySelector('#searchInput').value='缺汇率测试';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
    await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length===1'),'missing FX filter');
    const missingRow=await evaluate(`document.querySelector('#priceRows tr[data-market-id="de"]').textContent`);
    assert.ok(missingRow.includes('—'),'missing FX renders an unavailable CNY marker');
    assert.equal(missingRow.includes('¥0.00'),false,'missing FX never becomes zero');
    assert.equal(await evaluate(`document.querySelector('#priceRows tr[data-market-id="de"] td:first-child').textContent`),'—','missing FX has no price rank');
    await evaluate(`document.querySelector('#searchInput').value='';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  }

  for (const plan of plans) { await clickPlan(plan); await assertRanks(plan); }
  const enabledMinimumCount = await assertMinimums();
  if (enabledMinimumCount > 0) {
    await evaluate(`document.querySelector('.minimum-card:not(:disabled)').click()`);
    await until(() => evaluate(`document.querySelector('#priceRows tr.is-highlighted') !== null`), 'minimum card row focus');
  } else {
    assert.equal(await evaluate(`document.querySelectorAll('.minimum-card:not(:disabled)').length`), 0, 'degraded data never advertises an actionable minimum');
  }
  await clickPlan(defaultPlan);

  if (responsiveUi) {
  await command('Emulation.setDeviceMetricsOverride',{width:641,height:844,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow at the 641px responsive seam');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.data-status')).whiteSpace`),'normal','641px update status can wrap instead of overflowing');

  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on narrow screens');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.data-status')).justifyContent`),'flex-end','mobile update status is right-aligned');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.data-status')).textAlign`),'right','mobile update status text is right-aligned');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.brand-copy h1')).fontSize`),'17px','mobile title matches the iCloud scale');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.page-main')).rowGap`),'12px','mobile vertical rhythm matches the iCloud spacing');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mobilePlanControl')).overflowX`),'auto','future plan selector stays internally scrollable');
  assert.equal(await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id]')].every(row => [...row.querySelectorAll('td[data-plan]')].filter(td => getComputedStyle(td).display !== 'none').length === 1)`),true,'mobile shows one active plan column');
  if (fullUi) for (const key of ['Enter', ' ']) {
    await evaluate(`[...document.querySelectorAll('#mobilePlanControl button')].find(button => button.dataset.plan === ${JSON.stringify(defaultPlan)}).focus()`);
    await pressKey(key);
    assert.equal(await evaluate('document.activeElement?.dataset.plan'), defaultPlan, 'mobile plan activation retains keyboard focus');
    assert.equal(await evaluate('document.querySelector("#mobilePlanControl").contains(document.activeElement)'), true);
  }
  const mobileCountryShare=await evaluate(`{const table=document.querySelector('.price-table');const cell=document.querySelector('#priceRows tr[data-market-id] td:nth-child(2)');cell.getBoundingClientRect().width/table.getBoundingClientRect().width}`);
  assert.ok(mobileCountryShare>=0.46&&mobileCountryShare<=0.49,'mobile country column stays near the iCloud-aligned 47% width');
  await evaluate(`document.querySelector('button[data-sort="country"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#priceRows .mobile-rank').textContent`),'序1','mobile country sort exposes sequence text');
  const rankLayout=await evaluate(`{const row=document.querySelector('#priceRows tr[data-market-id]');const name=row.querySelector('.country-name').getBoundingClientRect();const sub=row.querySelector('.country-name-en').getBoundingClientRect();const rank=row.querySelector('.mobile-rank').getBoundingClientRect();({nameBottom:name.bottom,subTop:sub.top,rankTop:rank.top,rankBottom:rank.bottom,subBottom:sub.bottom})}`);
  assert.ok(rankLayout.rankTop>=rankLayout.nameBottom-1,'mobile sequence badge no longer competes with the primary country-name row');
  assert.ok(Math.abs(rankLayout.rankTop-rankLayout.subTop)<=4,'mobile sequence badge sits on the subtitle row');
  await clickPlan(defaultPlan);

  await command('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on 320px screens');
  assert.ok(await evaluate('document.querySelector(".minimum-stats").scrollWidth <= document.querySelector(".minimum-stats").clientWidth + 1'),'minimum cards stay inside the 320px overview');
  assert.ok(await evaluate('document.querySelector(".workspace").scrollWidth <= document.querySelector(".workspace").clientWidth + 1'),'workspace shell stays inside the 320px viewport');

  } else {
    await command('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:true});
    await delay(150);
    assert.equal(await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id]')].every(row => [...row.querySelectorAll('td[data-plan]')].filter(td => getComputedStyle(td).display !== 'none').length === 1)`), true, 'each data state shows exactly one mobile plan column');
  }

  if(process.env.SCREENSHOT) {
    const result=await command('Page.captureScreenshot',{format:'png'});
    await writeFile(process.env.SCREENSHOT,Buffer.from(result.data,'base64'));
  }

  await command('Emulation.setScriptExecutionDisabled',{value:true});
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate(`document.querySelectorAll('#priceRows tr[data-market-id]').length>0`),'no-JS static matrix');
  assert.equal(await evaluate(`document.querySelector('.country-history-button').disabled`),true,'no-JS country history is safely disabled');
  assert.equal(await evaluate(`document.querySelector('i[data-lucide="search"]')!==null`),true,'no-JS keeps Lucide placeholder in static HTML');
  assert.equal(await evaluate(`document.querySelector('#refresh')===null`),true,'no-JS has no reload button');
  console.log(`Browser tests passed (scope=${scope}): prices, ranks, minima, history, dates, mobile data and static fallback${fullUi ? '; complete keyboard, XSS and responsive checks' : ''}.`);
} catch(error) {
  if (socket?.readyState === 1) console.error('PAGE STATE',await evaluate('({url:location.href,rows:document.querySelectorAll("#priceRows tr").length,dialog:document.querySelector("#historyDialog")?.open,body:document.body?.textContent.slice(0,1200)})'));
  throw error;
} finally {
  socket?.close(); browser.kill('SIGTERM'); server.kill('SIGTERM');
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser closed'));}
  await delay(300); await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
