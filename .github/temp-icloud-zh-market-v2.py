from pathlib import Path

ROOT = Path('.')
PROJECT = ROOT / 'tools/icloud_price_comparison'


def replace_once(path, old, new):
    text = path.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'marker not found in {path}: {old[:120]!r}')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')


# Shared presentation helper: only folds one-to-one pairs that already share a reviewed Chinese name.
data_model = PROJECT / 'data-model.js'
text = data_model.read_text(encoding='utf-8')
helper = r'''

export function foldPublicationCountryRenames(changes) {
  const source = changes && typeof changes === 'object' ? changes : {};
  const added = Array.isArray(source.addedCountries) ? source.addedCountries : [];
  const removed = Array.isArray(source.removedCountries) ? source.removedCountries : [];
  const addedByName = new Map();
  const removedByName = new Map();
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

  const foldedAdded = new Set();
  const foldedRemoved = new Set();
  const renamedCountries = [];
  for (const [nameZh, addedIndexes] of addedByName) {
    const removedIndexes = removedByName.get(nameZh) ?? [];
    if (addedIndexes.length !== 1 || removedIndexes.length !== 1) continue;
    const addedIndex = addedIndexes[0];
    const removedIndex = removedIndexes[0];
    const from = removed[removedIndex]?.country;
    const to = added[addedIndex]?.country;
    if (!from || !to || from === to) continue;
    foldedAdded.add(addedIndex);
    foldedRemoved.add(removedIndex);
    renamedCountries.push({ from, to, nameZh });
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

# Browser uses the shared helper but raw history evidence remains untouched.
script = PROJECT / 'script.js'
replace_once(
    script,
    "import { marketSearchPriority, matchesMarketSearch, normalizeMarketSearchText, REGION_LABELS, VALID_REGIONS } from './data-model.js?v=4ddda83e';",
    "import { foldPublicationCountryRenames, marketSearchPriority, matchesMarketSearch, normalizeMarketSearchText, REGION_LABELS, VALID_REGIONS } from './data-model.js?v=4ddda83e';",
)
text = script.read_text(encoding='utf-8')
text = text.replace('details.push(`分区 ${fromRegion}→${toRegion}`);', 'details.push(`所属分区 ${fromRegion}→${toRegion}`);', 1)
start = text.index('function createPublishedDateChangesCell(changes, isInitial = false) {')
end = text.index('\nfunction renderPublishedDateHistory()', start)
block = text[start:end]
block = block.replace(
    "  const cell = document.createElement('td');",
    "  const displayChanges = foldPublicationCountryRenames(changes);\n  const cell = document.createElement('td');",
    1,
)
block = block.replace('changes.', 'displayChanges.')
marker = "  if (displayChanges.addedCountries?.length) {\n"
rename_group = """  if (displayChanges.renamedCountries?.length) {\n    appendGroup('地区名称变化', displayChanges.renamedCountries\n      .map(({ from, to, nameZh }) => `${nameZh}（${from} → ${to}）`)\n      .join('、'));\n  }\n"""
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

# Add the monitor as a deliberately non-blocking sidecar to the existing update job.
workflow = ROOT / '.github/workflows/update-icloud-prices.yml'
replace_once(
    workflow,
    "      - name: 安装项目依赖\n        run: pnpm install --frozen-lockfile --ignore-scripts\n\n      - name: 抓取并校验 Apple 价格",
    "      - name: 安装项目依赖\n        run: pnpm install --frozen-lockfile --ignore-scripts\n\n      - name: 监测 Apple 中文 iCloud+ 地区列表\n        id: zh_market_monitor\n        continue-on-error: true\n        run: node scripts/check-apple-zh-markets.mjs\n\n      - name: 抓取并校验 Apple 价格",
)

# Focused regression tests: old headings, table layout, future card/list-like markup, noise isolation, and UI rename projection.
test_file = PROJECT / 'test/followup-hardening.test.mjs'
text = test_file.read_text(encoding='utf-8')
text = text.replace(
    "  marketSearchPriority,\n  matchesMarketSearch,\n  normalizeMarketSearchText,\n} from '../data-model.js';",
    "  foldPublicationCountryRenames,\n  marketSearchPriority,\n  matchesMarketSearch,\n  normalizeMarketSearchText,\n} from '../data-model.js';",
    1,
)
monitor_import = """import {\n  compareMarketNameSets,\n  extractAppleZhMarketNames,\n  validateObservedMarketSet,\n} from '../scripts/check-apple-zh-markets.mjs';\n"""
registry_import = "import {\n  createMarketResolver,"
if monitor_import not in text:
    text = text.replace(registry_import, monitor_import + registry_import, 1)

extra_tests = r'''

test('Apple Chinese market monitor survives legacy headings, tables, and future card-like markup', () => {
  const legacy = `
    <main><h2>iCloud+ 定价</h2>
      <h4>巴哈马<sup>2,3</sup>（美元）</h4><ul><li>50GB：$0.99</li><li>200GB：$2.99</li><li>2TB：$10.99</li></ul>
      <h4>中国大陆（人民币）</h4><ul><li>50GB：¥6</li><li>200GB：¥21</li><li>2TB：¥68</li></ul>
      <p>发布日期：2099 年 01 月 01 日</p>
      <p>脚注：阿根廷（美元）等其他信息不应被当成价格市场。</p>
    </main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(legacy)), new Set(['巴哈马', '中国大陆']));

  const table = `
    <main><table><thead><tr><th>国家或地区（货币）</th><th>50 GB</th><th>200 GB</th><th>2 TB</th></tr></thead>
      <tbody><tr><td>日本（日元）</td><td>¥150</td><td>¥450</td><td>¥1500</td></tr>
      <tr><td>新加坡（新加坡元）</td><td>S$1.48</td><td>S$3.98</td><td>S$13.98</td></tr></tbody></table></main>`;
  assert.deepEqual(new Set(extractAppleZhMarketNames(table)), new Set(['日本', '新加坡']));

  const future = `
    <main><section class="whatever"><div class="card"><strong>韩国</strong><div>50GB ₩1100</div><div>200GB ₩4400</div><div>2TB ₩14000</div></div>
      <div class="card"><span>澳大利亚（澳元）</span><span>50GB $1.49</span><span>200GB $4.49</span><span>2TB $14.99</span></div></section></main>`;
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

test('publication UI projection folds only one-to-one reviewed Chinese-name renames', () => {
  const raw = {
    addedCountries: [
      { country: "Cote D'Ivoire", nameZh: '科特迪瓦' },
      { country: 'New Market', nameZh: 'New Market' },
    ],
    removedCountries: [{ country: 'Ivory Coast', nameZh: '科特迪瓦' }],
    changedCountries: [{ country: 'Pakistan', nameZh: '巴基斯坦', fromRegion: 'Europe, Middle East & Africa', toRegion: 'Asia Pacific' }],
  };
  const display = foldPublicationCountryRenames(raw);
  assert.deepEqual(display.renamedCountries, [{ from: 'Ivory Coast', to: "Cote D'Ivoire", nameZh: '科特迪瓦' }]);
  assert.deepEqual(display.addedCountries, [{ country: 'New Market', nameZh: 'New Market' }]);
  assert.deepEqual(display.removedCountries, []);
  assert.equal(raw.addedCountries.length, 2, 'raw publication evidence remains untouched');
});

test('scheduled updater keeps Chinese market monitoring non-blocking and human-gated', async () => {
  const workflow = await readFile(new URL('../../../.github/workflows/update-icloud-prices.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: 监测 Apple 中文 iCloud\+ 地区列表[\s\S]*?continue-on-error: true[\s\S]*?node scripts\/check-apple-zh-markets\.mjs/);
  const monitor = await readFile(new URL('../scripts/check-apple-zh-markets.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(monitor, /writeFile|country-names\.zh\.json[^\n]*=/);
  assert.match(monitor, /仅提示人工复核，不自动修改中文名称/);
});
'''
if "Apple Chinese market monitor survives legacy headings" not in text:
    text = text.rstrip() + extra_tests + '\n'
test_file.write_text(text, encoding='utf-8')

# Keep the long-lived docs explicit about the intentionally narrow monitor.
for rel, paragraph in {
    'README.md': '\n中文页自动化只做非阻塞的“地区名称集合监测”：从同一 Apple iCloud+ 简体中文页提取可识别的国家/地区名称，与 `country-names.zh.json` 中已人工确认的非空名称集合比较。价格、容量、币种数值、发布日期、页面顺序和样式改动都不构成变化；只有名称集合新增/移除才在 Action summary 提醒人工复核。抓取或解析异常不得阻塞英文价格更新，也不得自动写入中文名称。\n',
    'ARCHITECTURE.md': '\n中文 iCloud+ 页面另有一个非阻塞旁路监测器，但它不是第二价格源：监测器只提取国家/地区名称集合，并与 `country-names.zh.json` 的人工确认集合比较；价格、容量、发布日期、顺序与 DOM 样式均不进入变化判定。解析器同时接受旧式标题块、价格表格和有容量上下文的通用卡片/列表形态；若提取结果明显异常则只报告监测不可用，主价格链路继续执行。\n',
    'OPERATIONS.md': '\n- `Update iCloud prices` 会 best-effort 检查同一 Apple 简体中文 iCloud+ 页面中的地区名称集合。只有新增/移除名称才提示人工复核；价格、容量、发布日期或排版变化不提示。该步骤 `continue-on-error`，失败不影响主更新，也不会自动修改 `country-names.zh.json`。人工核对后直接更新该映射即可视为确认新的中文地区基线。\n',
}.items():
    path = PROJECT / rel
    doc = path.read_text(encoding='utf-8')
    key = paragraph.strip()
    if key not in doc:
        path.write_text(doc.rstrip() + '\n' + paragraph, encoding='utf-8')
