import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

const browserName = process.env.PLAYWRIGHT_BROWSER || 'chromium';
const browserType = { chromium, firefox, webkit }[browserName];
if (!browserType) throw new Error(`Unsupported browser: ${browserName}`);
const base = (process.env.BASE_URL || 'http://127.0.0.1:4173').replace(/\/$/, '');
const url = `${base}/tools/bank_rank/`;
const load = async name => JSON.parse(await readFile(new URL(`../bank_rank/data/${name}`, import.meta.url), 'utf8'));
const manifest = await load('rankings.json');
const files = { 'rankings.json': manifest, [manifest.banksFile]: await load(manifest.banksFile), [manifest.relationsFile]: await load(manifest.relationsFile) };
for (const block of manifest.years) files[block.recordsFile] = await load(block.recordsFile);
const latest = manifest.years.at(-1);
const latestFile = latest.recordsFile;
const controls = '#yearSelect, #typeSelect, #bankSearch, #bankTable [data-sort]';
const formatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const browser = await browserType.launch({ headless: true });
let completed = 0;

async function context(documents = files, options = {}) {
  const ctx = await browser.newContext(options);
  await ctx.route('**/googletagmanager.com/**', route => route.abort());
  await ctx.route('**/google-analytics.com/**', route => route.abort());
  await ctx.route('**/tools/bank_rank/data/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/tools/bank_rank/data/')[1];
    if (!(name in documents)) return route.continue();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(documents[name]) });
  });
  return ctx;
}

async function fallback(page, label) {
  await page.waitForFunction(() => document.querySelector('#dataStatus').textContent.includes('数据加载失败'));
  assert.equal(await page.locator('#bankList tr[data-static-prerendered="true"]').count(), 100, `${label}: full static fallback`);
  assert.equal(await page.locator(controls).count(), 9);
  assert.equal(await page.locator(`${controls}, .bank-history-button`).evaluateAll(nodes => nodes.every(node => node.disabled)), true, label);
  assert.equal(await page.locator('#yearSelect').inputValue(), String(latest.rankingYear), `${label}: coherent static year`);
  assert.match(await page.locator('#workspaceTitle').innerText(), new RegExp(String(latest.rankingYear)), label);
  assert.match(await page.locator('#resultSummary').innerText(), /100 家静态预览/, label);
  assert.equal(await page.locator('#bankList tr').first().locator('.bank-name').innerText(), files[latestFile][0].sourceName, label);
}

const cases = [
  ['null-manifest', f => { f['rankings.json'] = null; }],
  ['empty-years', f => { f['rankings.json'].years = []; }],
  ['boolean-schema', f => { f['rankings.json'].schemaVersion = true; }],
  ['duplicate-year', f => { f['rankings.json'].years.push(f['rankings.json'].years[0]); }],
  ['fractional-year', f => { f['rankings.json'].years[0].rankingYear += 0.5; }],
  ['wrong-data-year', f => { f['rankings.json'].years[0].dataYear += 1; }],
  ['bank-path-traversal', f => { f['rankings.json'].banksFile = '../outside.json'; }],
  ['cross-year-path', f => { f['rankings.json'].years[0].recordsFile = latestFile; }],
  ['invalid-bank-types', f => { f['rankings.json'].bankTypes[0] = f['rankings.json'].bankTypes[1]; }],
  ['empty-banks', f => { f['banks.json'] = []; }],
  ['duplicate-bank', f => { f['banks.json'].push(f['banks.json'][0]); }],
  ['invalid-bank-type', f => { f['banks.json'][0].type = null; }],
  ['invalid-aliases', f => { f['banks.json'][0].aliases = '字符串不是数组'; }],
  ['alias-collision', f => { f['banks.json'][1].aliases.push(f['banks.json'][0].name); }],
  ['99-rows', f => { f[latestFile].pop(); }],
  ['101-rows', f => { f[latestFile].push(f[latestFile][0]); }],
  ['duplicate-record', f => { f[latestFile][1] = f[latestFile][0]; }],
  ['unknown-bank', f => { f[latestFile][0].bankId = 'b_unknown'; }],
  ['wrong-source-name', f => { f[latestFile][0].sourceName = '其他实体名称'; }],
  ['zero-rank', f => { f[latestFile][0].rank = 0; }],
  ['boolean-rank', f => { f[latestFile][0].rank = true; }],
  ['null-assets', f => { f[latestFile][0].assets = null; }],
  ['string-assets', f => { f[latestFile][0].assets = '123.45'; }],
  ['negative-assets', f => { f[latestFile][0].assets = -1; }],
  ['boolean-capital', f => { f[latestFile][0].coreTier1Capital = true; }],
  ['null-profit', f => { f[latestFile][0].netProfit = null; }],
  ['boolean-profit', f => { f[latestFile][0].netProfit = false; }],
  ['string-profit', f => { f[latestFile][0].netProfit = '0'; }],
  ['non-array-relations', f => { f['relations.json'] = {}; }],
  ['unsafe-relation-url', f => { f['relations.json'][0].sourceUrl = 'javascript:alert(1)'; }],
  ['invalid-relation-date', f => { f['relations.json'][0].date = '2025-02-30'; }],
  ['unknown-relation-type', f => { f['relations.json'][0].type = 'unknown'; }],
  ['wrong-old-name', f => { f['relations.json'][0].fromName = '其他主体'; }],
  ['wrong-new-name', f => { f['relations.json'][0].toName = '其他主体'; }],
  ['duplicate-relation', f => { f['relations.json'].push(f['relations.json'][0]); }],
];

try {
  for (const [label, mutate] of cases) {
    const documents = structuredClone(files);
    mutate(documents);
    const ctx = await context(documents);
    try {
      const page = await ctx.newPage();
      const errors = [];
      const requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (request.url().includes('/tools/bank_rank/data/')) requests.push(request.url()); });
      await page.goto(url);
      await fallback(page, label);
      if (cases.findIndex(item => item[0] === label) < 9) assert.equal(requests.length, 1, `${label}: reject manifest before subordinate fetches`);
      assert.deepEqual(errors, [], label);
      completed += 1;
    } finally { await ctx.close(); }
  }

  for (const file of ['rankings.json', 'banks.json', 'relations.json', latestFile]) {
    const ctx = await context();
    try {
      await ctx.route(`**/tools/bank_rank/data/${file}`, route => route.abort());
      const page = await ctx.newPage();
      await page.goto(url);
      await fallback(page, `network-${file}`);
      completed += 1;
    } finally { await ctx.close(); }
  }

  for (const label of ['malformed-json', 'overflow-number', 'timeout', 'mid-render', 'after-render']) {
    const ctx = await context();
    try {
      if (label === 'malformed-json') await ctx.route(`**/tools/bank_rank/data/${latestFile}`, route => route.fulfill({ contentType: 'application/json', body: '{' }));
      if (label === 'overflow-number') {
        const body = JSON.stringify(files[latestFile]).replace(/"assets":\s*[-\d.]+/, '"assets":1e400');
        await ctx.route(`**/tools/bank_rank/data/${latestFile}`, route => route.fulfill({ contentType: 'application/json', body }));
      }
      if (label === 'timeout') {
        await ctx.addInitScript(() => {
          const timeout = window.setTimeout.bind(window);
          window.setTimeout = (fn, delay, ...args) => timeout(fn, delay === 15000 ? 100 : delay, ...args);
        });
        await ctx.route(`**/tools/bank_rank/data/${latestFile}`, () => {});
      }
      if (label === 'mid-render') await ctx.addInitScript(() => {
        const create = document.createElement.bind(document);
        let cells = 0;
        document.createElement = (name, ...args) => {
          if (name === 'td' && ++cells === 18) throw new Error('injected mid-render failure');
          return create(name, ...args);
        };
      });
      if (label === 'after-render') await ctx.addInitScript(() => {
        const setAttribute = Element.prototype.setAttribute;
        let fired = false;
        Element.prototype.setAttribute = function (name, value) {
          if (!fired && this.tagName === 'TH' && name === 'aria-sort') {
            fired = true;
            throw new Error('injected after-render failure');
          }
          return setAttribute.call(this, name, value);
        };
      });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(url);
      await fallback(page, label);
      assert.deepEqual(errors, [], label);
      completed += 1;
    } finally { await ctx.close(); }
  }

  const noJs = await context(files, { javaScriptEnabled: false });
  try {
    const page = await noJs.newPage();
    await page.goto(url);
    assert.equal(await page.locator('#bankList tr.data-row').count(), 100);
    assert.equal(await page.locator(`${controls}, .bank-history-button`).evaluateAll(nodes => nodes.every(node => node.disabled)), true);
    assert.equal(await page.locator('noscript').isVisible(), true);
    completed += 1;
  } finally { await noJs.close(); }

  const ctx = await context(files, { viewport: { width: 1365, height: 900 } });
  try {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForSelector('.bank-history-button:not(:disabled)');
    const banks = new Map(files['banks.json'].map(bank => [bank.id, bank]));
    for (const block of manifest.years) {
      await page.locator('#yearSelect').selectOption(String(block.rankingYear));
      const actual = await page.locator('#bankList tr.data-row').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent.trim().replace(/›$/, ''))));
      const prior = manifest.years.find(item => item.rankingYear === block.rankingYear - 1);
      const expected = files[block.recordsFile].map(record => {
        const previous = prior && files[prior.recordsFile].find(row => row.bankId === record.bankId);
        const earlier = manifest.years.some(item => item.rankingYear < block.rankingYear && files[item.recordsFile].some(row => row.bankId === record.bankId));
        const delta = previous ? previous.rank - record.rank : null;
        const change = delta === null ? (earlier ? '上年未上榜' : '首次记录') : delta > 0 ? `↑ ${delta} 位` : delta < 0 ? `↓ ${-delta} 位` : '— 持平';
        return [String(record.rank), record.sourceName, banks.get(record.bankId).type,
          ...[record.coreTier1Capital, record.assets, record.netProfit].map(value => formatter.format(value)), change];
      });
      assert.deepEqual(actual, expected, `all rows and fields ${block.rankingYear}`);
    }
    completed += 1;
    await page.locator('#bankSearch').fill('海南农村商业银行');
    assert.equal(await page.locator('#bankList tr.data-row').count(), 1, 'official Hainan full name resolves to its entity');
    assert.equal(await page.locator('#bankList tr.data-row').getAttribute('data-bank-id'), 'b_551aeda765');
    await page.locator('#bankSearch').fill('不存在的银行__回归');
    assert.equal(await page.locator('.empty-message').evaluate(cell => cell.colSpan), 7);
    await page.locator('#bankSearch').fill('');
    for (const field of ['rank', 'name', 'type', 'coreTier1Capital', 'assets', 'netProfit']) {
      const button = page.locator(`[data-sort="${field}"]`);
      for (let turn = 0; turn < 2; turn += 1) {
        await button.click();
        const direction = await button.locator('..').getAttribute('aria-sort');
        const ids = await page.locator('#bankList tr.data-row').evaluateAll(rows => rows.map(row => row.dataset.bankId));
        const records = ids.map(id => files[latestFile].find(row => row.bankId === id));
        const value = record => field === 'name' ? record.sourceName : field === 'type' ? banks.get(record.bankId).type : record[field];
        for (let i = 1; i < records.length; i += 1) {
          const left = value(records[i - 1]);
          const right = value(records[i]);
          const comparison = typeof left === 'string' ? left.localeCompare(right, 'zh-CN') : left - right;
          assert.ok(direction === 'ascending' ? comparison <= 0 : comparison >= 0, `${field} ${direction}`);
        }
      }
    }
    completed += 1;
    for (const relation of files['relations.json']) {
      const bank = banks.get(relation.bankId);
      const block = [...manifest.years].reverse().find(item => files[item.recordsFile].some(row => row.bankId === bank.id));
      await page.locator('#yearSelect').selectOption(String(block.rankingYear));
      await page.locator('#bankSearch').fill(bank.name);
      const trigger = page.locator(`.bank-history-button[data-bank-id="${bank.id}"]`);
      await trigger.click();
      const dialog = page.locator('#historyDialog');
      assert.equal(await dialog.isVisible(), true);
      assert.match(await dialog.innerText(), /财务数据对应上一年末；单位：亿元/);
      assert.ok((await dialog.innerText()).includes(relation.date));
      assert.equal(await dialog.locator('.history-table tbody tr').count(), manifest.years.filter(item => files[item.recordsFile].some(row => row.bankId === bank.id)).length);
      for (const key of ['Tab', 'Shift+Tab']) {
        for (let i = 0; i < 5; i += 1) {
          await page.keyboard.press(key);
          const focus = await dialog.evaluate(node => ({
            contained: node.contains(document.activeElement),
            activeTag: document.activeElement?.tagName,
            activeId: document.activeElement?.id,
            documentFocused: document.hasFocus()
          }));
          assert.equal(focus.contained, true, `${key}: dialog focus containment ${JSON.stringify(focus)}`);
        }
      }
      const box = await dialog.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(1, 1);
      await page.mouse.up();
      assert.equal(await dialog.isVisible(), true, 'dragging from content to backdrop must not dismiss');
      await page.mouse.click(1, 1);
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
      await trigger.click();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await page.locator('#bankSearch').fill('');
    }
    completed += 1;
    await page.locator('#yearSelect').selectOption(String(latest.rankingYear));
    for (const width of [320, 390, 820, 1365]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `${width}px viewport overflow`);
      if (width < 500) {
        await page.locator('.table-scroll').evaluate(node => { node.scrollLeft = 0; node.focus(); });
        await page.keyboard.press('ArrowRight');
        await page.waitForFunction(() => document.querySelector('.table-scroll').scrollLeft > 0);
      }
      if (process.env.BANK_RANK_ARTIFACTS && [390, 1365].includes(width)) {
        await mkdir(process.env.BANK_RANK_ARTIFACTS, { recursive: true });
        await page.screenshot({ path: join(process.env.BANK_RANK_ARTIFACTS, `${browserName}-${width}.png`) });
      }
    }
    assert.deepEqual(errors, []);
    completed += 1;
  } finally { await ctx.close(); }

  const gap = structuredClone(files);
  gap['rankings.json'].years = gap['rankings.json'].years.filter(block => block.rankingYear !== latest.rankingYear - 1);
  gap['rankings.json'].scope.historicalBackfillPending.push(latest.rankingYear - 1);
  const gapContext = await context(gap);
  try {
    const page = await gapContext.newPage();
    await page.goto(url);
    await page.waitForSelector('.bank-history-button:not(:disabled)');
    assert.equal(await page.locator('#bankList tr td:last-child').evaluateAll(cells => cells.every(cell => cell.textContent === '上年未收录')), true);
    completed += 1;
  } finally { await gapContext.close(); }
  console.log(`bank_rank extended regression OK (${browserName}): ${completed} scenarios, all ${manifest.years.length * 100} UI rows checked`);
} finally {
  await browser.close();
}
