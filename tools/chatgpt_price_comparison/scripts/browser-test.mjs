// Dependency-free smoke tests against the runner's installed Chrome via CDP.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const chrome = process.env.CHROME_BIN || ['/usr/bin/google-chrome','/usr/bin/chromium','/usr/bin/chromium-browser'].find(existsSync);
assert.ok(chrome, 'A local Chrome/Chromium installation is required');
const profile = await mkdtemp(path.join(tmpdir(), 'chatgpt-browser-'));
const server = spawn('python3', ['-m','http.server','4177','--bind','127.0.0.1'], {cwd: root, stdio:'ignore'});
const browser = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`], {stdio:['ignore','ignore','pipe']});
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
  // Read Chrome's readiness file instead of depending on stderr log wording.
  let port;
  const launchDeadline = Date.now() + 30000;
  while (Date.now() < launchDeadline) {
    if (launchError || browser.exitCode !== null) throw Error('Chrome exited before ready: ' + (launchError || browser.exitCode) + '\n' + diagnostics);
    try {
      const [candidate] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^[0-9]+$/.test(candidate)) {
        const response = await fetch(`http://127.0.0.1:${candidate}/json/version`, {signal: AbortSignal.timeout(1000)});
        if (response.ok) { port = candidate; break; }
      }
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
  assert.equal(await evaluate('document.querySelectorAll("[data-plan-header]").length'),plans.length,'one column per plan');
  assert.equal(await evaluate('document.querySelectorAll(".minimum-card").length'),plans.length,'one minimum card per plan');
  assert.equal(await evaluate('document.querySelector("#refresh")===null && document.querySelector("#plan")===null && document.querySelector("#status")===null'),true,'legacy reload and filters removed');
  assert.ok(expected.markets.some(m=>m.code==='us'&&m.offers.length),'US source present');

  await evaluate(`document.querySelector('#searchInput').value='us';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  await until(()=>evaluate('document.querySelectorAll("#priceRows tr[data-market-id]").length===1'),'US filter');
  assert.ok(await evaluate(`document.querySelector('#priceRows').textContent.includes('美国')`));
  assert.equal(await evaluate(`document.querySelector('#priceRows tr[data-market-id="us"] td:nth-child(2) a')===null`),true,'country is not an App Store link');
  const usPlus=expected.markets.find(m=>m.code==='us').offers.find(o=>o.label==='ChatGPT Plus');
  if(usPlus?.amounts.length>1) {
    assert.ok(await evaluate(`document.querySelector('#priceRows tr[data-market-id="us"] [data-plan="ChatGPT Plus"]').textContent.includes('$19.99') && document.querySelector('#priceRows tr[data-market-id="us"] [data-plan="ChatGPT Plus"]').textContent.includes('$200.00')`),'all same-plan variants stay in one cell');
  }

  await evaluate(`document.querySelector('#priceRows tr[data-market-id="us"] .country-history-button').click()`);
  await until(()=>evaluate('document.querySelector("#historyDialog").open'),'history dialog');
  assert.equal(await evaluate(`document.querySelector('#historyTitle').textContent`),'美国','history opens for country');
  assert.ok(await evaluate(`document.querySelector('#historyRows').children.length >= 1`),'history has at least current observation');
  if(usPlus?.amounts.length>1) assert.ok(await evaluate(`document.querySelector('#historyLocalPrice').textContent.includes('$19.99') && document.querySelector('#historyLocalPrice').textContent.includes('$200.00')`),'history current price preserves variants');
  await evaluate(`document.querySelector('#closeHistory').click()`);

  await evaluate(`document.querySelector('#searchInput').value='<img src=x onerror=alert(1)>';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelector('#emptyState').hidden`),false,'empty search state');
  assert.equal(await evaluate(`document.querySelectorAll('#priceRows img').length`),0,'search never becomes HTML');
  await evaluate(`document.querySelector('#searchInput').value='';document.querySelector('#searchInput').dispatchEvent(new Event('input'))`);

  const enabledMinimum=await evaluate(`document.querySelector('.minimum-card:not(:disabled)')?.dataset.marketId || ''`);
  assert.ok(enabledMinimum,'minimum card available');
  await evaluate(`document.querySelector('.minimum-card:not(:disabled)').click()`);
  await until(()=>evaluate(`document.querySelector('#priceRows tr.is-highlighted')!==null`),'minimum card row focus');

  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(150);
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on narrow screens');
  assert.equal(await evaluate(`[...document.querySelectorAll('#priceRows tr[data-market-id]')].every(row => [...row.querySelectorAll('td[data-plan]')].filter(td => getComputedStyle(td).display !== 'none').length === 1)`),true,'mobile shows one active plan column');
  if(process.env.SCREENSHOT) {
    const result=await command('Page.captureScreenshot',{format:'png'});
    await writeFile(process.env.SCREENSHOT,Buffer.from(result.data,'base64'));
  }

  await command('Emulation.setScriptExecutionDisabled',{value:true});
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate(`document.querySelectorAll('#priceRows tr[data-market-id]').length>0`),'no-JS static matrix');
  assert.equal(await evaluate(`document.querySelector('.country-history-button').disabled`),true,'no-JS country history is safely disabled');
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
