import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { prepareUpdaterBrowser } from '../scripts/prepare-updater-browser.mjs';
test('local test commands never install browser or operating-system dependencies', async () => {
  assert.equal(await prepareUpdaterBrowser({githubActions:false,run:()=>{throw Error('must not install');}}),false);
});
test('Actions installs the complete pinned bundle once and verifies its executable', async () => {
  let calls=0,checked=0;
  assert.equal(await prepareUpdaterBrowser({githubActions:true,run:(command,args,options)=>{
    calls++; assert.equal(command,'pnpm');
    assert.deepEqual(args,['exec','playwright','install','--with-deps','chromium']);
    assert.equal(options.timeout,180000); return {status:0};
  },check:async()=>{checked++;}}),true);
  assert.equal(calls,1); assert.equal(checked,1);
});
test('failed, interrupted or timed-out setup never proceeds to UI verification', async () => {
  for(const result of [{status:1},{status:null,signal:'SIGTERM'},{status:null,error:new Error('timeout')}]){
    let checked=false;
    await assert.rejects(prepareUpdaterBrowser({githubActions:true,run:()=>result,check:async()=>{checked=true;}}),/setup failed/);
    assert.equal(checked,false);
  }
});
test('reported install success without an executable still fails', async () => {
  await assert.rejects(prepareUpdaterBrowser({githubActions:true,run:()=>({status:0}),check:async()=>{throw Error('missing binary');}}),/missing binary/);
});

for (const late of ['resolve', 'reject']) test('aborted launch cannot contaminate its successor: late ' + late, async () => {
  const source = await readFile(new URL('./ui-smoke.test.mjs', import.meta.url), 'utf8');
  const match = source.match(/function sharedBrowserType\(browserType\) \{[\s\S]*?\n\}(?=\n\nasync function createServer)/);
  assert.ok(match);
  const factory = runInNewContext('let sharedBrowserPromise = null; (' + match[0] + ')', {console});
  const waiting = [];
  const shared = factory({launch:()=>new Promise((resolve,reject)=>waiting.push({resolve,reject}))});
  let closedA=0,closedB=0;
  const browserA={version:()=> 'A',close:async()=>{closedA++;}};
  const browserB={version:()=> 'B',close:async()=>{closedB++;}};
  const controller = new AbortController();
  const first = shared.launch({signal:controller.signal});
  controller.abort(new Error('cancel A'));
  const rejected = assert.rejects(first);
  const second = shared.launch({});
  assert.equal(waiting.length,2,'B must not reuse the still-aborting A');
  waiting[1].resolve(browserB);
  assert.equal((await second).version(),'B');
  if(late==='resolve') waiting[0].resolve(browserA);
  else waiting[0].reject(new Error('late A failure'));
  await rejected;
  assert.equal(closedA,late==='resolve'?1:0);
  assert.equal(closedB,0);
  assert.equal((await shared.launch({})).version(),'B');
  assert.equal(waiting.length,2,'settling A must not erase B from the cache');
});
