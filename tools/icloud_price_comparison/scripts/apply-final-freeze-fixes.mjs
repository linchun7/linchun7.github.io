import { readFile, writeFile } from 'node:fs/promises';

async function replaceOnce(path, before, after, label) {
  let source = await readFile(path, 'utf8');
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`Missing ${label} replacement target in ${path}`);
  source = source.replace(before, after);
  await writeFile(path, source);
}

await replaceOnce(
  'style.css',
  'html { background: var(--page); }',
  'html { background: var(--page); scrollbar-gutter: stable; }',
  'stable root scrollbar gutter'
);

await replaceOnce(
  'style.css',
  '@media (min-width: 1101px) {\n  .loading-cell { height: max(400px, calc(100dvh - 500px)); }',
  '@media (min-width: 1101px) {\n  .workspace-toolbar { min-height: 101px; }\n  .loading-cell { height: max(400px, calc(100dvh - 500px)); }',
  'desktop toolbar reserved height'
);

await replaceOnce(
  'style.css',
  '  .data-status { width: 100%; font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; white-space: normal; }',
  '  .data-status { width: 100%; justify-content: flex-end; font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; text-align: right; white-space: normal; }',
  'mobile timestamp trailing alignment'
);

await replaceOnce(
  'OPERATIONS.md',
  '- 页面底部应与实际隐私行为一致，当前包含两类信息：\n  - “本工具与 Apple Inc. 无关联，数据仅供参考。”\n  - “访问统计使用 Google Analytics 和 Cloudflare Web Analytics；站内搜索词不会发送给统计服务。”',
  '- 页面底部当前只展示“本工具与 Apple Inc. 无关联，数据仅供参考。”及版权信息；不要把 GA4 / Cloudflare Web Analytics 运维说明误写成当前可见 footer 文案。\n- GA4 与 Cloudflare Web Analytics 的实际启用状态、隐私边界和检查方法记录在 README/本手册中；若未来要新增用户可见统计披露，应作为明确的产品文案变更，并同步修改页面与 UI 测试。',
  'analytics footer documentation'
);

const testPath = 'test/ui-smoke.test.mjs';
let tests = await readFile(testPath, 'utf8');
if (!tests.includes("test('keeps desktop search filtering free of vertical and scrollbar-gutter layout shifts'")) {
  tests += String.raw`

test('keeps desktop search filtering free of vertical and scrollbar-gutter layout shifts', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the desktop search layout-stability regression test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('https://**/*', (route) => route.abort());

  const snapshot = () => page.evaluate(() => {
    const toolbar = document.querySelector('.workspace-toolbar');
    const main = document.querySelector('.page-main');
    return {
      toolbarHeight: toolbar.getBoundingClientRect().height,
      mainLeft: main.getBoundingClientRect().left,
      clientWidth: document.documentElement.clientWidth
    };
  });

  try {
    await page.goto(\`http://127.0.0.1:\${port}/?tier=12TB\`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 50);
    const baseline = await snapshot();

    await page.locator('#searchInput').fill('c');
    await page.waitForFunction(() => !document.querySelector('#rankingScopeNote')?.hidden);
    const filtered = await snapshot();
    assert.equal(filtered.toolbarHeight, baseline.toolbarHeight, 'showing the global-ranking note must not push the table downward');
    assert.equal(filtered.mainLeft, baseline.mainLeft, 'showing the global-ranking note must not move the centered page shell');

    await page.locator('#searchInput').fill('cc');
    await page.waitForFunction(() => document.querySelector('#resultSummary')?.textContent?.includes('0 个地区'));
    const empty = await snapshot();
    assert.equal(empty.clientWidth, baseline.clientWidth, 'removing the vertical scrollbar must keep a stable viewport gutter');
    assert.equal(empty.mainLeft, baseline.mainLeft, 'empty search results must not shift the centered page shell horizontally');
    assert.equal(empty.toolbarHeight, baseline.toolbarHeight, 'empty search results must keep the toolbar height stable');
  } finally {
    await browser.close();
  }
});

test('keeps the mobile updated timestamp on the trailing edge', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'the mobile header alignment regression test');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://**/*', (route) => route.abort());
  try {
    await page.goto(\`http://127.0.0.1:\${port}/\`, { waitUntil: 'domcontentloaded' });
    const alignment = await page.locator('.data-status').evaluate((element) => ({
      justifyContent: getComputedStyle(element).justifyContent,
      textAlign: getComputedStyle(element).textAlign,
      right: element.getBoundingClientRect().right,
      parentRight: element.parentElement.getBoundingClientRect().right
    }));
    assert.equal(alignment.justifyContent, 'flex-end');
    assert.equal(alignment.textAlign, 'right');
    assert.ok(Math.abs(alignment.right - alignment.parentRight) < 1, 'mobile timestamp row should retain the full header width');
  } finally {
    await browser.close();
  }
});
`;
  await writeFile(testPath, tests);
}
