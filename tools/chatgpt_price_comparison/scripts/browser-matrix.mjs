#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { assertMinimumComparison } from './minimum-comparison-browser.mjs';
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


async function assertCountryHistoryFocus(page, { touch = false, outlineOffset }) {
  const trigger = page.locator('.country-history-button:not(:disabled)').first();
  const close = page.locator('#closeHistory');
  const activate = locator => touch ? locator.tap() : locator.click();
  const settled = async () => {
    await page.waitForFunction(() => !document.querySelector('#historyDialog').open
      && document.activeElement?.matches('.country-history-button'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  const assertRing = async (visible, scenario) => {
    const result = await trigger.evaluate(button => {
      const style = getComputedStyle(button);
      return { focused: document.activeElement === button, style: style.outlineStyle,
        width: style.outlineWidth, offset: style.outlineOffset,
        pointerMode: document.documentElement.hasAttribute('data-country-history-pointer') };
    });
    assert.equal(result.focused, true, 'closing history retains semantic trigger focus');
    assert.equal(result.pointerMode, !visible, scenario || 'latest input mode is preserved');
    if (visible) {
      assert.equal(result.style, 'solid', 'keyboard focus remains visibly outlined');
      assert.equal(result.width, '2px');
      assert.equal(result.offset, outlineOffset);
    } else {
      assert.equal(result.style, 'none', 'pointer return must not retain the inherited blue ring');
    }
  };

  // A text input is deliberately focused first: its native visible focus can
  // propagate through showModal()/close() even when the next action is a click.
  await page.locator('#searchInput').focus();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await activate(trigger);
    await page.waitForSelector('#historyDialog[open]');
    await activate(close);
    await settled();
    await assertRing(false);

    // The reported regression: Escape must not turn a pointer-only
    // history session into keyboard navigation, even after repeated opens.
    await activate(trigger);
    await page.waitForSelector('#historyDialog[open]');
    await page.keyboard.press('Escape');
    await settled();
    await assertRing(false, 'pointer open + Escape remains pointer mode');
    await page.keyboard.press('Shift');
    await page.keyboard.press('Escape');
    await assertRing(false, 'modifiers and dismissal do not start keyboard navigation');
  }

  // Browser/system shortcuts alone do not start page keyboard navigation.
  for (const shortcut of ['Control+c', 'Meta+c', 'Alt+c']) {
    await activate(trigger);
    await page.waitForSelector('#historyDialog[open]');
    await page.keyboard.press(shortcut);
    assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-country-history-pointer')), true,
      shortcut + ' preserves pointer presentation');
    await page.keyboard.press('Escape');
    await settled();
    await assertRing(false);
  }
  // Ordinary keys remove the custom suppression; native button focus-visible
  // need not change for a letter alone. Real Tab/activation visibility is tested below.
  await page.keyboard.press('a');
  assert.deepEqual(await trigger.evaluate(button => ({ focused: document.activeElement === button,
    pointerMode: document.documentElement.hasAttribute('data-country-history-pointer') })),
  { focused: true, pointerMode: false }, 'ordinary input removes custom suppression without moving focus');

  // A click on the country label bubbles to its semantic history button.
  // Unlike iCloud, this page does not make price cells history triggers.
  await activate(trigger.locator('.country-name'));
  await page.waitForSelector('#historyDialog[open]');
  await activate(close);
  await settled();
  await assertRing(false);

  // Direct activation from the retained pointer focus is a real keyboard
  // action; a preceding Tab is not required to restore its indicator.
  for (const key of ['Enter', 'Space']) {
    await activate(trigger);
    await page.waitForSelector('#historyDialog[open]');
    await page.keyboard.press('Escape');
    await settled();
    await assertRing(false);
    await page.keyboard.press(key);
    await page.waitForSelector('#historyDialog[open]');
    await page.keyboard.press('Escape');
    await settled();
    await assertRing(true, key + ' activation + Escape remains keyboard mode');
  }

  // Tab and Shift+Tab restore the current control's visible indicator
  // after an earlier pointer-only session.
  await activate(trigger);
  await page.waitForSelector('#historyDialog[open]');
  await page.keyboard.press('Escape');
  await settled();
  await assertRing(false);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await assertRing(true);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#historyDialog[open]');
  await page.keyboard.press('Escape');
  await settled();
  await assertRing(true);

  await activate(trigger);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#historyDialog').evaluate(dialog => dialog.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');
  await settled();
  await assertRing(true);

  // The most recent navigation/activation wins, not just the opener.
  // A pointer interaction inside a keyboard-opened dialog switches back.
  await page.keyboard.press('Enter');
  await page.waitForSelector('#historyDialog[open]');
  await activate(page.locator('#historyTitle'));
  assert.equal(await page.locator('#historyDialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  await settled();
  await assertRing(false, 'keyboard open + pointer interaction + Escape remains pointer mode');

  // Pointer -> keyboard -> pointer -> Escape follows the last pointer,
  // while a further Tab before Escape restores keyboard presentation.
  for (const resumeKeyboard of [false, true]) {
    await activate(trigger);
    await page.waitForSelector('#historyDialog[open]');
    await page.keyboard.press('Tab');
    await activate(page.locator('#historyTitle'));
    assert.equal(await page.locator('#historyDialog').evaluate(dialog => dialog.open), true);
    if (resumeKeyboard) await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await settled();
    await assertRing(resumeKeyboard, 'mixed input follows the latest real navigation/activation');
  }

  // Keyboard activation of the close button must keep a visible return ring.
  await page.keyboard.press('Enter');
  await page.waitForSelector('#historyDialog[open]');
  await close.focus();
  await page.keyboard.press('Enter');
  await settled();
  await assertRing(true);

  // Switching back to pointer input must not leave keyboard styling sticky.
  await activate(trigger);
  await activate(close);
  await settled();
  await assertRing(false);

  // Assistive/synthetic activation may have no pointerdown or keydown. Start
  // from text-input focus, which provides a visible native focus baseline.
  await page.locator('#searchInput').focus();
  assert.equal(await page.locator('#searchInput').evaluate(input => getComputedStyle(input).outlineStyle),
    'solid', 'pointer suppression leaves other controls visibly focusable');
  await trigger.evaluate(button => button.click());
  await page.waitForSelector('#historyDialog[open]');
  await page.keyboard.press('Escape');
  await settled();
  await assertRing(true, 'detail=0 activation + Escape remains keyboard/assistive mode');

  // A detail=0 close clears pointer suppression and retains real focus;
  // it cannot by itself guarantee the browser's native :focus-visible.
  await activate(trigger);
  await page.waitForSelector('#historyDialog[open]');
  await close.evaluate(button => button.click());
  await settled();
  assert.deepEqual(await trigger.evaluate(button => ({
    focused: document.activeElement === button,
    pointerMode: document.documentElement.hasAttribute('data-country-history-pointer')
  })), { focused: true, pointerMode: false }, 'detail=0 close clears pointer mode and retains trigger focus');

  // With a visible text-input baseline, assistive open and close preserve
  // the native indicator as in the existing accessibility regression.
  await page.locator('#searchInput').focus();
  await trigger.evaluate(button => button.click());
  await page.waitForSelector('#historyDialog[open]');
  await close.evaluate(button => button.click());
  await settled();
  await assertRing(true, 'detail=0 open and close preserve the native visible baseline');

  if (!touch) {
    // Click the actual backdrop outside the dialog rectangle, not a rounded
    // border corner (which has different hit testing between browser engines).
    await trigger.click();
    const bounds = await page.locator('#historyDialog').boundingBox();
    assert.ok(bounds && bounds.x > 2, 'desktop dialog leaves a clickable backdrop');
    const point = { x: bounds.x / 2, y: bounds.y + bounds.height / 2 };
    const viewport = page.viewportSize();
    assert.ok(viewport && point.x > 0 && point.x < viewport.width
      && point.y > 0 && point.y < viewport.height, 'backdrop point is inside the viewport');
    assert.ok(point.x < bounds.x, 'backdrop point is outside the dialog rectangle');
    await page.evaluate(() => {
      document.addEventListener('click', event => {
        globalThis.__historyBackdropTarget = event.target.id;
      }, { once: true, capture: true });
    });
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.evaluate(() => globalThis.__historyBackdropTarget), 'historyDialog',
      'native backdrop click must target the history dialog');
    await settled();
    await assertRing(false);
  }

}


async function assertMinimumHistoryReuse(browser, priceData) {
  const committedHistory = JSON.parse(await readFile(resolve(projectDir, 'data/minimum-history.json'), 'utf8'));
  const generatedAt = Date.parse(priceData.generated_at);
  assert.ok(committedHistory.checkpoint, 'reuse regression needs an accepted minimum-history checkpoint');
  for (const mode of ['unchecked', 'older', 'same', 'newer', 'same-offset']) {
    const isolated = await browser.newContext();
    const page = await isolated.newPage();
    const history = structuredClone(committedHistory);
    if (['unchecked', 'older'].includes(mode)) {
      Object.assign(history, {
        checked_at: mode === 'older' ? new Date(generatedAt - 60000).toISOString() : null,
        checkpoint: null, first_observed_at: null, events: [], gaps: [], observations: 0, pending_gap: false
      });
    } else {
      const checkedAt = generatedAt + (mode === 'newer' ? 600000 : 0);
      const stamp = mode === 'same-offset'
        ? new Date(checkedAt + 8 * 3600000).toISOString().replace('Z', '+08:00')
        : new Date(checkedAt).toISOString();
      history.checked_at = stamp;
      history.checkpoint.at = stamp;
    }
    await page.addInitScript(now => {
      Date.now = () => now;
      const originalFetch = globalThis.fetch;
      globalThis.__minimumHistoryFetches = 0;
      globalThis.fetch = (input, init) => {
        if (new URL(input.url || input, location.href).pathname.endsWith('/minimum-history.json')) {
          globalThis.__minimumHistoryFetches++;
        }
        return originalFetch(input, init);
      };
    }, generatedAt + 3600000);
    await page.route('**/data/minimum-history.json*', route => route.fulfill({ json: history }));
    const calls = () => page.evaluate(() => globalThis.__minimumHistoryFetches);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !document.querySelector('#minimumHistoryButton').disabled);
      assert.equal(await calls(), 0, mode + ': startup leaves history on demand');
      await page.locator('#minimumHistoryButton').click();
      await page.waitForFunction(() => !document.querySelector('#minimumHistoryRetry').disabled
        && !document.querySelector('#minimumHistoryNote').hidden);
      const records = await page.locator('#minimumHistoryEvents').textContent();
      const cutoff = await page.locator('#minimumHistoryStatus').textContent();
      assert.equal(await calls(), 1);
      await page.locator('#closeMinimumHistory').click();
      await page.locator('#minimumHistoryButton').click();
      await page.waitForFunction(() => !document.querySelector('#minimumHistoryRetry').disabled);
      const expectedCalls = ['unchecked', 'older'].includes(mode) ? 2 : 1;
      assert.equal(await calls(), expectedCalls, mode + ': only unchecked/older history is read again');
      assert.equal(await page.locator('#minimumHistoryEvents').textContent(), records);
      assert.equal(await page.locator('#minimumHistoryStatus').textContent(), cutoff);
      if (mode === 'newer') {
        await isolated.setOffline(true);
        for (let reopen = 0; reopen < 2; reopen++) {
          await page.locator('#closeMinimumHistory').click();
          await page.locator('#minimumHistoryButton').click();
          assert.equal(await calls(), 1, 'offline reopen reuses the accepted later history');
          assert.equal(await page.locator('#minimumHistoryStatus').textContent(), cutoff);
        }
        await page.locator('#closeMinimumHistory').click();
        await page.evaluate(now => { Date.now = () => now; }, generatedAt + 60000);
        await page.locator('#minimumHistoryButton').click();
        assert.equal(await page.locator('#minimumHistoryEvents').textContent(), '');
        assert.equal(await page.locator('#minimumHistoryStatus').textContent(), '记录时间异常');
        for (const id of ['minimumHistoryToolbar', 'minimumHistoryMore', 'minimumHistoryNote']) {
          assert.equal(await page.locator('#' + id).isHidden(), true, id + ': future evidence is hidden');
        }
        assert.equal(await calls(), 1, 'clock rollback is local and does not download history');
        await page.locator('#closeMinimumHistory').click();
        await page.evaluate(now => { Date.now = () => now; }, generatedAt + 3600000);
        await page.locator('#minimumHistoryButton').click();
        assert.equal(await page.locator('#minimumHistoryEvents').textContent(), records);
        assert.equal(await page.locator('#minimumHistoryStatus').textContent(), cutoff);
        assert.equal(await calls(), 1, 'corrected clock restores the same accepted records offline');
        await page.bringToFront();
        const priceDate = await page.locator('#updatedAt').textContent();
        for (const trigger of ["visibilitychange"]) {
          await page.locator('#minimumHistoryEvents > *').first().evaluate(node => { node.dataset.lifecycleKeep = 'true'; });
          await page.evaluate(type => {
            if (type === 'pageshow') window.dispatchEvent(new Event(type));
            else document.dispatchEvent(new Event(type));
          }, trigger);
          assert.equal(await page.locator('[data-lifecycle-keep]').count(), 1, trigger + ': unchanged history validity retains its DOM');
          await page.evaluate(({ now, type }) => {
            Date.now = () => now;
            if (type === 'pageshow') window.dispatchEvent(new Event(type));
            else document.dispatchEvent(new Event(type));
          }, { now: generatedAt + 60000, type: trigger });
          assert.equal(await page.locator('#minimumHistoryDialog').evaluate(dialog => dialog.open), true);
          assert.equal(await page.locator('#minimumHistoryEvents').textContent(), '');
          assert.equal(await page.locator('#minimumHistoryStatus').textContent(), '记录时间异常');
          for (const id of ['minimumHistoryToolbar', 'minimumHistoryMore', 'minimumHistoryNote']) {
            assert.equal(await page.locator('#' + id).isHidden(), true, trigger + ': future history projection is hidden');
          }
          assert.equal(await page.locator('#searchInput').isEnabled(), true, 'the older page snapshot remains time-valid');
          assert.equal(await page.locator('#updatedAt').textContent(), priceDate);
          assert.equal(await calls(), 1, trigger + ': rollback does not fetch');
          await page.evaluate(({ now, type }) => {
            Date.now = () => now;
            if (type === 'pageshow') window.dispatchEvent(new Event(type));
            else document.dispatchEvent(new Event(type));
          }, { now: generatedAt + 3600000, type: trigger });
          assert.equal(await page.locator('#minimumHistoryDialog').evaluate(dialog => dialog.open), true);
          assert.equal(await page.locator('#minimumHistoryEvents').textContent(), records);
          assert.equal(await page.locator('#minimumHistoryStatus').textContent(), cutoff);
          assert.equal(await calls(), 1, trigger + ': correction restores the open dialog offline');
        }
      }
    } finally { await isolated.close(); }
  }
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

  await assertMinimumComparison(page, projectDir);



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
  await assertMinimumHistoryReuse(browser, priceData);
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

  // Both script-free and missing-app delivery retain every static plan column.
  const staticPlans = plansFor(priceData);
  for (const width of [390, 960]) for (const mode of ['no-js', 'app-404']) {
    const fallback = await browser.newContext({
      javaScriptEnabled: mode !== 'no-js', viewport: { width, height: 844 }
    });
    const fallbackPage = await fallback.newPage();
    let missingAppRequests = 0;
    if (mode === 'app-404') await fallbackPage.route('**/app.js?v=*', route => {
      missingAppRequests += 1;
      return route.fulfill({ status: 404, contentType: 'text/javascript', body: '' });
    });
    try {
      await fallbackPage.goto(url, { waitUntil: 'load' });
      const label = `${browserName}/${mode}/${width}px`;
      const projection = await fallbackPage.evaluate(() => {
        const workspace = document.querySelector('#priceWorkspace');
        const scroll = workspace.querySelector('.table-scroll');
        return {
          ready: workspace.classList.contains('price-ui-ready'),
          overflowX: getComputedStyle(scroll).overflowX,
          bodyFits: document.documentElement.scrollWidth <= innerWidth + 1,
          pickerDisplay: getComputedStyle(workspace.querySelector('.mobile-plan-picker')).display,
          headers: [...workspace.querySelectorAll('th[data-plan-header]')].map(cell => ({
            plan: cell.dataset.plan, display: getComputedStyle(cell).display,
            width: cell.getBoundingClientRect().width
          })),
          rows: [...workspace.querySelectorAll('#priceRows tr[data-market-id]')].map(row => ({
            code: row.dataset.marketId, disabled: row.querySelector('.country-history-button').disabled,
            rank: row.querySelector('.mobile-rank').textContent.trim(),
            rankVisible: getComputedStyle(row.querySelector('.mobile-rank')).display !== 'none',
            cells: [...row.querySelectorAll('td[data-plan]')].map(cell => ({
              plan: cell.dataset.plan, display: getComputedStyle(cell).display,
              width: cell.getBoundingClientRect().width,
              local: [...cell.querySelectorAll('.price-local')].map(node => node.textContent),
              cny: [...cell.querySelectorAll('.price-amount')].map(node => node.textContent)
            }))
          }))
        };
      });
      assert.equal(projection.ready, false, label + ': unstarted app keeps static mode');
      assert.equal(projection.pickerDisplay, 'none', label + ': unavailable switcher stays hidden');
      assert.equal(projection.overflowX, 'auto', label + ': complete table scrolls internally');
      assert.equal(projection.bodyFits, true, label + ': page shell fits the viewport');
      assert.deepEqual(projection.headers.map(header => header.plan), staticPlans, label + ': all plan headers survive');
      assert.ok(projection.headers.every(header => header.display === 'table-cell' && header.width >= 170), label + ': all headers have readable widths');
      assert.equal(projection.rows.length, priceData.markets.length, label + ': all markets survive');
      for (const row of projection.rows) {
        const market = priceData.markets.find(candidate => candidate.code === row.code);
        assert.ok(market && row.disabled, label + ': static country controls are disabled');
        assert.ok(row.rankVisible && row.rank.length > 0, label + ': static ranking remains readable');
        assert.deepEqual(row.cells.map(cell => cell.plan), staticPlans, label + ': all plan cells survive');
        for (const cell of row.cells) {
          assert.ok(cell.display === 'table-cell' && cell.width >= 170, label + ': every price column is visible');
          const offer = offerFor(market, cell.plan);
          const amount = offer?.amounts.reduce((lowest, value) => Number(value.amount) < Number(lowest.amount) ? value : lowest);
          assert.deepEqual(cell.local, amount ? [amount.display] : [], label + ': plan-local source price is unchanged');
          assert.deepEqual(cell.cny.map(value => value === '—' ? null : Number(value.replaceAll(',', ''))),
            amount ? [amount.cny == null ? null : Number(amount.cny)] : [], label + ': CNY projection is unchanged');
        }
      }
      const lastHeader = fallbackPage.locator('th[data-plan-header]').last();
      await lastHeader.scrollIntoViewIfNeeded();
      assert.equal(await lastHeader.evaluate(cell => {
        const bounds = cell.getBoundingClientRect();
        const scroll = cell.closest('.table-scroll').getBoundingClientRect();
        return bounds.left >= scroll.left - 1 && bounds.right <= scroll.right + 1;
      }), true, label + ': last plan can be reached by horizontal scrolling');
      if (mode === 'app-404') assert.equal(missingAppRequests, 1, label + ': real app 404 was exercised');
    } finally {
      await fallback.close();
    }
  }


  for (const touch of [false, true]) {
    const focusContext = await browser.newContext({
      viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch
    });
    try {
      const focusPage = await focusContext.newPage();
      const errors = [];
      focusPage.on('pageerror', error => errors.push(error.message));
      await focusPage.goto(url, { waitUntil: 'domcontentloaded' });
      await focusPage.waitForFunction(() => document.querySelector('.country-history-button:not(:disabled)'));
      await assertCountryHistoryFocus(focusPage, { touch, outlineOffset: '2px' });
      assert.deepEqual(errors, []);
    } finally { await focusContext.close(); }
  }

async function assertHistoryDismissalBoundaries(page, { triggerSelector, dialogSelector, closeSelector, touch }) {
  const trigger = page.locator(triggerSelector).first();
  const dialog = page.locator(dialogSelector);
  const activate = locator => touch ? locator.tap() : locator.click();
  const label = dialogSelector + ' [' + (touch ? 'touch' : 'mouse') + ']';
  const startTrace = () => page.evaluate(selector => {
    globalThis.__historyBoundaryTraceCleanup?.();
    const dialog = document.querySelector(selector);
    globalThis.__historyBoundaryTrace = [];
    const capture = event => {
      const box = dialog.getBoundingClientRect();
      const trace = globalThis.__historyBoundaryTrace;
      trace.push({ type: event.type, x: event.clientX, y: event.clientY,
        pointerId: event.pointerId, primary: event.isPrimary, button: event.button, detail: event.detail,
        target: event.target.id || event.target.tagName, ownTarget: event.target === dialog,
        inside: dialog.contains(event.target), open: dialog.open,
        outside: event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom,
        rect: { left: box.left, right: box.right, top: box.top, bottom: box.bottom } });
      if (trace.length > 20) trace.shift();
    };
    const types = ['pointerdown', 'pointerup', 'pointercancel', 'click'];
    for (const type of types) document.addEventListener(type, capture, true);
    globalThis.__historyBoundaryTraceCleanup = () => {
      for (const type of types) document.removeEventListener(type, capture, true);
    };
  }, dialogSelector);
  const resetTrace = () => page.evaluate(() => { globalThis.__historyBoundaryTrace = []; });
  const diagnostics = () => page.evaluate(selector => ({
    open: document.querySelector(selector).open,
    active: document.activeElement?.id || document.activeElement?.tagName,
    events: globalThis.__historyBoundaryTrace
  }), dialogSelector);
  const assertOpen = async scenario => {
    const result = await diagnostics();
    assert.equal(result.open, true, label + ': ' + scenario + '\n' + JSON.stringify(result));
  };
  const pointClick = async (point, requireDialogTarget = false) => {
    await resetTrace();
    if (touch) await page.touchscreen.tap(point.x, point.y);
    else await page.mouse.click(point.x, point.y);
    await page.waitForFunction(() => globalThis.__historyBoundaryTrace.some(event => event.type === 'click'));
    const result = await diagnostics();
    const hit = result.events.findLast(event => event.type === 'click');
    assert.ok(hit?.inside, label + ': real click/tap targets this dialog or its content\n' + JSON.stringify(result));
    if (requireDialogTarget) assert.equal(hit.ownTarget, true,
      label + ': real boundary click targets the dialog element\n' + JSON.stringify(result));
  };
  const geometry = async () => {
    const result = await dialog.evaluate(node => {
      const box = node.getBoundingClientRect();
      const candidates = [0.25, 0.5, 0.75].flatMap(inset => [
        { x: box.left + inset, y: box.top + box.height / 2 },
        { x: box.right - inset, y: box.top + box.height / 2 },
        { x: box.left + box.width / 2, y: box.top + inset },
        { x: box.left + box.width / 2, y: box.bottom - inset }
      ]);
      const border = candidates.find(point => document.elementFromPoint(point.x, point.y) === node);
      const title = node.querySelector('h2').getBoundingClientRect();
      const interior = { x: title.left + title.width / 2, y: title.top + title.height / 2 };
      return { border, interior, left: box.left,
        interiorHit: node.contains(document.elementFromPoint(interior.x, interior.y)) };
    });
    assert.ok(result.left > 2, label + ': dialog leaves a real backdrop hit target');
    assert.equal(result.interiorHit, true, label + ': title hit is inside the current dialog geometry');
    if (!touch) assert.ok(result.border, label + ': actual dialog border supplies a verified mouse hit target');
    return result;
  };
  await activate(trigger);
  await page.waitForSelector(dialogSelector + '[open]');
  if (dialogSelector === '#minimumHistoryDialog') {
    await page.waitForSelector('#minimumHistoryRetry:not([hidden]):not(:disabled)');
  } else {
    await page.waitForFunction(selector => !document.querySelector(selector).textContent.includes('正在读取'), dialogSelector);
  }
  await startTrace();
  await pointClick((await geometry()).interior);
  await assertOpen('clicking ordinary dialog content does not dismiss');
  if (!touch) {
    await pointClick((await geometry()).border, true);
    await assertOpen('clicking the actual dialog border does not dismiss');
    // Keep both the reported subpixel-border edge and an ordinary title drag.
    // Pointerup supplies the true endpoint even when click retargets/rounds.
    for (const endpoint of ['interior', 'border']) {
      for (const startOutside of [false, true]) {
        const current = await geometry();
        const inner = current[endpoint];
        const outer = { x: current.left / 2, y: inner.y };
        const from = startOutside ? outer : inner, to = startOutside ? inner : outer;
        await resetTrace();
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        await page.mouse.move(to.x, to.y);
        await page.mouse.up();
        // WebKit can acknowledge input before dispatching its terminal event.
        // Wait on this gesture, not elapsed time; cancellation is still diagnosed
        // by the unchanged pointerup geometry and open-state assertions below.
        try {
          await page.waitForFunction(() => {
            const trace = globalThis.__historyBoundaryTrace;
            const down = trace.find(event => event.type === 'pointerdown');
            return down && trace.some(event => event.pointerId === down.pointerId
              && (event.type === 'pointerup' || event.type === 'pointercancel'));
          }, null, { timeout: 5000 });
        } catch (error) {
          error.message = label + ': drag terminal event was not delivered\n'
            + JSON.stringify(await diagnostics()) + '\n' + error.message;
          throw error;
        }
        const result = await diagnostics();
        const down = result.events.find(event => event.type === 'pointerdown');
        const up = result.events.find(event => event.type === 'pointerup' && event.pointerId === down?.pointerId);
        const scenario = (startOutside ? 'outside to ' : 'to outside from ') + endpoint;
        assert.equal(down?.outside, startOutside, label + ': drag start geometry ' + scenario + '\n' + JSON.stringify(result));
        assert.equal(up?.outside, !startOutside, label + ': drag endpoint geometry ' + scenario + '\n' + JSON.stringify(result));
        await assertOpen('dragging ' + scenario + ' does not dismiss');
      }
    }
  }
  // These isolated sequences exercise bookkeeping, not device emulation.
  const rejected = await dialog.evaluate(node => {
    const box = node.getBoundingClientRect();
    const outer = { clientX: box.left / 2, clientY: box.top + box.height / 2 };
    const inner = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
    const pointer = (type, pointerId = 71, extra = {}) => node.dispatchEvent(new PointerEvent(type,
      { bubbles: true, pointerId, pointerType: 'mouse', isPrimary: true, button: 0, ...outer, ...extra }));
    const click = (detail = 1, pointerId) => node.dispatchEvent(pointerId === undefined
      ? new MouseEvent('click', { bubbles: true, detail, button: 0, ...outer })
      : new PointerEvent('click', { bubbles: true, detail, button: 0, pointerId, ...outer }));
    const results = [];
    pointer('pointerdown'); pointer('pointercancel'); click(); results.push(['cancelled', node.open]);
    pointer('pointerdown'); pointer('pointerup', 72); click(); results.push(['different pointerup', node.open]);
    pointer('pointerdown'); pointer('pointerup'); click(1, 72); results.push(['different click pointer', node.open]);
    pointer('pointerdown'); pointer('pointerup');
    pointer('pointerdown', 71, inner); pointer('pointerup', 71, inner); click(); results.push(['new interior gesture', node.open]);
    pointer('pointerdown', 71, { isPrimary: false }); pointer('pointerup', 71, { isPrimary: false });
    click(); results.push(['nonprimary gesture', node.open]);
    pointer('pointerdown'); pointer('pointerup'); click(0); results.push(['detail-zero activation', node.open]);
    return results;
  });
  for (const [scenario, open] of rejected) assert.equal(open, true, label + ': ' + scenario + ' cannot dismiss');
  const current = await geometry();
  await pointClick({ x: current.left / 2, y: current.interior.y }, true);
  console.log('History backdrop input:', label, JSON.stringify(await diagnostics()));
  try {
    await page.waitForFunction(selector => !document.querySelector(selector).open, dialogSelector);
  } catch (error) {
    error.message = label + ': real backdrop click did not dismiss\n'
      + JSON.stringify(await diagnostics()) + '\n' + error.message;
    throw error;
  }
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), triggerSelector);
  await activate(trigger);
  await page.waitForSelector(dialogSelector + '[open]');
  await page.locator(closeSelector).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(selector => !document.querySelector(selector).open, dialogSelector);
  await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), triggerSelector);
  await page.keyboard.press('Tab');
  assert.equal(await trigger.evaluate(node => document.activeElement === node), false, label + ': Tab continues after the returned trigger');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true, label + ': Shift+Tab returns to the same navigation position');
  await page.evaluate(() => globalThis.__historyBoundaryTraceCleanup());
}

async function assertNativeHistoryCloseLifecycle(page, { triggerSelector, dialogSelector, closeSelector }) {
  const trigger = page.locator(triggerSelector).first();
  await trigger.click();
  await page.waitForSelector(dialogSelector + '[open]');
  await page.evaluate(async selector => {
    const dialog = document.querySelector(selector);
    const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close();
    document.querySelector('#searchInput').focus();
    await closed;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, dialogSelector);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'searchInput', 'queued close cannot steal a newer search focus');

  await trigger.click();
  await page.waitForSelector(dialogSelector + '[open]');
  await page.evaluate(async selector => {
    const dialog = document.querySelector(selector);
    const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    dialog.close();
    const newer = document.createElement('dialog');
    newer.id = 'newerHistoryFocusDialog';
    const action = document.createElement('button');
    action.id = 'newerHistoryFocusAction'; action.textContent = 'Newer dialog';
    newer.append(action); document.body.append(newer); newer.showModal(); action.focus();
    await closed;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, dialogSelector);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'newerHistoryFocusAction', 'old close cannot take focus from a newer modal');
  await page.evaluate(() => {
    const newer = document.querySelector('#newerHistoryFocusDialog'); newer.close(); newer.remove();
  });

  await trigger.click();
  await page.waitForSelector(dialogSelector + '[open]');
  await page.evaluate(async ({ selector, triggerSelector }) => {
    const dialog = document.querySelector(selector);
    const oldClosed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    const box = dialog.getBoundingClientRect();
    const oldPointer = { bubbles: true, pointerId: 71, pointerType: 'mouse', isPrimary: true,
      button: 0, clientX: box.left / 2, clientY: box.top + box.height / 2 };
    dialog.dispatchEvent(new PointerEvent('pointerdown', oldPointer));
    dialog.close();
    document.querySelector(triggerSelector).click();
    dialog.dispatchEvent(new PointerEvent('pointerup', oldPointer));
    dialog.dispatchEvent(new PointerEvent('click', { ...oldPointer, detail: 1 }));
    await oldClosed;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { selector: dialogSelector, triggerSelector });
  assert.equal(await page.locator(dialogSelector).evaluate(dialog => dialog.open && dialog.contains(document.activeElement)), true,
    dialogSelector + ': an older close or held pointer cannot clear/dismiss the reopened session or take its focus');
  await trigger.evaluate(node => {
    const replacement = node.cloneNode(true);
    replacement.dataset.focusReplacement = 'true';
    node.replaceWith(replacement);
  });
  await page.locator(closeSelector).click();
  await page.waitForFunction(selector => !document.querySelector(selector).open, dialogSelector);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const replacementFocus = await page.evaluate(selector => ({
    replacement: document.activeElement?.dataset.focusReplacement === 'true',
    active: document.activeElement?.id || document.activeElement?.tagName,
    open: document.querySelector(selector).open
  }), dialogSelector);
  assert.equal(replacementFocus.replacement, true, dialogSelector + ': reopened replacement trigger owns focus\n' + JSON.stringify(replacementFocus));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(selector => document.querySelector(selector) && !document.querySelector(selector).disabled, triggerSelector);
  await trigger.click();
  await page.waitForSelector(dialogSelector + '[open]');
  await page.evaluate(async ({ triggerSelector, dialogSelector }) => {
    const dialog = document.querySelector(dialogSelector);
    const closed = new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    document.querySelector(triggerSelector).disabled = true;
    dialog.close();
    await closed;
  }, { triggerSelector, dialogSelector });
  await page.waitForFunction(() => document.activeElement?.id === 'priceWorkspace');
  await page.reload({ waitUntil: 'domcontentloaded' });
}

  for (const touch of [false, true]) {
    const isolated = await browser.newContext({ viewport: { width: touch ? 390 : 1280, height: 900 }, hasTouch: touch });
    const boundaryPage = await isolated.newPage();
    const errors = [];
    boundaryPage.on('pageerror', error => errors.push(error.message));
    await boundaryPage.route('**/data/minimum-history.json*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    try {
      await boundaryPage.goto(url, { waitUntil: 'domcontentloaded' });
      await boundaryPage.waitForFunction(() => !document.querySelector('#minimumHistoryButton').disabled);
      for (const definition of [
        { triggerSelector: '.country-history-button:not(:disabled)', dialogSelector: '#historyDialog', closeSelector: '#closeHistory' },
        { triggerSelector: '#minimumHistoryButton', dialogSelector: '#minimumHistoryDialog', closeSelector: '#closeMinimumHistory' }
      ]) await assertHistoryDismissalBoundaries(boundaryPage, { ...definition, touch });
      assert.deepEqual(errors, []);
    } finally { await isolated.close(); }
  }

  {
    const isolated = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const lifecyclePage = await isolated.newPage();
    await lifecyclePage.route('**/data/minimum-history.json*', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    try {
      await lifecyclePage.goto(url, { waitUntil: 'domcontentloaded' });
      for (const definition of [
        { triggerSelector: '.country-history-button:not(:disabled)', dialogSelector: '#historyDialog', closeSelector: '#closeHistory' },
        { triggerSelector: '#minimumHistoryButton', dialogSelector: '#minimumHistoryDialog', closeSelector: '#closeMinimumHistory' }
      ]) {
        await lifecyclePage.waitForFunction(() => !document.querySelector('#minimumHistoryButton').disabled);
        await assertNativeHistoryCloseLifecycle(lifecyclePage, definition);
      }
    } finally { await isolated.close(); }
  }

  {
    const isolated = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const retryPage = await isolated.newPage();
    const history = JSON.parse(await readFile(resolve(projectDir, 'data/minimum-history.json'), 'utf8'));
    const seed = history.events.find(event => event.kind === 'change');
    assert.ok(seed, 'pagination fixture needs one validated change template');
    const firstAt = Date.parse(history.first_observed_at), lastAt = Date.parse(history.checkpoint.at);
    assert.ok(lastAt > firstAt + 30000);
    history.events = Array.from({ length: 30 }, (_, index) => {
      const event = structuredClone(seed);
      delete event.comparison;
      event.at = new Date(firstAt + Math.floor(index * (lastAt - firstAt) / 31)).toISOString();
      event.previous_at = index === 0 ? null : new Date(firstAt + Math.floor((index - 1) * (lastAt - firstAt) / 31)).toISOString();
      return event;
    });
    history.first_observed_at = history.events[0].at;
    let calls = 0, release, announcePending;
    await retryPage.addInitScript(now => { Date.now = () => now; }, lastAt + 3600000);
    await retryPage.route('**/data/minimum-history.json*', async route => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      const success = await new Promise(resolve => { release = resolve; announcePending?.(); });
      return route.fulfill(success ? { json: history } : { status: 503, contentType: 'application/json', body: '{}' });
    });
    try {
      await retryPage.goto(url, { waitUntil: 'domcontentloaded' });
      await retryPage.waitForFunction(() => !document.querySelector('#minimumHistoryButton').disabled);
      await retryPage.locator('#minimumHistoryButton').click();
      for (const success of [false, true]) {
        await retryPage.locator('#minimumHistoryRetry').waitFor({ state: 'visible' });
        const pending = new Promise(resolve => { announcePending = resolve; });
        await retryPage.locator('#minimumHistoryRetry').focus();
        await retryPage.keyboard.press('Enter');
        await Promise.race([pending, delay(5000).then(() => { throw Error('retry request did not start'); })]);
        assert.equal(await retryPage.evaluate(() => document.activeElement?.id), 'closeMinimumHistory', 'pending retry hands focus to a usable dialog control');
        assert.equal(await retryPage.locator('#minimumHistoryRetry').isHidden(), true);
        assert.equal(await retryPage.locator('#minimumHistoryRetry').isDisabled(), true);
        await retryPage.locator('#closeMinimumHistory').focus();
        release(success);
        if (success) await retryPage.waitForFunction(() => !document.querySelector('#minimumHistoryNote').hidden && !document.querySelector('#minimumHistoryRetry').disabled);
        else await retryPage.locator('#minimumHistoryRetry').waitFor({ state: 'visible' });
        assert.equal(await retryPage.evaluate(() => document.activeElement?.id), 'closeMinimumHistory', 'async result keeps the current dialog focus');
      }
      await retryPage.locator('#minimumHistoryMore').focus();
      await retryPage.keyboard.press('Enter');
      await retryPage.waitForFunction(() => document.querySelectorAll('#minimumHistoryEvents .minimum-history-event').length === 30);
      assert.equal(await retryPage.locator('#minimumHistoryMore').isHidden(), true);
      assert.equal(await retryPage.evaluate(() => document.activeElement?.id), 'minimumHistoryPlanFilter', 'last pagination batch transfers focus before hiding More');
      await retryPage.keyboard.press('ArrowDown');
      await retryPage.keyboard.press('g');
      assert.equal(await retryPage.evaluate(() => document.activeElement?.id), 'minimumHistoryPlanFilter', 'ordinary select navigation/typeahead stays focused');
      await retryPage.keyboard.press('Escape');
    } finally { if (release) release(false); await isolated.close(); }
  }

  console.log(`Cross-browser smoke passed: ${browserName}`);
} finally {
  if (browser) await browser.close();
  server.kill('SIGTERM');
}
