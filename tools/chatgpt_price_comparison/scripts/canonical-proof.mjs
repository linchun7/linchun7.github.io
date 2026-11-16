import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = 'proof-output';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const report = { checkedAt: new Date().toISOString(), sourceCommit: process.env.SOURCE_COMMIT, cases: [] };
const root = 'https://www.linchun.com.cn/tools/';
try {
  for (const [label, width, height] of [['desktop',1280,900], ['mobile',390,844]]) {
    const page = await browser.newPage({ viewport:{width,height}, deviceScaleFactor:1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const response = await page.goto(root + 'chatgpt_price_comparison/', {waitUntil:'networkidle'});
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => !document.querySelector('#searchInput').disabled);
    const expectedHtml = await readFile('index.html', 'utf8');
    const expectedRevision = expectedHtml.match(/name="chatgpt-page-revision" content="([^"]+)"/)[1];
    assert.equal(await page.locator('meta[name="chatgpt-page-revision"]').getAttribute('content'), expectedRevision);
    const data = await page.locator('#price-data').evaluate(n => JSON.parse(n.textContent));
    const market = data.markets.find(m => m.offers.some(o => o.amounts.length > 1));
    assert.ok(market, 'production snapshot includes multiple public prices');
    const offer = market.offers.find(o => o.amounts.length > 1);
    const disclaimer = page.locator('.data-disclaimer');
    assert.match(await disclaimer.textContent(), /主表展示同名套餐的最低公开标价/);
    await disclaimer.scrollIntoViewIfNeeded();
    await page.screenshot({path:output+'/chatgpt-pricing-note-'+label+'.png'});
    await page.locator('tr[data-market-id="'+market.code+'"] .country-history-button').click();
    await page.locator('#historyPlanControl button').filter({hasText:offer.label.replace(/^ChatGPT /,'')}).click();
    await page.locator('#historyVariantNote').waitFor({state:'visible'});
    assert.match(await page.locator('#historyVariantNote').textContent(), /同名套餐有多个公开标价/);
    for (const amount of offer.amounts) assert.ok((await page.locator('#historyLocalPrice').textContent()).includes(amount.display));
    await page.screenshot({path:output+'/chatgpt-price-variants-'+label+'.png'});
    await page.keyboard.press('Escape');
    const closeResult = await page.locator('#historyDialog').evaluate(n => !n.open);
    assert.ok(closeResult);
    await page.locator('#searchInput').fill('美国');
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
    assert.equal(await page.locator('#priceRows tr').getAttribute('data-market-id'), 'us');
    await page.locator('#searchInput').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 1);
    await page.locator('.minimum-card:not(:disabled)').last().click();
    const share = page.url();
    assert.ok(new URL(share).searchParams.get('plan'));
    await page.reload({waitUntil:'networkidle'});
    await page.waitForFunction(() => !document.querySelector('#searchInput').disabled);
    assert.equal(await page.locator('#mobilePlanControl [aria-pressed="true"]').getAttribute('data-plan'), new URL(share).searchParams.get('plan'));
    assert.deepEqual(errors, []);
    report.cases.push({project:'ChatGPT',label,url:root+'chatgpt_price_comparison/',pageRevision:expectedRevision,dataRevision:data.revision,market:market.name,plan:offer.label,prices:offer.amounts.map(a=>a.display),screenshot:'production DOM without injected content',checks:['canonical revision','disclaimer','all price variants','close','search','share/reload'],errors});
    await page.close();
  }
  for (const [label,width,height] of [['desktop',1280,900],['mobile',390,844]]) {
    const page = await browser.newPage({viewport:{width,height}});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const response=await page.goto(root+'icloud_price_comparison/',{waitUntil:'networkidle'});
    assert.equal(response.status(),200);
    await page.waitForFunction(()=>!document.querySelector('#searchInput').disabled);
    const count=await page.locator('#priceRows tr[data-market-id]').count();
    assert.ok(count>100);
    await page.locator('#searchInput').fill('美国');
    await page.waitForFunction(()=>document.querySelectorAll('#priceRows tr[data-market-id]').length===1);
    await page.locator('.country-history-button').first().click();
    await page.locator('#historyDialog').waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('#historySubtitle').textContent.includes('记录自'));
    assert.match(await page.locator('#historyEventCount').textContent(), /次/);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#historyDialog').evaluate(n=>n.open),false);
    assert.deepEqual(errors,[]);
    report.cases.push({project:'iCloud',label,url:page.url(),count,checks:['canonical loaded','search','real history loaded','close'],errors});
    await page.close();
  }
} catch(error) {
  report.failure = {message:error.message,stack:error.stack};
  throw error;
} finally {
  await writeFile(output+'/verification.json',JSON.stringify(report,null,2));
  console.log('CANONICAL_BROWSER_PROOF '+JSON.stringify(report));
  await browser.close();
}
