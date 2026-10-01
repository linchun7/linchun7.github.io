#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { identity, offerFor, plansFor } from './browser-oracle.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
assert.ok(browserType, 'Unsupported PLAYWRIGHT_BROWSER');

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptsDir, '..');
const repoRoot = resolve(projectDir, '../..');
const port = 4181;
const url = `http://127.0.0.1:${port}/tools/chatgpt_price_comparison/`;
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', repoRoot], {
  stdio: ['ignore', 'ignore', 'inherit']
});

const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
async function waitForServer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('local static server did not start');
}

let browser;
try {
  await waitForServer();
  browser = await browserType.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#minimumHistoryButton')?.disabled === false);

  assert.equal(await page.locator('#overviewTitle').textContent(), '各套餐全球最低价');
  assert.equal(await page.locator('#priceWorkspace .workspace-heading h2').textContent(), '全球 ChatGPT App Store 标价');

  await page.locator('#minimumHistoryButton').click();
  await page.waitForSelector('#minimumHistoryDialog[open]');
  await page.waitForFunction(() => {
    const list = document.querySelector('#minimumHistoryEvents');
    const retry = document.querySelector('#minimumHistoryRetry');
    return (list?.textContent?.trim().length ?? 0) > 0 || retry?.hidden === false;
  });
  assert.equal(await page.locator('#minimumHistoryRetry').isHidden(), true);
  assert.match(await page.locator('#minimumHistoryEvents').textContent(), /暂无最低价变更记录|→/);
  assert.equal(await page.locator('#minimumHistoryNote').isHidden(), false);
  await page.locator('#closeMinimumHistory').click();



  // A self-consistent future cutoff must not poison rollback protection.
  const acceptedText = await page.locator('#minimumHistoryEvents').textContent();
  const acceptedCutoff = await page.locator('#minimumHistoryStatus').textContent();
  const futureHistory = JSON.parse(await readFile(resolve(projectDir, 'data/minimum-history.json'), 'utf8'));
  assert.ok(futureHistory.checkpoint, 'future-cutoff regression needs an accepted checkpoint');
  futureHistory.checked_at = new Date(Date.now() + 86400000).toISOString();
  futureHistory.checkpoint.at = futureHistory.checked_at;
  await page.route('**/data/minimum-history.json*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(futureHistory)
  }));
  await page.locator('#minimumHistoryButton').click();
  await page.evaluate(() => document.querySelector('#minimumHistoryRetry').click());
  await page.waitForFunction(() => document.querySelector('#minimumHistoryStatus').textContent.includes('暂无法刷新'));
  assert.equal(await page.locator('#minimumHistoryEvents').textContent(), acceptedText);
  assert.equal(await page.locator('#minimumHistoryStatus').textContent(), acceptedCutoff + ' · 暂无法刷新');
  await page.unroute('**/data/minimum-history.json*');
  await page.locator('#minimumHistoryRetry').click();
  await page.waitForFunction(() => document.querySelector('#minimumHistoryRetry').hidden
    && !document.querySelector('#minimumHistoryRetry').disabled);
  assert.equal(await page.locator('#minimumHistoryStatus').textContent(), acceptedCutoff);
  assert.equal(await page.locator('#minimumHistoryEvents').textContent(), acceptedText);
  await page.locator('#closeMinimumHistory').click();


  const inconsistentHistory = JSON.parse(await readFile(resolve(projectDir, 'data/minimum-history.json'), 'utf8'));
  const changedEvent = inconsistentHistory.events.find(event => event.kind === 'change');
  assert.ok(changedEvent, 'cause-consistency regression needs a real change event');
  changedEvent.cause = changedEvent.cause === 'fx' ? 'storefront' : 'fx';
  await page.route('**/data/minimum-history.json*', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify(inconsistentHistory)
  }));
  await page.locator('#minimumHistoryButton').click();
  await page.evaluate(() => document.querySelector('#minimumHistoryRetry').click());
  await page.waitForFunction(() => document.querySelector('#minimumHistoryStatus').textContent.includes('暂无法刷新'));
  assert.equal(await page.locator('#minimumHistoryEvents').textContent(), acceptedText, 'conflicting cause cannot replace accepted history');
  assert.equal(await page.locator('#minimumHistoryStatus').textContent(), acceptedCutoff + ' · 暂无法刷新');
  await page.unroute('**/data/minimum-history.json*');
  await page.locator('#minimumHistoryRetry').click();
  await page.waitForFunction(() => document.querySelector('#minimumHistoryRetry').hidden
    && !document.querySelector('#minimumHistoryRetry').disabled);
  assert.equal(await page.locator('#minimumHistoryEvents').textContent(), acceptedText);
  assert.equal(await page.locator('#minimumHistoryStatus').textContent(), acceptedCutoff);
  await page.locator('#closeMinimumHistory').click();

  const priceData = JSON.parse(await readFile(resolve(projectDir, 'data/prices.json'), 'utf8'));
  const us = priceData.markets.find(market => market.code === 'us');
  assert.ok(us?.history_baseline, 'US country history must retain an observed baseline');
  const countryEvents = [us.history_baseline, ...priceData.changes.filter(change => change.code === 'us')
    .map(change => ({at: change.at, snapshot: change.after}))];
  await page.locator('#priceRows tr[data-market-id="us"] .country-history-button').click();
  await page.waitForSelector('#historyDialog[open]');
  for (const wanted of ['ChatGPT Plus', 'ChatGPT Pro 5x', 'ChatGPT Pro 500']) {
    const currentOffer = us.offers.find(offer => identity(offer.label) === identity(wanted));
    if (!currentOffer) continue;
    const representative = plansFor(priceData).find(plan => identity(plan) === identity(wanted));
    assert.ok(representative, 'global display representative must exist for a current plan');
    await page.locator('#historyPlanControl button[data-plan=' + JSON.stringify(representative) + ']').click();
    const expected = [];
    let previousKey = null;
    for (const event of countryEvents) {
      const offer = offerFor(event.snapshot, wanted);
      if (!expected.length && !offer) continue;
      const key = event.snapshot.currency + '|' + (offer ? offer.amounts.join('/') : '--');
      if (key !== previousKey) expected.push(event);
      previousKey = key;
    }
    const expectedTime = await page.evaluate(at => at === null ? '时间未记录' : new Date(at).toLocaleString('zh-CN', {
      timeZone:'Asia/Shanghai',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'
    }), expected[0].at);
    const rows = page.locator('#historyRows tr');
    assert.equal(await rows.count(), expected.length);
    assert.equal(await rows.last().locator('td').first().textContent(), expectedTime);
    assert.notEqual(await rows.last().locator('td').nth(2).textContent(), '—', 'leading absence is not an observed price');
    assert.equal(await page.locator('#historyEventCount').textContent(), Math.max(0, expected.length - 1) + ' 次');
  }
  await page.locator('#closeHistory').click();

  await page.setViewportSize({ width: 641, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.locator('.data-status').evaluate(el => getComputedStyle(el).whiteSpace), 'normal');

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  const share = await page.evaluate(() => {
    const table = document.querySelector('.price-table').getBoundingClientRect();
    const country = document.querySelector('#priceRows tr[data-market-id] td:nth-child(2)').getBoundingClientRect();
    return country.width / table.width;
  });
  assert.ok(share >= 0.46 && share <= 0.49, `country column share out of range: ${share}`);

  await page.locator('button[data-sort="country"]').click();
  assert.equal(await page.locator('#priceRows .mobile-rank').first().textContent(), '序1');
  const geometry = await page.evaluate(() => {
    const row = document.querySelector('#priceRows tr[data-market-id]');
    const name = row.querySelector('.country-name').getBoundingClientRect();
    const sub = row.querySelector('.country-name-en').getBoundingClientRect();
    const rank = row.querySelector('.mobile-rank').getBoundingClientRect();
    return { nameBottom: name.bottom, subTop: sub.top, rankTop: rank.top };
  });
  assert.ok(geometry.rankTop >= geometry.nameBottom - 1);
  assert.ok(Math.abs(geometry.rankTop - geometry.subTop) <= 4);

  await page.setViewportSize({ width: 320, height: 568 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);


  // Optional icon delivery must never gate validated prices or controls.
  for (const mode of ['pending', 'failed', 'malformed']) {
    const isolated = await browser.newContext();
    const iconPage = await isolated.newPage();
    const errors = [];
    iconPage.on('pageerror', error => errors.push(error.message));
    let releaseIcons;
    const held = new Promise(resolve => { releaseIcons = resolve; });
    let requested = false;
    await iconPage.route('**/vendor/lucide-subset.js?v=*', async route => {
      requested = true;
      if (mode === 'failed') return route.abort();
      if (mode === 'malformed') return route.fulfill({ contentType: 'text/javascript', body: 'export {' });
      await held;
      return route.continue();
    });
    try {
      await iconPage.goto(url, { waitUntil: 'commit' });
      await iconPage.waitForFunction(() => document.querySelector('.country-history-button:not(:disabled)'));
      assert.equal(requested, true, mode + ': icon delivery was intercepted');
      await iconPage.locator('#searchInput').fill('美国');
      await iconPage.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length === 1);
      assert.equal(await iconPage.locator('#priceRows tr').getAttribute('data-market-id'), 'us');
      await iconPage.locator('button[data-sort="country"]').click();
      await iconPage.locator('#priceRows .country-history-button').click();
      await iconPage.waitForSelector('#historyDialog[open]');
      await iconPage.locator('#closeHistory').click();
      await iconPage.locator('#minimumHistoryButton').click();
      await iconPage.waitForSelector('#minimumHistoryDialog[open]');
      await iconPage.waitForFunction(() => document.querySelector('#minimumHistoryEvents').textContent.trim().length > 0);
      await iconPage.locator('#closeMinimumHistory').click();
      if (mode === 'pending') {
        assert.equal(await iconPage.locator('.search-field svg').count(), 0);
        releaseIcons();
        await iconPage.waitForSelector('.search-field svg');
        assert.equal(await iconPage.locator('#searchInput').inputValue(), '美国');
        assert.equal(await iconPage.locator('#priceRows tr[data-market-id]').count(), 1);
        assert.equal(await iconPage.locator('#rankHeaderLabel > [aria-hidden="true"]').textContent(), '序号');
      }
      assert.deepEqual(errors, [], mode + ': no uncaught optional-icon error');
    } finally {
      releaseIcons();
      await isolated.close();
    }
  }

  const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const noJsPage = await noJs.newPage();
  await noJsPage.goto(url, { waitUntil: 'domcontentloaded' });
  assert.ok(await noJsPage.locator('#priceRows tr[data-market-id]').count() > 0);
  assert.equal(await noJsPage.locator('.country-history-button').first().isDisabled(), true);
  await noJs.close();

  console.log(`Cross-browser smoke passed: ${browserName}`);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
