import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function assertMinimumComparison(page, projectDir) {
  const source = JSON.parse(await readFile(resolve(projectDir, 'data/minimum-history.json'), 'utf8'));
  const target = source.events.find(event => event.plan === 'ChatGPT Pro 5x' && event.at === '2026-10-02T05:21:39Z');
  assert.ok(target?.comparison, 'published historical event must have exact snapshot evidence');
  assert.equal(target.from[0].cny, '667.56', 'cross-period fact stays intact');
  assert.equal(target.comparison.from[0].cny, '669.57');
  assert.equal(target.comparison.to[0].cny, '668.11');
  await page.setViewportSize({width:320,height:568});
  await page.locator('#minimumHistoryButton').click();
  const row = page.locator('.minimum-history-event').filter({hasText:'瑞士 ¥669.57 → 泰国 ¥668.11'});
  assert.equal(await row.count(), 1, 'one single-line comparison for the actual event');
  assert.equal(await row.locator('.minimum-history-cause').textContent(), '汇率等因素');
  assert.equal(await row.locator('.minimum-history-cause').isVisible(), true, 'gap is visible without hovering');
  const geometry = await row.evaluate(item => {
    const dialog = document.querySelector('#minimumHistoryDialog').getBoundingClientRect();
    return [...item.querySelectorAll('.minimum-history-change,.minimum-history-cause')].map(node => {
      const rect = node.getBoundingClientRect();
      return rect.left >= dialog.left && rect.right <= dialog.right && rect.width > 0;
    });
  });
  assert.ok(geometry.every(Boolean), 'comparison and gap fit a 320px dialog');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.locator('#closeMinimumHistory').click();

  async function replaceHistory(history, expected) {
    await page.route('**/data/minimum-history.json*', route => route.fulfill({
      contentType:'application/json', body:JSON.stringify(history)
    }));
    await page.locator('#minimumHistoryButton').click();
    await page.evaluate(() => document.querySelector('#minimumHistoryRetry').click());
    await page.waitForFunction(text => [...document.querySelectorAll('.minimum-history-change')].some(node => node.textContent === text), expected);
    assert.equal(await page.locator('#minimumHistoryRetry').isHidden(), true);
    assert.equal(await page.locator('.minimum-history-change').filter({hasText:'瑞士 ¥667.56 → 泰国'}).count(), 0,
      'cross-period price must never masquerade as the event comparison');
    await page.locator('#closeMinimumHistory').click();
    await page.unroute('**/data/minimum-history.json*');
  }
  const legacy = structuredClone(source);
  for (const event of legacy.events) delete event.comparison;
  await replaceHistory(legacy, '瑞士（同期价未记录） → 泰国 ¥668.11');
  const missing = structuredClone(source);
  const event = missing.events.find(item => item.plan === target.plan && item.at === target.at);
  event.comparison.from = [];
  event.comparison.missing = [{code:'ch',name:'瑞士'}];
  delete event.comparison.fx.rates.CHF;
  await replaceHistory(missing, '瑞士（同期价缺失） → 泰国 ¥668.11');

  await page.locator('#minimumHistoryButton').click();
  await page.evaluate(() => document.querySelector('#minimumHistoryRetry').click());
  await page.waitForFunction(() => [...document.querySelectorAll('.minimum-history-change')]
    .some(node => node.textContent === '瑞士 ¥669.57 → 泰国 ¥668.11'));
  await page.locator('#closeMinimumHistory').click();
  await page.setViewportSize({width:1280,height:900});
}
