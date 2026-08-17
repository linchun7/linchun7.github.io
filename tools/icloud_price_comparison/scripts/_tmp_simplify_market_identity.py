from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'tools/icloud_price_comparison'


def read(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def write(rel, text):
    (ROOT / rel).write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 exact match, got {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label, flags=0):
    next_text, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f'{label}: expected 1 regex match, got {count}')
    return next_text

# 1) Remove browser-facing market-code aliases. data-model keeps only shared region facts.
data_model = """export const VALID_REGIONS = Object.freeze([
  'Americas',
  'Europe, Middle East & Africa',
  'Asia Pacific'
]);

const VALID_REGION_SET = new Set(VALID_REGIONS);

export function isValidRegion(value) {
  return VALID_REGION_SET.has(value);
}
"""
write('tools/icloud_price_comparison/data-model.js', data_model)

# 2) Search is deliberately user-facing only: names/region partial match + exact currency.
script = read('tools/icloud_price_comparison/script.js')
script = regex_once(
    script,
    r"import \{ marketSearchAliases, VALID_REGIONS \} from '(\.\/data-model\.js\?v=[0-9a-f]{8})';",
    r"import { VALID_REGIONS } from '\1';",
    'script data-model import'
)
script = regex_once(
    script,
    r"function normalizedMarketSearchAliases\(country\) \{.*?\n\}\n\nfunction filteredCountries\(\)",
    """function matchesCountrySearch(country, query) {
  if (!query) return true;
  const namesAndRegion = `${country.country} ${country.nameZh ?? ''} ${REGION_LABELS[country.region] || country.region}`.toLocaleLowerCase('zh-CN');
  const currency = country.currency.toLocaleLowerCase('en-US');
  return namesAndRegion.includes(query) || currency === query;
}

function filteredCountries()""",
    'remove marketId/search-alias search helpers',
    flags=re.S
)
script = regex_once(
    script,
    r"function sortedCountries\(\) \{\n  const query = normalizedSearchQuery\(\);\n  return filteredCountries\(\)\.sort\(\(a, b\) => \{\n    const aIdentityPriority = exactSearchIdentityPriority\(a, query\);\n    const bIdentityPriority = exactSearchIdentityPriority\(b, query\);\n    if \(aIdentityPriority !== bIdentityPriority\) return bIdentityPriority - aIdentityPriority;\n",
    """function sortedCountries() {
  return filteredCountries().sort((a, b) => {
""",
    'remove exact identity search sorting'
)
write('tools/icloud_price_comparison/script.js', script)

# 3) Market identity has only three concepts: reviewed current registry, published ledger, deterministic fallback.
registry_path = 'tools/icloud_price_comparison/scripts/market-registry.mjs'
registry = read(registry_path)
registry = replace_once(
    registry,
    "import { RESERVED_MARKET_REGISTRY } from './reserved-market-registry.mjs';\n",
    '',
    'reserved registry import'
)
registry = replace_once(
    registry,
    "  Object.freeze({ id, canonicalName, aliases: Object.freeze(aliases), reserved: false })\n",
    "  Object.freeze({ id, canonicalName, aliases: Object.freeze(aliases) })\n",
    'active registry reserved flag'
)
registry = regex_once(
    registry,
    r"\nfunction reservedRegistryFor\(registry, reservedRegistry\) \{.*?\n\}\n\nexport function createMarketResolver\(registry = MARKET_REGISTRY, \{ reservedRegistry \} = \{\}\) \{.*?\n\}\n\nconst defaultResolver",
    r'''
export function createMarketResolver(registry = MARKET_REGISTRY) {
  const byName = new Map();
  const knownIds = new Set();
  const knownById = new Map();
  const registerMarket = (market) => {
    if (knownIds.has(market.id)) throw new Error(`Duplicate marketId in registry: ${market.id}`);
    knownIds.add(market.id);
    knownById.set(market.id, market);
    for (const name of [market.canonicalName, ...(market.aliases ?? [])]) {
      const key = normalizedNameKey(name);
      if (byName.has(key)) throw new Error(`Duplicate market name or alias in registry: ${name}`);
      byName.set(key, market);
    }
  };
  for (const market of Object.values(registry)) registerMarket(market);

  return (sourceName) => {
    const name = normalizedName(sourceName);
    const known = byName.get(normalizedNameKey(name));
    if (known) return {
      ...known,
      sourceName: name,
      nameZh: getOfficialChineseMarketName(known.id),
      unknown: false
    };
    const digest = createHash('sha256').update(name).digest('hex').slice(0, 8);
    const id = `apple-${slugify(name)}-${digest}`;
    if (knownIds.has(id)) {
      throw reservedIdentityCollisionError(id, name, [{
        sourceName: knownById.get(id).canonicalName,
        location: 'market-registry.mjs'
      }]);
    }
    return { id, canonicalName: name, sourceName: name, nameZh: name, aliases: [], unknown: true };
  };
}

const defaultResolver''',
    'simplify market resolver',
    flags=re.S
)
registry = regex_once(
    registry,
    r"export function createPublishedMarketResolver\(previousData, previousHistory, \{.*?\n\}\n\nexport function validateMarketIdentityContinuity",
    r'''export function createPublishedMarketResolver(previousData, previousHistory, {
  registry = MARKET_REGISTRY,
  resolveUnknown = createMarketResolver(registry)
} = {}) {
  const published = buildPublishedMarketIdentityIndex(previousData, previousHistory);
  return (sourceName) => {
    const name = normalizedName(sourceName);
    const identityKey = normalizedNameKey(name);
    const historical = published.bySourceName.get(identityKey);
    const resolved = resolveUnknown(name);

    if (historical) {
      return {
        ...resolved,
        id: historical.marketId,
        sourceName: name,
        nameZh: getOfficialChineseMarketName(historical.marketId) ?? name,
        published: true,
        preservedPublishedIdentity: resolved.id !== historical.marketId
      };
    }

    const existingOwners = published.ownersById.get(resolved.id);
    if (existingOwners?.length) {
      // A reviewed Apple source-name alias may point at an already-published ID.
      // This is a rename/wording update, not a rekey: the ID remains identical.
      if (!resolved.unknown) {
        const acceptedNames = new Set(
          [resolved.canonicalName, ...(resolved.aliases ?? [])].map(normalizedNameKey)
        );
        if (existingOwners.every(({ identityKey: ownerKey }) => acceptedNames.has(ownerKey))) {
          return {
            ...resolved,
            sourceName: name,
            nameZh: getOfficialChineseMarketName(resolved.id) ?? name,
            published: true,
            preservedPublishedIdentity: false
          };
        }
      }
      throw reservedIdentityCollisionError(resolved.id, name, existingOwners);
    }
    return resolved;
  };
}

export function validateMarketIdentityContinuity''',
    'published resolver alias path',
    flags=re.S
)
registry = regex_once(
    registry,
    r"export function validateMarketIdentityContinuity\(previousData, previousHistory, \{.*?\n\}\n\nexport function attachMarketIdentity",
    r'''export function validateMarketIdentityContinuity(previousData, previousHistory, {
  registry = MARKET_REGISTRY,
  resolve = null
} = {}) {
  const resolver = resolve ?? (registry === MARKET_REGISTRY ? resolveMarket : createMarketResolver(registry));
  const published = buildPublishedMarketIdentityIndex(previousData, previousHistory);
  const publishedNamesById = published.sourceNamesById;
  const checkPublishedIdentity = (sourceName, expectedId, location) => {
    let resolved;
    try {
      resolved = resolver(sourceName);
    } catch (error) {
      throw marketIdentityError(`${location} cannot resolve ${sourceName}: ${error.message}`);
    }
    if (!resolved.unknown && resolved.id !== expectedId) {
      throw marketIdentityError(`${location} maps ${sourceName} from ${expectedId} to ${resolved.id}`);
    }
  };

  if (previousData?.schemaVersion === 4) {
    for (const country of previousData.countries ?? []) {
      checkPublishedIdentity(country.country, country.marketId, 'prices.json');
    }
  }
  if (previousHistory?.schemaVersion === 4) {
    for (const [marketId, record] of Object.entries(previousHistory.markets ?? {})) {
      checkPublishedIdentity(record.country, marketId, 'history.json');
    }
  }

  for (const market of Object.values(registry)) {
    const publishedNames = publishedNamesById.get(market.id);
    if (!publishedNames) continue;
    const registryNames = [market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey);
    if (!registryNames.some((name) => publishedNames.has(name))) {
      throw marketIdentityError(`registry market ${market.canonicalName} occupies published marketId ${market.id}`);
    }
  }
  return { status: 'passed', publishedMarketIds: [...publishedNamesById.keys()].sort() };
}

export function attachMarketIdentity''',
    'simplify continuity validator',
    flags=re.S
)
registry = regex_once(
    registry,
    r"\nexport function validateReservedMarketRegistry\(.*?\n\}\n\nexport function validateMarketRegistry\(registry = MARKET_REGISTRY\) \{.*?\n\}\n?$",
    r'''
export function validateMarketRegistry(registry = MARKET_REGISTRY) {
  if (Object.keys(registry).length === 0 || Object.keys(registry).length > 500) {
    throw new Error(`Market registry is empty or oversized: ${Object.keys(registry).length}`);
  }
  createMarketResolver(registry);
  for (const market of Object.values(registry)) {
    if (!Object.hasOwn(getOfficialChineseMarketNames(), market.id)) {
      throw new Error(`Market registry is missing a Chinese-name authority record for marketId: ${market.id}`);
    }
  }
  return registry;
}
''',
    'remove reserved registry validator',
    flags=re.S
)
write(registry_path, registry)

# 4) Without future reservations, rename review only considers truly unknown source names.
update_prices = read('tools/icloud_price_comparison/scripts/update-prices.mjs')
update_prices = replace_once(
    update_prices,
    "    if (market.published || (!market.unknown && !market.reserved)) continue;\n",
    "    if (!market.unknown || market.published) continue;\n",
    'rename review reserved condition'
)
write('tools/icloud_price_comparison/scripts/update-prices.mjs', update_prices)

# 5) Remove reservation-specific core test from package and repository.
package_path = 'tools/icloud_price_comparison/package.json'
package = read(package_path)
package = replace_once(
    package,
    ' test/documentation-contract.test.mjs test/market-identity-reservations.test.mjs test/market-registry.test.mjs',
    ' test/documentation-contract.test.mjs test/market-registry.test.mjs',
    'package reservation test entry'
)
write(package_path, package)
(PROJECT / 'test/market-identity-reservations.test.mjs').unlink()
(PROJECT / 'scripts/reserved-market-registry.mjs').unlink()

# 6) Registry tests now assert immutable published IDs, deterministic unknown IDs, and reviewed source aliases.
market_test_path = 'tools/icloud_price_comparison/test/market-registry.test.mjs'
market_test = read(market_test_path)
market_test = replace_once(
    market_test,
    "  assert.ok(result.reservedMarketIds.includes('jp'));\n",
    "  assert.ok(result.publishedMarketIds.includes('jp'));\n",
    'published market IDs result name'
)
old = """  assert.doesNotThrow(() => validateWith(
    prices('New Apple Market', unknown.id),
    history('New Apple Market', unknown.id),
    { 'New Apple Market': identity('new-market', 'New Apple Market') }
  ));
"""
new = """  assert.throws(
    () => validateWith(
      prices('New Apple Market', unknown.id),
      history('New Apple Market', unknown.id),
      { 'New Apple Market': identity('new-market', 'New Apple Market') }
    ),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
  );
"""
market_test = replace_once(market_test, old, new, 'published fallback cannot be rekeyed')
anchor = """test('published unknown identities come from schema 4 history instead of the current generator', () => {
"""
addition = """test('standard but currently unknown country names use deterministic fallback IDs without future reservations', () => {
  const germany = resolveMarket('Germany');
  assert.equal(germany.unknown, true);
  assert.match(germany.id, /^apple-germany-[a-f0-9]{8}$/);
});

test('reviewed Apple source aliases keep an already-published marketId', () => {
  const previousData = {
    schemaVersion: 4,
    countries: [{ country: 'Türkiye', marketId: 'tr' }]
  };
  const previousHistory = {
    schemaVersion: 4,
    markets: { tr: { country: 'Türkiye' } }
  };
  const resolver = createPublishedMarketResolver(previousData, previousHistory);
  const resolved = resolver('Turkey');
  assert.equal(resolved.id, 'tr');
  assert.equal(resolved.unknown, false);
  assert.equal(resolved.published, true);
});

""" + anchor
market_test = replace_once(market_test, anchor, addition, 'add simple identity regression tests')
write(market_test_path, market_test)

# 7) Remove reservation-specific updater regression appended by the previous PR.
update_test_path = 'tools/icloud_price_comparison/test/update-prices.test.mjs'
update_test = read(update_test_path)
update_test = regex_once(
    update_test,
    r"\n\ntest\('future-reserved markets still participate in rename ambiguity review'.*?\n\}\);\n?$",
    '\n',
    'remove reserved rename test',
    flags=re.S
)
write(update_test_path, update_test)

# 8) UI tests keep user-facing search coverage but drop marketId/search-alias behavior.
ui_path = 'tools/icloud_price_comparison/test/ui-smoke.test.mjs'
ui = read(ui_path)
ui = replace_once(
    ui,
    """        await page.locator('#searchInput').fill('us');
        await page.waitForFunction((id) => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === id, 'us');
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'us', 'exact marketId search must outrank substring matches such as Russia');

        await page.locator('#searchInput').fill('jp');
        await page.waitForFunction((id) => document.querySelector('#priceRows tr[data-market-id]')?.dataset.marketId === id, 'jp');
        assert.equal(await page.locator('#priceRows tr[data-market-id]').first().getAttribute('data-market-id'), 'jp');

""",
    """        await page.locator('#searchInput').fill('United States');
        await page.waitForFunction(() => document.querySelector('#priceRows')?.textContent?.includes('United States'));

        await page.locator('#searchInput').fill('Japan');
        await page.waitForFunction(() => document.querySelector('#priceRows')?.textContent?.includes('Japan'));

""",
    'mobile search by market ID'
)
ui = regex_once(
    ui,
    r"test\('prioritizes exact market IDs without hiding partial matches and distinguishes mobile sequence numbers'.*?\n\}\);\n\n\ntest\('supports friendly market search aliases and prioritizes exact alias hits'.*?\n\}\);\n?",
    r'''test('supports simple country search and distinguishes mobile sequence numbers', { timeout: 30_000 }, async (context) => {
  const browserConfig = await resolveBrowser(context, 'simple search and mobile sequence regression coverage');
  if (!browserConfig) return;
  const server = await startServer();
  const { port } = server.address();
  const browser = await browserConfig.browserType.launch(browserConfig.launchOptions);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://**/*', (route) => {
    if (route.request().url().startsWith('https://www.googletagmanager.com/')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
    return route.abort();
  });
  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#priceRows tr[data-market-id]').length > 0);
    const search = page.locator('#searchInput');

    await search.fill('rus');
    await page.waitForFunction(() => document.querySelector('#priceRows')?.textContent?.includes('Russia'));
    assert.match(await page.locator('#priceRows').innerText(), /Russia/);

    await search.fill('大利');
    await page.waitForFunction(() => document.querySelector('#priceRows')?.textContent?.includes('澳大利亚'));
    assert.match(await page.locator('#priceRows').innerText(), /澳大利亚/);

    await search.fill('');
    await page.locator('button[data-sort="country"]').click();
    await page.waitForFunction(() => document.querySelector('.mobile-rank')?.textContent === '序1');
    assert.deepEqual(
      await page.locator('#priceRows .mobile-rank').evaluateAll((nodes) => nodes.slice(0, 3).map((node) => node.textContent)),
      ['序1', '序2', '序3']
    );
    assert.equal(await page.locator('#rankHeaderLabel > span[aria-hidden="true"]').innerText(), '序号');

    await page.locator('button[data-sort-tier="200GB"]').click();
    await page.waitForFunction(() => document.querySelector('.mobile-rank')?.textContent === '1');
    assert.equal((await page.locator('#priceRows .mobile-rank').first().innerText()).startsWith('序'), false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true);
  } finally {
    await browser.close();
    await server.close(() => {});
  }
});
''',
    'replace marketId and search alias UI tests',
    flags=re.S
)
write(ui_path, ui)

# 9) Documentation contract protects the simpler architecture and mandatory docs gate.
doc_test = """import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

const [readme, operations, validationWorkflow] = await Promise.all([
  readProjectFile('README.md'),
  readProjectFile('OPERATIONS.md'),
  readFile(new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url), 'utf8')
]);

test('documents the generated SEO source rather than treating index.html as the source of truth', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /render-static-page\\.mjs/);
    assert.match(document, /seoProjection\\(\\)/);
    assert.match(document, /SEO_PROJECTION_MISMATCH/);
  }
});

test('documents the simple immutable market identity model', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /marketId[\\s\\S]*(?:永久冻结|永久不可变)/);
    assert.match(document, /apple-\\*/);
    assert.match(document, /market-registry\\.mjs/);
    assert.doesNotMatch(document, /reserved-market-registry\\.mjs|MARKET_SEARCH_ALIASES/);
    assert.doesNotMatch(document, /migrate-market-id\\.mjs/);
  }
});

test('documents user-facing search without exposing marketId or search aliases as product features', () => {
  assert.match(readme, /中英文国家\/地区[\\s\\S]*地区名称[\\s\\S]*币种/);
  assert.match(readme, /`序N`|`序1`/);
  assert.match(operations, /`序N`/);
  for (const document of [readme, operations]) {
    assert.doesNotMatch(document, /精确 `marketId`|search alias/i);
  }
});

test('PR validation forces critical architecture changes to update both long-lived documents', () => {
  assert.match(validationWorkflow, /强制关键架构更新同步文档/);
  assert.match(validationWorkflow, /tools\\/icloud_price_comparison\\/README\\.md/);
  assert.match(validationWorkflow, /tools\\/icloud_price_comparison\\/OPERATIONS\\.md/);
  assert.match(validationWorkflow, /market-registry/);
  assert.match(validationWorkflow, /data-model/);
});

test('PR validation protects published market IDs across the base and head histories', () => {
  assert.match(validationWorkflow, /强制已发布 marketId 永久保留/);
  assert.match(validationWorkflow, /base-history\\.json/);
  assert.match(validationWorkflow, /removed marketId/i);
});
"""
write('tools/icloud_price_comparison/test/documentation-contract.test.mjs', doc_test)

# 10) README: simplify product/search contracts and replace the entire identity section.
readme_path = 'tools/icloud_price_comparison/README.md'
readme = read(readme_path)
readme = replace_once(
    readme,
    "- 市场身份按“已发布 identity ledger → active registry → future reservation → deterministic `apple-*` fallback”的安全顺序处理。`scripts/reserved-market-registry.mjs` 只提前预留高置信国家/地区 ID，不代表 Apple 当前提供这些市场；真正未识别的 Apple 市场才生成可复现的 `apple-*` ID，确认无冲突后可自动发布。\n",
    "- 市场身份按“已发布 identity ledger → 已审核 Apple source registry → deterministic `apple-*` fallback”处理。未识别的新 Apple 市场直接生成可复现的 `apple-*` ID；一旦发布，该 ID 永久冻结。\n",
    'README identity product boundary'
)
readme = replace_once(
    readme,
    "- 搜索对 `marketId`、人工维护的 search alias、中英文国家/地区名称和地区名称使用部分字符串匹配；完整 `marketId` 命中优先级最高，完整 search alias 次之，但都不排除其他合法部分匹配；币种仅按完整代码匹配，避免短字母把同币种市场全部带出。\n",
    "- 搜索只面向用户可见信息：中英文国家/地区名称和地区名称使用部分字符串匹配，币种仅按完整代码匹配。`marketId` 是内部身份，不作为搜索功能。\n",
    'README search product boundary'
)
readme = replace_once(
    readme,
    "- 支持中英文国家/地区、`marketId`、友好 search alias、地区名称和完整币种代码搜索，以及分区筛选、容量排序、地区排序和 URL 状态恢复；精确 `marketId` 命中优先级最高，精确 alias 次之，但部分匹配仍保留。\n",
    "- 支持中英文国家/地区、地区名称和完整币种代码搜索，以及分区筛选、容量排序、地区排序和 URL 状态恢复。\n",
    'README page search ability'
)
readme = regex_once(
    readme,
    r"## 市场身份、预留 ID 与中文名称\n.*?\n## 页面生成与 SEO",
    r'''## 市场身份与中文名称

`marketId` 只承担**永久内部数据身份**，不承担搜索快捷码或“代码漂亮化”职责。当前规则刻意保持简单：

1. `data/history.json` 是已经发布过的 marketId ledger；已有 ID 永久保留，不因市场下线、Apple 改名或后续维护而重分配。
2. `scripts/market-registry.mjs` 只保存已经人工复核的 Apple source identity：稳定 `marketId`、Apple 英文 canonical name 和必要的 source-name aliases。这里的 alias 仅用于识别 Apple 自己的英文名称变化，不参与浏览器搜索。
3. Apple 首次出现、且不在已审核 registry 中的市场，直接生成确定性的 `apple-<slug>-<hash>` ID，并记录 `UNKNOWN_APPLE_MARKET`。通过正常 Apple 语义确认且无历史 ID 冲突后可以自动发布；一旦发布，这个 `apple-*` 也永久不改。
4. 不维护“未来可能出现的 ISO marketId 预留表”，也不为了让用户输入 `us`、`jp` 等代码搜索而增加另一套 identity/search alias 映射。

如果 Apple 只是调整了已知市场的英文 source wording，应把新 wording 作为 `market-registry.mjs` 中同一永久 ID 的 source alias；resolver 会继续使用原 ID。若新名称仍无法确定是不是旧市场改名，则保持现有严格 rename-review：高置信歧义停止并要求人工复核，弱信号只记录 warning，不自动合并身份。

中文名称独立遵守 Apple 来源规则：`scripts/country-names.zh.json` 是 Apple 简体中文市场名称唯一事实源。已审核 wording 保存字符串；尚待 Apple zh-CN wording 确认则保存 `null` 或视为 pending，前端继续显示 Apple 英文 `sourceName` 并记录 `CHINESE_MARKET_NAME_PENDING`。

### marketId 永久不可变

`marketId` 一旦进入已发布 `history.json` 就永久不可变。普通代码、registry、价格更新和搜索调整都不能删除或替换历史 marketId。PR 验证会把 base 分支的 `history.json` 与候选版本比较：base 中已有的每一个 marketId 在 head 中都必须继续存在，从而避免同时改写 `prices.json`、`history.json` 和 registry 后形成“内部自洽但已经 rekey”的新世界。

仓库不提供日常 rekey/migration 工具。如果未来确认某个历史 identity 本身就是错误绑定，应把它当作独立数据事故处理，单独设计一次性修复、回滚和全历史验证，而不是恢复常规改 ID 能力。

长期边界由 `test/market-registry.test.mjs`、`test/documentation-contract.test.mjs` 以及 PR validation 的 base→head history 门禁共同保护。

## 页面生成与 SEO''',
    'README identity section',
    flags=re.S
)
write(readme_path, readme)

# 11) OPERATIONS: same simple contract; keep mandatory docs sync gate.
ops_path = 'tools/icloud_price_comparison/OPERATIONS.md'
ops = read(ops_path)
ops = replace_once(
    ops,
    "- schema 4；一个市场只要正式发布过一次，其 `marketId` 永久冻结。普通更新、registry 调整、future candidate 或搜索优化都不得 rekey。\n",
    "- schema 4；一个市场只要正式发布过一次，其 `marketId` 永久冻结。普通更新、registry 调整或搜索优化都不得 rekey。\n",
    'OPERATIONS immutable boundary'
)
ops = replace_once(
    ops,
    "- 新 Apple 市场先匹配 active registry，再匹配 `reserved-market-registry.mjs` 的高置信 future reservation；二者都未命中时才生成确定性 `apple-*` ID。future reservation 不是 Apple 可用性声明，真正 unknown 完成正常语义确认且无冲突后仍允许自动发布。\n",
    "- 新 Apple 市场先匹配已审核 `market-registry.mjs`；未命中时直接生成确定性 `apple-*` ID。真正 unknown 完成正常 Apple 语义确认且无历史 ID 冲突后仍允许自动发布，发布后 ID 永久冻结。\n",
    'OPERATIONS new market boundary'
)
ops = replace_once(
    ops,
    "- 搜索对 `marketId`、`MARKET_SEARCH_ALIASES`、中英文国家/地区名和地区名做部分匹配；完整 `marketId` 优先级最高，完整 search alias 次之，均不排除其他部分匹配；币种只按完整代码匹配。\n",
    "- 搜索只使用用户可见信息：中英文国家/地区名和地区名做部分匹配；币种只按完整代码匹配。`marketId` 不作为用户搜索快捷码。\n",
    'OPERATIONS search boundary'
)
ops = regex_once(
    ops,
    r"## 6\. Market identity、预留 ID 与中文名称\n.*?\n## 7\. Freshness、异常和 fallback",
    r'''## 6. Market identity 与中文名称

- `marketId` 是永久内部数据身份，不是用户搜索码。已经写入 `history.json` 的 ID 永久保留；市场暂时下线也不得复用。
- `scripts/market-registry.mjs` 只维护已经人工复核的 Apple source identity：稳定 ID、Apple 英文 canonical name 和必要 source-name aliases。source alias 只处理 Apple 英文名称变化，不参与前端搜索。
- 不维护 future/ISO marketId reservation。Apple 首次出现且未命中 registry 的市场直接生成 deterministic `apple-*` fallback，记录 `UNKNOWN_APPLE_MARKET`；完成正常语义确认且无历史冲突后可以发布，发布后该 ID 同样永久冻结。
- Apple 已知市场如果只是 source wording 改名，应把新 wording 加到同一永久 ID 的 registry aliases。resolver 允许经过审核的 alias 继续指向已经发布的同一 ID；不得借 alias 改成另一个 ID。
- 不做模糊名称自动绑定。只有严格高置信 identity ambiguity 才停止并要求人工复核；repricing、多候选或其他弱信号只记录 `MARKET_IDENTITY_RENAME_SUSPECTED`。
- `scripts/country-names.zh.json` 仍是 Apple 简体中文名称唯一事实源；pending 使用 Apple 英文 source name 并记录 `CHINESE_MARKET_NAME_PENDING`。

### marketId 永久不可变

PR validation 会读取 base 分支与候选分支的 `data/history.json`。base 中已经存在的每一个 marketId 在 head 中都必须继续存在；因此即使有人同时修改 `prices.json`、`history.json` 和 registry，也不能把一个已发布身份整体 rekey 成另一个内部自洽的新 ID。

仓库不提供常规 marketId migration/rekey 工具。若未来确认某个已发布 identity 本身就是错误绑定，应按数据事故单独设计一次性修复方案，明确影响面、回滚和全历史验证；不要为了 ISO 两位码、代码更短或搜索方便而修改已发布 ID。

长期边界由 `test/market-registry.test.mjs`、`test/documentation-contract.test.mjs` 和 PR validation 的 base→head history 门禁保护。

## 7. Freshness、异常和 fallback''',
    'OPERATIONS identity section',
    flags=re.S
)
write(ops_path, ops)

# 12) Assert the complexity layers are actually gone from project source/docs/tests.
for path in PROJECT.rglob('*'):
    if not path.is_file() or path.name.startswith('_tmp_simplify_market_identity'):
        continue
    if path.suffix not in {'.js', '.mjs', '.md', '.json'}:
        continue
    text = path.read_text(encoding='utf-8', errors='ignore')
    if 'reserved-market-registry.mjs' in text or 'MARKET_SEARCH_ALIASES' in text or 'marketSearchAliases(' in text:
        raise RuntimeError(f'legacy identity complexity remains in {path.relative_to(ROOT)}')

print('identity simplification patch applied')
