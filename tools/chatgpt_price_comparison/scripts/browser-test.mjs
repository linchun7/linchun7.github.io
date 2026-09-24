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
const browser = spawn(chrome, ['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`], {stdio:['ignore','ignore','pipe']});
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
  const endpoint = await new Promise((resolve,reject) => {
    const timer=setTimeout(()=>reject(Error('Chrome did not start')),15000); let text='';
    browser.stderr.on('data', chunk=>{text+=chunk;const found=text.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(found){clearTimeout(timer);resolve(found[1]);}});
    browser.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  const origin=new URL(endpoint).origin.replace('ws:', 'http:');
  const tab=await (await fetch(origin+'/json/new?about:blank',{method:'PUT'})).json();
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  socket.addEventListener('message', ({data}) => {const m=JSON.parse(data), p=pending.get(m.id);if(m.method === 'Runtime.exceptionThrown') console.error('PAGE ERROR',JSON.stringify(m.params));if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  await command('Page.enable'); await command('Runtime.enable'); await command('Network.enable');
  const url='http://127.0.0.1:4177/tools/chatgpt_price_comparison/';
  await until(async()=> (await fetch(url)).ok,'HTTP server');
  await command('Page.navigate',{url});
  await until(()=>evaluate('document.querySelector("#filters") && !document.querySelector("#filters").hidden && document.querySelectorAll("#price-rows tr").length > 0'),'interactive table');
  await until(()=>evaluate('!document.querySelector("#refresh").disabled'),'initial JSON refresh');
  assert.equal(await evaluate('document.querySelector("#health").textContent.includes("重新加载未成功")'),false,'valid JSON hash passes');
  const expected=JSON.parse(await readFile(path.join(root,'tools/chatgpt_price_comparison/data/prices.json'),'utf8'));
  assert.ok(expected.markets.some(m=>m.code==='us'&&m.offers.length),'US source present');
  await evaluate(`document.querySelector('#search').value='us';document.querySelector('#search').dispatchEvent(new Event('input'))`);
  assert.ok(await evaluate(`document.querySelector('#price-rows').textContent.includes('美国')`));
  if(expected.markets.find(m=>m.code==='us').offers.find(o=>o.label==='ChatGPT Plus')?.amounts.length>1) assert.ok(await evaluate(`document.querySelector('#price-rows').textContent.includes('多个同名标价')`),'all duplicate-label variants visible');
  await evaluate(`document.querySelector('#search').value='<img src=x onerror=alert(1)>';document.querySelector('#search').dispatchEvent(new Event('input'))`);
  assert.equal(await evaluate(`document.querySelector('#empty').hidden`),false,'empty search state');
  assert.equal(await evaluate(`document.querySelectorAll('#price-rows img').length`),0,'search never becomes HTML');
  await evaluate(`document.querySelector('#search').value='';document.querySelector('#plan').value='';document.querySelector('#search').dispatchEvent(new Event('input'))`);
  await command('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),'no body overflow on narrow screens');
  if(process.env.SCREENSHOT) {
    const result=await command('Page.captureScreenshot',{format:'png'});
    await writeFile(process.env.SCREENSHOT,Buffer.from(result.data,'base64'));
  }
  await evaluate(`Date.now=()=>${Date.parse(expected.generated_at)+8*86400e3};document.querySelector('#search').dispatchEvent(new Event('input'))`);
  assert.ok(await evaluate(`document.querySelector('#health').textContent.includes('过期')`),'expired publication visibly degraded');
  assert.equal(await evaluate(`[...document.querySelectorAll('#price-rows tr')].filter(r=>r.children.length===5).every(r=>!r.children[3].textContent.includes('¥'))`),true,'expired FX and prices do not convert');
  await command('Network.setBlockedURLs',{urls:['*data/prices.json*']});
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate(`document.querySelector('#health')?.textContent.includes('重新加载未成功')`),'offline fallback');
  assert.ok(await evaluate(`document.querySelectorAll('#price-rows tr').length>0`),'offline table remains readable');
  await command('Emulation.setScriptExecutionDisabled',{value:true});
  await command('Page.reload',{ignoreCache:true});
  await until(()=>evaluate(`document.querySelector('#filters')?.hidden && document.querySelectorAll('#price-rows tr').length>0`),'no-JS static table');
  console.log('Browser tests passed: JSON integrity, filters, duplicate prices, empty state, XSS input, mobile layout, expiry, offline fallback, no-JS.');
} catch(error) {
  if (socket?.readyState === 1) console.error('PAGE STATE',await evaluate('({url:location.href,health:document.querySelector("#health")?.textContent,filters:document.querySelector("#filters")?.hidden,body:document.body?.textContent.slice(0,1200)})'));
  throw error;
} finally {
  socket?.close(); browser.kill('SIGTERM'); server.kill('SIGTERM');
  for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Browser closed'));}
  await delay(300); await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200});
}
