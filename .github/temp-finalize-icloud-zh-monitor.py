from pathlib import Path

ROOT = Path('.')
PROJECT = ROOT / 'tools/icloud_price_comparison'


def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'marker not found in {path}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


# 1) Make storage-capacity context generic so future tier sizes do not break market detection.
monitor = PROJECT / 'scripts/check-apple-zh-markets.mjs'
text = monitor.read_text(encoding='utf-8')
text = text.replace(
    "const CAPACITY_RE = /(?:^|[^\\d])(?:50|200)\\s*GB\\b|(?:^|[^\\d])(?:2|6|12)\\s*TB\\b/giu;",
    "const CAPACITY_RE = /\\b\\d+(?:[.,]\\d+)?\\s*(?:GB|TB|PB)\\b/giu;",
    1,
)
old_heading = """function extractHeadingCandidates($, root, target) {
  root.find('h2,h3,h4,h5,h6,dt').each((_, element) => {
    addCandidate(target, $(element).text(), { allowPlain: false });
  });
}
"""
new_heading = """function extractHeadingCandidates($, root, target) {
  root.find('h2,h3,h4,h5,h6,dt').each((_, element) => {
    const candidate = marketNameFromLabel($(element).text(), { allowPlain: false });
    if (!candidate) return;
    const nearby = $(element).nextAll().slice(0, 3).toArray()
      .map((node) => normalizeVisibleText($(node).text()))
      .join(' ');
    if (countCapacityMarkers(nearby) >= 2) target.add(candidate);
  });
}
"""
if old_heading in text:
    text = text.replace(old_heading, new_heading, 1)
monitor.write_text(text, encoding='utf-8')

# 2) Shared presentation projection. Raw publication evidence stays untouched.
data_model = PROJECT / 'data-model.js'
text = data_model.read_text(encoding='utf-8')
helper = r'''

export function foldPublicationCountryRenames(changes, currentCountries = []) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const added = Array.isArray(source.addedCountries) ? source.addedCountries : [];
  const removed = Array.isArray(source.removedCountries) ? source.removedCountries : [];
  const current = Array.isArray(currentCountries) ? currentCountries : [];
  const addedByName = new Map();
  const removedByName = new Map();
  const currentByName = new Map();
  const reviewedName = (entry) => {
    const name = typeof entry?.nameZh === 'string' ? entry.nameZh.trim() : '';
    return /[\u3400-\u9fff]/u.test(name) ? name : '';
  };
  const addIndex = (map, entry, index) => {
    const name = reviewedName(entry);
    if (!name) return;
    const indexes = map.get(name) ?? [];
    indexes.push(index);
    map.set(name, indexes);
  };
  added.forEach((entry, index) => addIndex(addedByName, entry, index));
  removed.forEach((entry, index) => addIndex(removedByName, entry, index));
  current.forEach((entry, index) => addIndex(currentByName, entry, index));

  const foldedAdded = new Set();
  const foldedRemoved = new Set();
  const renamedCountries = [];
  for (const [nameZh, addedIndexes] of addedByName) {
    const removedIndexes = removedByName.get(nameZh) ?? [];
    const currentIndexes = currentByName.get(nameZh) ?? [];
    if (addedIndexes.length !== 1 || removedIndexes.length !== 1 || currentIndexes.length !== 1) continue;
    const addedIndex = addedIndexes[0];
    const removedIndex = removedIndexes[0];
    const from = removed[removedIndex]?.country;
    const to = added[addedIndex]?.country;
    const currentMarket = current[currentIndexes[0]];
    if (!from || !to || from === to || !currentMarket?.marketId || currentMarket.country !== to) continue;
    foldedAdded.add(addedIndex);
    foldedRemoved.add(removedIndex);
    renamedCountries.push({ from, to, nameZh, marketId: currentMarket.marketId });
  }

  return {
    ...source,
    addedCountries: added.filter((_, index) => !foldedAdded.has(index)),
    removedCountries: removed.filter((_, index) => !foldedRemoved.has(index)),
    renamedCountries,
  };
}
'''
if 'export function foldPublicationCountryRenames' not in text:
    data_model.write_text(text.rstrip() + helper + '\n', encoding='utf-8')

# 3) Public UI: show a unique reviewed rename as a rename, and region-only changes as region changes.
script = PROJECT / 'script.js'
text = script.read_text(encoding='utf-8')
old_import = "import { marketSearchPriority, matchesMarketSearch, normalizeMarketSearchText, REGION_LABELS, VALID_REGIONS } from './data-model.js?v=4ddda83e';"
new_import = "import { foldPublicationCountryRenames, marketSearchPriority, matchesMarketSearch, normalizeMarketSearchText, REGION_LABELS, VALID_REGIONS } from './data-model.js?v=4ddda83e';"
if old_import in text:
    text = text.replace(old_import, new_import, 1)
text = text.replace('details.push(`分区 ${fromRegion}→${toRegion}`);', 'details.push(`所属分区 ${fromRegion}→${toRegion}`);', 1)
start = text.index('function createPublishedDateChangesCell(changes, isInitial = false) {')
end = text.index('\nfunction renderPublishedDateHistory()', start)
block = text[start:end]
if 'const displayChanges = foldPublicationCountryRenames' not in block:
    block = block.replace(
        "  const cell = document.createElement('td');",
        "  const displayChanges = foldPublicationCountryRenames(changes, state.data?.countries ?? []);\n  const cell = document.createElement('td');",
        1,
    )
    block = block.replace('changes.', 'displayChanges.')
    marker = "  if (displayChanges.addedCountries?.length) {\n"
    rename_group = """  if (displayChanges.renamedCountries?.length) {
    appendGroup('地区名称变化', displayChanges.renamedCountries
      .map(({ from, to, nameZh }) => `${nameZh}（${from} → ${to}）`)
      .join('、'));
  }
"""
    if marker not in block:
        raise SystemExit('published-date addedCountries marker missing')
    block = block.replace(marker, rename_group + marker, 1)
    block = block.replace(
        "    heading.textContent = '地区内容变化：';",
        "    const onlyRegionChanges = displayChanges.changedCountries.every((entry) => (\n      entry.fromRegion !== entry.toRegion\n      && entry.fromCurrency === entry.toCurrency\n      && !(entry.tiers || []).length\n    ));\n    heading.textContent = onlyRegionChanges ? '所属分区变化：' : '地区内容变化：';",
        1,
    )
    text = text[:start] + block + text[end:]
script.write_text(text, encoding='utf-8')

# 4) Focused unit/contract tests.
test_file = PROJECT / 'test/followup-hardening.test.mjs'
text = test_file.read_text(encoding='utf-8')
text = text.replace(
    "  marketSearchPriority,\n  matchesMarketSearch,\n  normalizeMarketSearchText,\n} from '../data-model.js';",
    "  foldPublicationCountryRenames,\n  marketSearchPriority,\n  matchesMarketSearch,\n  normalizeMarketSearchText,\n} from '../data-model.js';",
    1,
)
monitor_import = """import {
  APPLE_ZH_ICLOUD_URL,
  compareMarketNameSets,
  extractAppleZhMarketNames,
  parseReviewedMarketBaseline,
  validateObservedMarketSet,
} from '../scripts/check-apple-zh-markets.mjs';
"""
registry_marker = "import {\n  createMarketResolver,"
if monitor_import not in text:
    text = text.replace(registry_marker, monitor_import + registry_marker, 1)

extra_tests = r'''

test('Apple Chinese market monitor survives legacy headings, current-style tables, and future local groups', () => {
  const legacy = `
    <main><h2>iCloud+ 定价</h2>
      <h4>巴哈马<sup>2,3</sup>（美元）</h4><ul><li>50GB：$0.99</li><li>200GB：$2.99</li><li>2TB：$10.99</li></ul>
      <h4>中国大陆（人民币）</h4><ul><li>50GB：¥6</li><li>200GB：¥21</li><li>2TB：¥68</li></ul>
      <p>发布日期：2099 年 01 月 01 日</p>
      <p>脚注：阿根廷（美元）等其他信息不应被当成价格市场。</p>
    </main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(legacy)), new Set(['巴哈马', '中国大陆']));

  const table = `
    <main><table><thead><tr><th>国家或地区（货币）</th><th>100 GB</th><th>500 GB</th><th>4 TB</th></tr></thead>
      <tbody><tr><td>日本（日元）</td><td>¥1</td><td>¥2</td><td>¥3</td></tr>
      <tr><td>新加坡（新加坡元）</td><td>S$1</td><td>S$2</td><td>S$3</td></tr></tbody></table></main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(table)), new Set(['日本', '新加坡']));

  const future = `
    <main><section class="whatever"><div class="card"><strong>韩国</strong><div>100GB ₩1</div><div>500GB ₩2</div><div>4TB ₩3</div></div>
      <div class="card"><span>澳大利亚（澳元）</span><span>100GB $1</span><span>500GB $2</span><span>4TB $3</span></div></section>
      <section><div><h3>储存空间为 100GB 的 iCloud+</h3><p>隐藏邮件地址</p></div><div><h3>储存空间为 500GB 的 iCloud+</h3><p>自定义电子邮件域</p></div></section>
    </main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(future)), new Set(['韩国', '澳大利亚']));
});

test('Apple Chinese market monitor compares only market-name sets and ignores order or unrelated page changes', () => {
  const reviewed = ['巴哈马', '中国大陆', '日本'];
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '巴哈马', '中国大陆']), { added: [], removed: [] });
  assert.deepEqual(compareMarketNameSets(reviewed, ['日本', '中国大陆', '新加坡']), { added: ['新加坡'], removed: ['巴哈马'] });
  assert.doesNotThrow(() => validateObservedMarketSet(
    Array.from({ length: 40 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
    Array.from({ length: 60 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
  ));
  assert.throws(() => validateObservedMarketSet(
    Array.from({ length: 40 }, (_, index) => `地区${String.fromCharCode(0x4e00 + index)}`),
    Array.from({ length: 20 }, (_, index) => `完全不同${String.fromCharCode(0x5000 + index)}`),
  ), /overlap|remove/i);
});

test('reviewed Chinese page baseline is independent from marketId mapping and records the current human review', async () => {
  const baseline = JSON.parse(await readFile(new URL('../scripts/apple-zh-reviewed-markets.json', import.meta.url), 'utf8'));
  const names = parseReviewedMarketBaseline(baseline);
  assert.equal(baseline.source, APPLE_ZH_ICLOUD_URL);
  assert.ok(names.includes('刚果共和国'));
  assert.ok(names.includes('毛里求斯'));
  assert.ok(names.includes('莫尔多瓦'));
  assert.equal(names.includes('摩尔多瓦'), false);
});

test('publication UI projection folds only a one-to-one reviewed rename anchored to the current stable market', () => {
  const raw = {
    addedCountries: [
      { country: "Cote D'Ivoire", nameZh: '科特迪瓦' },
      { country: 'New Market', nameZh: 'New Market' },
    ],
    removedCountries: [{ country: 'Ivory Coast', nameZh: '科特迪瓦' }],
    changedCountries: [{ country: 'Pakistan', nameZh: '巴基斯坦', fromRegion: 'Europe, Middle East & Africa', toRegion: 'Asia Pacific' }],
  };
  const display = foldPublicationCountryRenames(raw, [
    { marketId: 'ci', country: "Cote D'Ivoire", nameZh: '科特迪瓦' },
    { marketId: 'us', country: 'United States', nameZh: '美国' },
  ]);
  assert.deepEqual(display.renamedCountries, [{ from: 'Ivory Coast', to: "Cote D'Ivoire", nameZh: '科特迪瓦', marketId: 'ci' }]);
  assert.deepEqual(display.addedCountries, [{ country: 'New Market', nameZh: 'New Market' }]);
  assert.deepEqual(display.removedCountries, []);
  assert.equal(raw.addedCountries.length, 2, 'raw publication evidence remains untouched');
  assert.deepEqual(foldPublicationCountryRenames(raw, []).renamedCountries, [], 'no current stable market means no rename folding');
});

test('Chinese market monitor is an isolated read-only service triggered after the price updater', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/monitor-icloud-zh-markets.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:[\s\S]*?Update iCloud prices[\s\S]*?completed/);
  assert.match(workflow, /permissions:[\s\S]*?contents: read/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.match(workflow, /node scripts\/check-apple-zh-markets\.mjs/);
  const updater = await readFile(new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(updater, /check-apple-zh-markets\.mjs/);
  const monitorSource = await readFile(new URL('../scripts/check-apple-zh-markets.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(monitorSource, /country-names\.zh\.json|writeFile/);
  assert.match(monitorSource, /仅提示人工复核，不自动修改中文名称/);
});
'''
if "Apple Chinese market monitor survives legacy headings" not in text:
    text = text.rstrip() + extra_tests + '\n'
test_file.write_text(text, encoding='utf-8')

# 5) Browser regression for the actual historical rename and Pakistan region move.
ui_test = PROJECT / 'test/ui-smoke.test.mjs'
text = ui_test.read_text(encoding='utf-8')
needle = """        assert.equal(await page.locator('#publishedDateRows tr').count(), expectedHistory.sourcePublishedDates.length);
        assert.equal(
          (await page.locator('#publishedDateRows tr').first().locator('td').first().textContent()).trim(),
          formatUiDate(expectedHistory.sourcePublishedDates.at(-1).publishedDate)
        );
"""
replacement = needle + """        const septemberRenameRow = page.locator('#publishedDateRows tr').filter({ hasText: formatUiDate('2026-09-15') });
        assert.equal(await septemberRenameRow.count(), 1, 'the September publication evidence row must remain available');
        const septemberChangeText = await septemberRenameRow.locator('td').nth(1).innerText();
        assert.match(septemberChangeText, /地区名称变化：/);
        assert.match(septemberChangeText, /科特迪瓦（Ivory Coast → Cote D'Ivoire）/);
        assert.match(septemberChangeText, /所属分区变化：/);
        assert.match(septemberChangeText, /巴基斯坦/);
        assert.doesNotMatch(septemberChangeText, /移除地区：[^\n]*科特迪瓦/);
"""
if 'the September publication evidence row must remain available' not in text:
    if needle not in text:
        raise SystemExit('ui publication history marker missing')
    text = text.replace(needle, replacement, 1)
ui_test.write_text(text, encoding='utf-8')

# 6) Long-lived documentation. The page-list baseline and display-name mapping are intentionally separate.
paragraphs = {
    'README.md': '''\n中文页面自动化只负责非阻塞的“地区名称集合监测”。`scripts/apple-zh-reviewed-markets.json` 保存上一次人工核对过的同一 Apple iCloud+ 简体中文价格页地区名单；监测器只比较规范化后的名称集合，顺序、价格、容量、币种数值、发布日期和排版都不参与变化判定。解析同时覆盖旧式标题+价格列表、国家/地区价格表和具有本地容量上下文的通用分组；提取结果明显异常时只报告监测不可用。`scripts/country-names.zh.json` 继续单独保存已经人工确认到稳定 `marketId` 的中文显示名，监测器绝不自动写入或猜测对应关系。\n''',
    'ARCHITECTURE.md': '''\n中文 iCloud+ 页面监测是与价格发布物理隔离的只读旁路。它在 `Update iCloud prices` workflow 完成后由独立 workflow 触发，只读取同一 Apple 简体中文 108047 页面，并把提取到的国家/地区名称集合与 `apple-zh-reviewed-markets.json` 的人工基线比较。价格、容量、发布日期、市场顺序和 DOM 样式不是监测事实；容量文本只作为识别“这是一段价格市场结构”的局部上下文。旧式标题块、表格和未来的局部分组都走同一名称集合输出，解析异常不得修改基线、中文显示名或主价格数据。\n''',
    'OPERATIONS.md': '''\n- `Monitor Apple Chinese iCloud markets` 是独立只读服务，会在 `Update iCloud prices` 完成后运行，也可手动运行。只有 Apple 中文 iCloud+ 页的国家/地区名称集合相对 `scripts/apple-zh-reviewed-markets.json` 出现新增/移除时才提示人工复核；价格、容量、发布日期、排序或排版变化不提示。抓取/解析不可用只影响这条监测任务，不影响价格 updater。人工核实页面名单后更新该基线；只有能够人工确认到稳定 `marketId` 的中文名称才同步更新 `scripts/country-names.zh.json`。\n''',
}
for rel, paragraph in paragraphs.items():
    path = PROJECT / rel
    doc = path.read_text(encoding='utf-8')
    if paragraph.strip() not in doc:
        path.write_text(doc.rstrip() + '\n' + paragraph, encoding='utf-8')
