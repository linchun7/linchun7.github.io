// Dependency-free smoke tests against the runner's installed Chrome via CDP.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

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
try {
  // Use an isolated free loopback port; this avoids collisions with runner services.
  let port;
  const launchDeadline = Date.now() + 30000;
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
  await command('Page.navigate',{url});
  await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length > 0 && document.querySelector(".country-history-button:not(:disabled)")'),'interactive matrix');
  const expected=JSON.parse(await readFile(path.join(root,'tools/chatgpt_price_comparison/data/prices.json'),'utf8'));
  const plans=[...new Set(expected.markets.flatMap(m=>m.offers.map(o=>o.label)))];
  const defaultPlan=plans.includes('ChatGPT Plus')?'ChatGPT Plus':plans[0];
  const sampleMarket=expected.markets.find(m=>m.offers.some(o=>o.label===defaultPlan));
  assert.ok(defaultPlan && sampleMarket,'at least one comparable plan and market');
  const sampleOffer=sampleMarket.offers.find(o=>o.label===defaultPlan);
  assert.ok(plans.length>=5,'browser fixture exercises future plan expansion');
  assert.equal(await evaluate('document.querySelectorAll("[data-plan-header]").length'),plans.length,'one column per plan');
  assert.equal(await evaluate('document.querySelectorAll(".minimum-card").length'),plans.length,'one minimum card per plan');
  assert.equal(await evaluate('document.querySelectorAll("#mobilePlanControl button").length'),plans.length,'mobile plan selector includes every plan');
  assert.equal(await evaluate('document.querySelector(".search-field svg")!==null && document.querySelector("button[data-sort=country] svg")!==null'),true,'Lucide search and sort icons render');
  assert.equal(await evaluate('document.querySelector("#refresh")===null && document.querySelector("#plan")===null && document.querySelector("#status")===null'),true,'legacy reload and filters removed');

  await evaluate(`document.querySelector('button[data-sort="country"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel > [aria-hidden="true"]').textContent`),'序号','country sort switches rank header to sequence');
  assert.equal(await evaluate(`document.querySelector('#priceRows .mobile-rank').textContent`),'序1','country sort uses mobile sequence label');
  assert.equal(await evaluate(`document.querySelector('#priceRows .mobile-rank-sr').textContent`),'当前列表序号第 1','country sort exposes accessible sequence label');
  await evaluate(`document.querySelector('button[data-sort-plan="${defaultPlan}"]').click()`);
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel > [aria-hidden="true"]').textContent`),'排名','plan sort restores ranking header');
  assert.equal(await evaluate(`document.querySelector('#rankHeaderLabel .visually-hidden').textContent`),'已覆盖地区参考排名','ranking scope is limited to covered markets');
  assert.ok(await evaluate(`document.querySelector('#priceRows .mobile-rank-sr').textContent.startsWith('已覆盖地区价格排名第 ')`),'row ranking scope is limited to covered markets');

  await evaluate(`document.querySelector('#searchInput').value=${JSON.stringify(sampleMarket.name)};document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length===1'),'sample market filter');
  assert.ok(await evaluate(`document.querySelector('#priceRows').textContent.includes(${JSON.stringify(sampleMarket.name)})`));
  assert.equal(await evaluate(`document.querySelector('#priceRows tr[data-market-id="${sampleMarket.code}"] td:nth-child(2) a')===null`),true,'country is not an App Store link');
  if(sampleOffer?.amounts.length) {
    const sortedAmounts=[...sampleOffer.amounts].sort((a,b)=>Number(a.amount)-Number(b.amount));
    const comparisonDisplay=sortedAmounts[0].display;
    const comparisonCellText=await evaluate(`document.querySelector('#priceRows tr[data-market-id="${sampleMarket.code}"] [data-plan="${defaultPlan}"]').textContent`);
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
  assert.ok(await evaluate(`document.querySelector('#historySubtitle').textContent.includes('近期公开标价记录')`),'history scope is explicit');
  assert.equal(await evaluate(`document.querySelector('.history-current div:nth-child(3) span').textContent`),'近期变更次数','history count is scoped to retained events');
  await evaluate(`document.querySelector('#closeHistory').click()`);

  const fxUpdated=Date.parse(expected.fx?.updated_at || '');
  const newestVerified=Math.max(...expected.markets.filter(m=>m.offers.length).map(m=>Date.parse(m.last_verified_at)).filter(Number.isFinite));
  const staleFxNow=fxUpdated + 36*3600e3 + 60e3;
  if(Number.isFinite(fxUpdated) && Number.isFinite(newestVerified) && staleFxNow < newestVerified + 36*3600e3) {
    await evaluate(`globalThis.__chatgptRealDateNow=Date.now;Date.now=()=>${staleFxNow};document.querySelector('button[data-sort-plan="${defaultPlan}"]').click()`);
    assert.equal(await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id] td:first-child')].every(td=>td.textContent==='—')`),true,'stale FX is excluded from comparison ranks');
    await evaluate(`Date.now=globalThis.__chatgptRealDateNow;delete globalThis.__chatgptRealDateNow;document.querySelector('button[data-sort-plan="${defaultPlan}"]').click()`);
  }

  await evaluate(`document.querySelector('#searchInput').value='<img src=x onerror=alert(1)>';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelector('#emptyState').hidden`),false,'empty search state');
  assert.equal(await evaluate(`document.querySelectorAll('#priceRows img').length`),0,'search never becomes HTML');
  await evaluate(`document.querySelector('#searchInput').value='';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);

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

  const tiedPlan=plans.find(plan=>{
    const rows=expected.markets.map(m=>{
      const offer=m.offers.find(o=>o.label===plan);
      if(!offer)return null;
      const values=offer.amounts.filter(a=>a.cny!=null).map(a=>Number(a.cny)).filter(Number.isFinite);
      return values.length?{code:m.code,value:Math.min(...values)}:null;
    }).filter(Boolean);
    if(!rows.length)return false;
    const minimum=Math.min(...rows.map(row=>row.value));
    return rows.filter(row=>Math.abs(row.value-minimum)<=0.005).length>3;
  });
  if(tiedPlan){
    const rows=expected.markets.map(m=>{
      const offer=m.offers.find(o=>o.label===tiedPlan);
      if(!offer)return null;
      const values=offer.amounts.filter(a=>a.cny!=null).map(a=>Number(a.cny)).filter(Number.isFinite);
      return values.length?{code:m.code,value:Math.min(...values)}:null;
    }).filter(Boolean);
    const minimum=Math.min(...rows.map(row=>row.value));
    const count=rows.filter(row=>Math.abs(row.value-minimum)<=0.005).length;
    assert.equal(await evaluate(`document.querySelector('.minimum-card[data-plan="${tiedPlan}"] .minimum-country').textContent`),`${count} 个地区并列最低`,'large tied minimum is compacted');
  }

  const enabledMinimum=await evaluate(`document.querySelector('.minimum-card:not(:disabled)')?.dataset.marketId || ''`);
  assert.ok(enabledMinimum,'minimum card available');
  await evaluate(`document.querySelector('.minimum-card:not(:disabled)').click()`);
  await until(()=>evaluate(`document.querySelector('#priceRows tr.is-highlighted')!==null`),'minimum card row focus');

  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on narrow screens');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.data-status')).justifyContent`),'flex-end','mobile update status is right-aligned');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.data-status')).textAlign`),'right','mobile update status text is right-aligned');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.brand-copy h1')).fontSize`),'17px','mobile title matches the iCloud scale');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.page-main')).rowGap`),'12px','mobile vertical rhythm matches the iCloud spacing');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#mobilePlanControl')).overflowX`),'auto','future plan selector stays internally scrollable');
  assert.equal(await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id]')].every(row => [...row.querySelectorAll('td[data-plan]')].filter(td => getComputedStyle(td).display !== 'none').length === 1)`),true,'mobile shows one active plan column');

  await command('Emulation.setDeviceMetricsOverride',{width:320,height:568,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on 320px screens');
  assert.ok(await evaluate('document.querySelector(".minimum-stats").scrollWidth <= document.querySelector(".minimum-stats").clientWidth + 1'),'minimum cards stay inside the 320px overview');
  assert.ok(await evaluate('document.querySelector(".workspace").scrollWidth <= document.querySelector(".workspace").clientWidth + 1'),'workspace shell stays inside the 320px viewport');

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
  console.log('Browser tests passed: matrix columns, minimum cards, country history, variants, search/XSS, mobile plan view, no-JS static matrix.');
} catch(error) {
  if (socket?.readyState === 1) console.error('PAGE STATE',await evaluate('({url:location.href,rows:document.querySelectorAll("#priceRows tr").length,dialog:document.querySelector("#historyDialog")?.open,body:document.body?.textContent.slice(0,1200)})'));
  throw error;
} finally {
  socket?.close(); browser.kill('SIGTERM'); server.kill('SIGTERM');
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser closed'));}
  await delay(300); await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
