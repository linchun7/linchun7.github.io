import assert from 'node:assert/strict';

// A live-resource regression probe, not a heap/GC measurement. Only registrations
// and scheduling made by the application's entry script count; Playwright's own
// input interception and polling must not become apparent application leaks.
export async function installHistoryInteractionProbe(page, entryFile) {
  await page.addInitScript(entry => {
    const acceptedSourceFrames = [];
    const fromApp = () => {
      // JSC removes URL query/fragment data from Error.stack. Match the exact
      // origin/path and frame location instead of relying on the asset query.
      const source = new URL(entry, location.href).href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp('(?:^|[\\s@(])' + source + '(?:\\?[^\\s)]*)?:\\d+(?::\\d+)?\\)?\\s*$');
      const frame = String(new Error().stack || '').split('\n').find(line => pattern.test(line));
      if (frame && acceptedSourceFrames.length < 2 && !acceptedSourceFrames.includes(frame.trim())) acceptedSourceFrames.push(frame.trim());
      return Boolean(frame);
    };
    const registrations = Object.create(null);
    const dataRequests = [];
    const timers = new Set();
    const intervals = new Set();
    const frames = new Set();
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if ((this === window || this === document || this instanceof HTMLDialogElement) && fromApp()) {
        const target = this === window ? 'window' : this === document ? 'document' : this.id;
        const key = target + ':' + type;
        registrations[key] = (registrations[key] || 0) + 1;
      }
      return add.call(this, type, listener, options);
    };
    const fetch = globalThis.fetch;
    globalThis.fetch = function(input, init) {
      const pathname = new URL(input?.url || input, location.href).pathname;
      if (/\/data\/(?:prices|history|minimum-history)\.json$/.test(pathname)) dataRequests.push(pathname);
      return fetch.call(this, input, init);
    };
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    globalThis.setTimeout = function(callback, delay, ...args) {
      if (typeof callback !== 'function' || !fromApp()) return set.call(this, callback, delay, ...args);
      let id;
      id = set.call(this, function(...received) {
        timers.delete(id);
        return callback.apply(this, received);
      }, delay, ...args);
      timers.add(id);
      return id;
    };
    // Browser timeout/interval IDs share a pool, and either clear API accepts
    // either kind. Keep the accounting faithful to that existing behavior.
    globalThis.clearTimeout = function(id) { timers.delete(id); intervals.delete(id); return clear.call(this, id); };
    const setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval;
    globalThis.setInterval = function(callback, delay, ...args) {
      const tracked = fromApp();
      const id = setInterval.call(this, callback, delay, ...args);
      if (tracked) intervals.add(id);
      return id;
    };
    globalThis.clearInterval = function(id) { timers.delete(id); intervals.delete(id); return clearInterval.call(this, id); };
    const request = globalThis.requestAnimationFrame, cancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = function(callback) {
      if (!fromApp()) return request.call(this, callback);
      let id;
      id = request.call(this, time => { frames.delete(id); callback(time); });
      frames.add(id);
      return id;
    };
    globalThis.cancelAnimationFrame = function(id) { frames.delete(id); return cancel.call(this, id); };
    globalThis.__historyInteractionProbe = () => ({
      stableListenerRegistrations: { ...registrations },
      acceptedSourceFrames: [...acceptedSourceFrames],
      dataRequests: [...dataRequests], timers: timers.size, intervals: intervals.size, frames: frames.size
    });
  }, entryFile);
}

export async function assertHistoryInteractionStress(page, definitions, { touch = false, rounds = touch ? 12 : 24 } = {}) {
  const activate = locator => touch ? locator.tap() : locator.click();
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const probe = () => page.evaluate(() => globalThis.__historyInteractionProbe());
  const open = async definition => {
    await activate(page.locator(definition.trigger).first());
    await page.waitForSelector(definition.dialog + '[open]');
    await page.waitForFunction(selector => !document.querySelector(selector).textContent.includes('正在读取'), definition.dialog);
    if (definition.dialog === '#minimumHistoryDialog') await page.waitForSelector('#minimumHistoryNote:not([hidden])');
    assert.equal(await page.locator('dialog[open]').count(), 1, 'one user action opens exactly one modal');
  };
  const returnSelector = async definition => {
    if (!definition.country) return definition.trigger;
    const market = await page.locator(definition.trigger).first().evaluate(node => node.closest('tr').dataset.marketId);
    return '#priceRows tr[data-market-id=' + JSON.stringify(market) + '] .country-history-button';
  };
  for (const definition of definitions) {
    const target = await returnSelector(definition);
    await open(definition);
    await activate(page.locator(definition.close));
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), target);
    await settle();
  }
  // In particular, do not let an unexpired analytics fallback timeout become
  // a permanent allowance for a newly leaked timeout in later rounds.
  await page.waitForFunction(() => {
    const resources = globalThis.__historyInteractionProbe();
    return resources.timers === 0 && resources.intervals === 0 && resources.frames === 0;
  }, null, { timeout: 5000, polling: 25 });
  const baseline = await probe();
  assert.ok(Object.keys(baseline.stableListenerRegistrations).some(key => key.startsWith('document:')),
    'the entry-script probe actually observed application document listeners: ' + JSON.stringify(baseline));
  const rowCount = await page.locator('#priceRows tr[data-market-id]').count();
  const dialogIds = await page.locator('dialog').evaluateAll(nodes => nodes.map(node => node.id).sort());
  for (let round = 0; round < rounds; round++) for (const definition of definitions) {
    const label = definition.dialog + ' / ' + (touch ? 'touch' : 'mouse') + ' / round ' + round;
    const target = await returnSelector(definition);
    await open(definition);
    let expected = target;
    switch (round % 6) {
      case 0:
        await page.keyboard.press('Escape');
        break;
      case 1:
        await page.locator(definition.close).focus();
        await page.keyboard.press('Enter');
        break;
      case 2: {
        const point = await page.locator(definition.dialog).evaluate(node => {
          const box = node.getBoundingClientRect();
          return { x: box.left / 2, y: box.top + box.height / 2, left: box.left };
        });
        assert.ok(point.left > 2, label + ': a real backdrop hit target exists');
        if (touch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        break;
      }
      case 3:
        await page.evaluate(({ definition, target }) => {
          const dialog = document.querySelector(definition.dialog);
          const box = dialog.getBoundingClientRect();
          const held = { bubbles: true, pointerId: 71, pointerType: 'mouse', isPrimary: true,
            button: 0, clientX: box.left / 2, clientY: box.top + box.height / 2 };
          dialog.dispatchEvent(new PointerEvent('pointerdown', held));
          dialog.close();
          document.querySelector(target).click();
          dialog.dispatchEvent(new PointerEvent('pointerup', held));
          dialog.dispatchEvent(new PointerEvent('click', { ...held, detail: 1 }));
        }, { definition, target });
        await settle();
        assert.equal(await page.locator(definition.dialog).evaluate(node => node.open && node.contains(document.activeElement)), true,
          label + ': old close and held pointer cannot affect the reopened session');
        await page.keyboard.press('Escape');
        break;
      case 4:
        if (definition.country) {
          await page.evaluate(target => {
            globalThis.__stressOriginalTrigger = document.querySelector(target);
            document.querySelector('#searchInput').dispatchEvent(new Event('input', { bubbles: true }));
          }, target);
          await page.waitForFunction(() => !globalThis.__stressOriginalTrigger.isConnected);
          await page.evaluate(() => { delete globalThis.__stressOriginalTrigger; });
          await activate(page.locator(definition.close));
        } else {
          await page.evaluate(selector => {
            document.querySelector(selector).close();
            document.querySelector('#searchInput').focus();
          }, definition.dialog);
          expected = '#searchInput';
        }
        break;
      case 5:
        await page.keyboard.press('Tab');
        await activate(page.locator(definition.dialog + ' h2'));
        await page.keyboard.press('Escape');
        break;
    }
    await page.waitForFunction(selector => !document.querySelector(selector).open, definition.dialog);
    await page.waitForFunction(selector => document.activeElement === document.querySelector(selector), expected);
    await settle();
    assert.equal(await page.locator('dialog[open]').count(), 0, label + ': all modals are dismissed');
    assert.equal(await page.locator('#minimumHistoryButton').count(), 1, label + ': history trigger remains unique');
    assert.equal(await page.locator('#priceRows tr[data-market-id]').count(), rowCount, label + ': rebuilding does not grow the table');
    assert.deepEqual(await page.locator('dialog').evaluateAll(nodes => nodes.map(node => node.id).sort()), dialogIds,
      label + ': dialog creation remains bounded');
    const actual = await probe();
    // This narrower invariant catches unnecessary re-registration on targets
    // which survive every round. It does not estimate currently live listeners;
    // detached row-button listeners and once/signal lifetimes are not counted.
    assert.deepEqual(actual.stableListenerRegistrations, baseline.stableListenerRegistrations, label + ': no stable-target listener re-registration');
    assert.deepEqual(actual.dataRequests, baseline.dataRequests, label + ': accepted histories are reused without extra requests');
    assert.equal(actual.timers, 0, label + ': application timeout resources settle');
    assert.equal(actual.intervals, 0, label + ': no application polling intervals accumulate');
    assert.equal(actual.frames, 0, label + ': application animation-frame resources settle');
  }
  return { rounds, touch, measuredOpens: rounds * definitions.length,
    warmedResources: baseline, finalResources: await probe() };
}
