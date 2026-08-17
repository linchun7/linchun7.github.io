from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / 'tools/icloud_price_comparison'


def read(path):
    return path.read_text(encoding='utf-8')


def write(path, text):
    path.write_text(text, encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 exact match, found {count}')
    return text.replace(old, new, 1)


def regex_once(text, pattern, replacement, label):
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'{label}: expected 1 regex match, found {count}')
    return updated


# 1) market identity: published IDs are permanent; future reservations must not reuse history IDs.
path = PROJECT / 'scripts/market-registry.mjs'
text = read(path)
text = replace_once(
    text,
    "        nameZh: getOfficialChineseMarketName(historical.marketId) ?? name,\n        published: true,\n        preservedPublishedIdentity: resolved.id !== historical.marketId\n",
    "        nameZh: getOfficialChineseMarketName(historical.marketId) ?? name,\n        reserved: false,\n        published: true,\n        preservedPublishedIdentity: resolved.id !== historical.marketId\n",
    'published resolver state'
)
old = """  for (const market of Object.values(registry)) {
    const publishedNames = publishedNamesById.get(market.id);
    if (!publishedNames) continue;
    const registryNames = [market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey);
    if (!registryNames.some((name) => publishedNames.has(name))) {
      throw marketIdentityError(`registry market ${market.canonicalName} occupies reserved marketId ${market.id}`);
    }
  }
  return { status: 'passed', reservedMarketIds: [...publishedNamesById.keys()].sort() };
"""
new = """  for (const market of Object.values(registry)) {
    const publishedNames = publishedNamesById.get(market.id);
    if (!publishedNames) continue;
    const registryNames = [market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey);
    if (!registryNames.some((name) => publishedNames.has(name))) {
      throw marketIdentityError(`registry market ${market.canonicalName} occupies reserved marketId ${market.id}`);
    }
  }

  // Future ID candidates are allowed to name an already-published identity only when
  // every historical owner is the same reviewed source identity. This makes a bad
  // reservation fail in CI, before Apple ever activates that market name.
  for (const market of Object.values(reservedRegistryFor(registry))) {
    const owners = published.ownersById.get(market.id);
    if (!owners?.length) continue;
    const acceptedNames = new Set([market.canonicalName, ...(market.aliases ?? [])].map(normalizedNameKey));
    const conflicts = owners.filter(({ identityKey }) => !acceptedNames.has(identityKey));
    if (conflicts.length) {
      const occupiedBy = conflicts.map(({ sourceName, location }) => `${sourceName} (${location})`).join(', ');
      throw marketIdentityError(`future market ${market.canonicalName} cannot reserve historical marketId ${market.id}; occupied by ${occupiedBy}`);
    }
  }
  return { status: 'passed', reservedMarketIds: [...publishedNamesById.keys()].sort() };
"""
text = replace_once(text, old, new, 'historical reservation collision check')
write(path, text)

# 2) reserved-but-not-yet-published markets must still go through rename ambiguity review.
path = PROJECT / 'scripts/update-prices.mjs'
text = read(path)
text = replace_once(
    text,
    "    if (!market.unknown || market.published) continue;\n",
    "    if (market.published || (!market.unknown && !market.reserved)) continue;\n",
    'reserved rename review condition'
)
write(path, text)

# 3) search aliases remain a UI concern, but gain a strict global validator.
path = PROJECT / 'data-model.js'
text = read(path)
text = replace_once(
    text,
    "export function marketSearchAliases(marketId) {\n  return MARKET_SEARCH_ALIASES[marketId] ?? [];\n}\n",
    """export function marketSearchAliases(marketId) {
  return MARKET_SEARCH_ALIASES[marketId] ?? [];
}

export function validateMarketSearchAliases(aliasMap = MARKET_SEARCH_ALIASES, marketIds = []) {
  if (!aliasMap || typeof aliasMap !== 'object' || Array.isArray(aliasMap)) {
    throw new Error('Market search aliases must be an object');
  }
  const knownIds = new Set(marketIds);
  const exactOwners = new Map();
  for (const [marketId, aliases] of Object.entries(aliasMap)) {
    if (knownIds.size && !knownIds.has(marketId)) {
      throw new Error(`Market search alias target is not a known marketId: ${marketId}`);
    }
    if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 32) {
      throw new Error(`Market search aliases are invalid for marketId: ${marketId}`);
    }
    const localAliases = new Set();
    for (const alias of aliases) {
      const normalized = typeof alias === 'string' ? alias.toLocaleLowerCase('en-US') : '';
      if (typeof alias !== 'string'
        || alias !== alias.trim()
        || alias !== normalized
        || [...alias].length === 0
        || [...alias].length > 80
        || /[\0-\x1f\x7f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff\ufffd]/u.test(alias)) {
        throw new Error(`Unsafe market search alias for ${marketId}: ${String(alias)}`);
      }
      if (localAliases.has(normalized)) {
        throw new Error(`Duplicate market search alias for ${marketId}: ${alias}`);
      }
      localAliases.add(normalized);
      if (knownIds.has(normalized) && normalized !== marketId) {
        throw new Error(`Market search alias ${alias} shadows marketId ${normalized}`);
      }
      const existingOwner = exactOwners.get(normalized);
      if (existingOwner && existingOwner !== marketId) {
        throw new Error(`Market search alias ${alias} belongs to both ${existingOwner} and ${marketId}`);
      }
      exactOwners.set(normalized, marketId);
    }
  }
  return aliasMap;
}
""",
    'search alias validator'
)
write(path, text)

# 4) simplify tests: remove routine rekey coverage and replace with permanent-ID / collision / alias contracts.
path = PROJECT / 'test/market-identity-reservations.test.mjs'
text = read(path)
text = text.replace("import { readFile } from 'node:fs/promises';\n", '')
text = replace_once(
    text,
    "import {\n  createPublishedMarketResolver,\n  resolveMarket,\n  validateMarketIdentityContinuity,\n  validateReservedMarketRegistry\n} from '../scripts/market-registry.mjs';\nimport { RESERVED_MARKET_REGISTRY } from '../scripts/reserved-market-registry.mjs';\nimport { migrateMarketIdentityPayloads } from '../scripts/migrate-market-id.mjs';\n\nconst pricesUrl = new URL('../data/prices.json', import.meta.url);\nconst historyUrl = new URL('../data/history.json', import.meta.url);\n",
    "import {\n  MARKET_REGISTRY,\n  createPublishedMarketResolver,\n  resolveMarket,\n  validateMarketIdentityContinuity,\n  validateReservedMarketRegistry\n} from '../scripts/market-registry.mjs';\nimport { RESERVED_MARKET_REGISTRY } from '../scripts/reserved-market-registry.mjs';\nimport { MARKET_SEARCH_ALIASES, validateMarketSearchAliases } from '../data-model.js';\n",
    'identity reservation imports'
)
replacement = """
test('future reservations fail in CI when a friendly ID is already owned by different history', () => {
  const previousHistory = {
    schemaVersion: 4,
    markets: { de: { country: 'Legacy German Code Owner' } }
  };
  assert.throws(
    () => validateMarketIdentityContinuity(null, previousHistory),
    (error) => error.code === 'MARKET_IDENTITY_REKEY'
      && /future market Germany cannot reserve historical marketId de/.test(error.message)
  );
});

test('search aliases are unique, safe, and cannot shadow active or future identity codes', () => {
  const marketIds = [
    ...Object.values(MARKET_REGISTRY).map(({ id }) => id),
    ...Object.values(RESERVED_MARKET_REGISTRY).map(({ id }) => id)
  ];
  assert.equal(validateMarketSearchAliases(MARKET_SEARCH_ALIASES, marketIds), MARKET_SEARCH_ALIASES);
  assert.throws(
    () => validateMarketSearchAliases({ us: ['friendly'], gb: ['friendly'] }, marketIds),
    /belongs to both/
  );
  assert.throws(
    () => validateMarketSearchAliases({ us: ['de'] }, marketIds),
    /shadows marketId de/
  );
});

test('does not ship a routine marketId rekey tool after an identity has been published', async () => {
  await assert.rejects(
    import('../scripts/migrate-market-id.mjs'),
    (error) => error?.code === 'ERR_MODULE_NOT_FOUND'
  );
});
"""
text = regex_once(
    text,
    r"\ntest\('explicit migration can move a reviewed apple-\* fallback[\s\S]*$",
    replacement,
    'remove routine migration tests'
)
write(path, text)

# 5) reserved market regression for rename review.
path = PROJECT / 'test/update-prices.test.mjs'
text = read(path)
text += """

test('future-reserved markets still participate in rename ambiguity review', () => {
  const old = {
    country: 'Old Germany Placeholder', marketId: 'legacy-de-owner', region: 'Europe, Middle East & Africa', currency: 'EUR',
    plans: { '50GB': { price: 0.99 }, '200GB': { price: 2.99 } }
  };
  const added = {
    country: 'Germany', region: old.region, currency: old.currency,
    plans: structuredClone(old.plans)
  };
  assert.equal(resolveMarket('Germany').reserved, true);
  assert.throws(
    () => validateAppleMarketRenameReview({ countries: [old] }, [added], resolveMarket),
    (error) => error.code === 'MARKET_IDENTITY_RENAME_REVIEW_REQUIRED'
  );

  const repriced = structuredClone(added);
  repriced.plans['50GB'].price = 1.09;
  const review = validateAppleMarketRenameReview({ countries: [old] }, [repriced], resolveMarket);
  assert.equal(review.status, 'suspected');
  assert.equal(review.warnings.length, 1);
  assert.equal(review.warnings[0].pricesMatch, false);
});
"""
write(path, text)

# 6) future catalog wording: identity candidate dictionary, not a market prediction system.
path = PROJECT / 'scripts/reserved-market-registry.mjs'
text = read(path)
text = replace_once(
    text,
    "// Stable reservations for plausible future Apple market identities.\n// This catalog is not a claim that Apple currently offers iCloud+ in every listed country/region.\n// IDs use ISO 3166-1 alpha-2 where available; Kosovo uses the widely used xk reservation.\n",
    "// Stable identity candidates for Apple market names that are not currently active.\n// This is a naming/ID dictionary, not a prediction or claim that Apple offers iCloud+ in these places.\n// IDs use ISO 3166-1 alpha-2 where available; Kosovo uses the widely used xk reservation.\n",
    'reserved catalog wording'
)
write(path, text)

# 7) documentation: published marketId is permanent; remove the standing rekey procedure.
path = PROJECT / 'README.md'
text = read(path)
text = replace_once(
    text,
    "- 公共数据使用 schema 4，市场使用稳定 `marketId`。\n",
    "- 公共数据使用 schema 4；一个市场只要正式发布过一次，其 `marketId` 就永久冻结，不做常规 rekey。\n",
    'README immutable product contract'
)
text = replace_once(
    text,
    "| `data/history.json` | 以 `marketId` 为键的价格/币种事件和 Apple 发布日期事件 | 只有实际事件、迁移或结构变化时才改写；历史市场 ID 永久保留 |\n",
    "| `data/history.json` | 以 `marketId` 为键的价格/币种事件和 Apple 发布日期事件 | 只有实际事件或结构变化时才改写；已经发布的市场 ID 永久保留且不 rekey |\n",
    'README history contract'
)
text = replace_once(
    text,
    "如果一个真正未知市场已经以 `apple-*` fallback 发布，后来才确认它对应某个友好代码，**默认不 rekey**：已发布 identity 继续保持 sticky，可以给原 `marketId` 增加合适的 `MARKET_SEARCH_ALIASES`，让用户用友好代码找到它而不破坏历史。\n",
    "如果一个真正未知市场已经以 `apple-*` fallback 发布，后来才确认它对应某个友好代码，**仍然不 rekey**：这个 `apple-*` 就是该市场的永久 identity。只给原 `marketId` 增加合适的 `MARKET_SEARCH_ALIASES`，让用户用友好代码找到它而不破坏历史。\n",
    'README sticky fallback'
)
text = regex_once(
    text,
    r"### 极少数显式 marketId migration\n[\s\S]*?\n## 页面生成与 SEO",
    """### marketId 永久不可变

`marketId` 一旦进入已发布的 `prices.json` / `history.json` identity ledger 就不再修改。仓库不提供日常 rekey/migration 工具，也不允许为了代码更短、ISO 代码更漂亮或搜索更方便而迁移历史身份。友好搜索需求只通过 `MARKET_SEARCH_ALIASES` 解决；如果未来发现真正的历史身份错误，应针对该事故单独设计、审核和验证一次性修复，而不是建立常规改 ID 通道。

长期边界由 `test/market-registry.test.mjs`、`test/market-identity-reservations.test.mjs` 和 `test/documentation-contract.test.mjs` 共同保护。

## 页面生成与 SEO""",
    'README remove migration procedure'
)
validation_needle = "完整 `pnpm test` 等价于 core 后执行三浏览器验收。\n"
text = replace_once(
    text,
    validation_needle,
    validation_needle + "\n关键架构文件发生变化时，PR CI 会强制要求 `README.md` 与 `OPERATIONS.md` 同步修改；只改代码不更新这两份长期文档会直接失败。文档契约测试随后继续校验关键规则内容，避免只做空白式文档改动。\n",
    'README docs sync gate'
)
write(path, text)

path = PROJECT / 'OPERATIONS.md'
text = read(path)
text = replace_once(
    text,
    "- schema 4 与稳定 `marketId`。\n",
    "- schema 4；一个市场只要正式发布过一次，其 `marketId` 永久冻结。普通更新、registry 调整、future candidate 或搜索优化都不得 rekey。\n",
    'OPERATIONS immutable product contract'
)
text = replace_once(
    text,
    "- 已发布 `apple-*` fallback 默认保持 sticky。后来确认了更友好的代码时，优先在 `data-model.js` 的 `MARKET_SEARCH_ALIASES` 添加用户搜索 alias，不改变价格/历史 identity。\n",
    "- 已发布 `apple-*` fallback 永久保持原 ID。后来确认了更友好的代码时，只在 `data-model.js` 的 `MARKET_SEARCH_ALIASES` 添加用户搜索 alias，不改变价格/历史 identity。\n",
    'OPERATIONS sticky fallback'
)
text = regex_once(
    text,
    r"### 显式 rekey 的极少数处理流程\n[\s\S]*?\n长期边界由 `test/market-registry\.test\.mjs`、`test/market-identity-reservations\.test\.mjs` 和 `test/documentation-contract\.test\.mjs` 保护。",
    """### marketId 永久不可变

已经发布的 `marketId` 不再提供常规迁移路径。active registry、future identity candidate 和搜索 alias 都只能影响**尚未首次发布**的身份选择或用户检索，不能覆盖 `prices.json` / `history.json` 的已发布 ledger。不得为了缩短 ID、改用 ISO 两位码或改善搜索而手工重写历史 key。

如果未来确认某个已发布 identity 本身就是错误绑定，应按数据事故单独设计一次性修复方案，明确影响面、回滚和全历史验证；这不属于日常运维能力，也不在仓库保留通用 rekey 工具。

长期边界由 `test/market-registry.test.mjs`、`test/market-identity-reservations.test.mjs` 和 `test/documentation-contract.test.mjs` 保护。""",
    'OPERATIONS remove migration procedure'
)
text = replace_once(
    text,
    "- `git diff --check`\n",
    "- `git diff --check`\n- 对关键架构 PR 执行文档同步门禁：命中 identity、数据契约、核心搜索/生成器或关键 update/validate workflow 时，`README.md` 与 `OPERATIONS.md` 必须同时进入 diff。\n",
    'OPERATIONS docs sync gate'
)
write(path, text)

# 8) documentation contract becomes both content-level and workflow-enforced.
path = PROJECT / 'test/documentation-contract.test.mjs'
text = read(path)
text = replace_once(
    text,
    "const [readme, operations] = await Promise.all([\n  readProjectFile('README.md'),\n  readProjectFile('OPERATIONS.md')\n]);\n",
    "const [readme, operations, validationWorkflow] = await Promise.all([\n  readProjectFile('README.md'),\n  readProjectFile('OPERATIONS.md'),\n  readFile(new URL('../../../.github/workflows/validate-icloud-price-comparison.yml', import.meta.url), 'utf8')\n]);\n",
    'documentation contract workflow input'
)
text = regex_once(
    text,
    r"\ntest\('documents the explicit fallback market ID migration path'[\s\S]*?\n\}\);\n",
    """
test('documents published market IDs as permanent and removes the routine rekey path', () => {
  for (const document of [readme, operations]) {
    assert.match(document, /marketId[\s\S]*(?:永久冻结|永久不可变)/);
    assert.doesNotMatch(document, /migrate-market-id\.mjs/);
  }
});
""",
    'documentation immutable identity contract'
)
text += """

test('PR validation forces critical architecture changes to update both long-lived documents', () => {
  assert.match(validationWorkflow, /强制关键架构更新同步文档/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/README\.md/);
  assert.match(validationWorkflow, /tools\/icloud_price_comparison\/OPERATIONS\.md/);
  assert.match(validationWorkflow, /market-registry/);
  assert.match(validationWorkflow, /data-model/);
});
"""
write(path, text)

# 9) PR-level diff gate: critical architecture code cannot change without both docs.
path = ROOT / '.github/workflows/validate-icloud-price-comparison.yml'
text = read(path)
old_checkout = """      - name: 检出仓库
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: 配置 Node.js
"""
new_checkout = """      - name: 检出仓库
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: 强制关键架构更新同步文档
        if: github.event_name == 'pull_request'
        working-directory: .
        env:
          BASE_SHA: ${{ github.event.pull_request.base.sha }}
        run: |
          changed="$(git diff --name-only "$BASE_SHA" HEAD)"
          critical='^(\.github/workflows/(update-icloud-prices|validate-icloud-price-comparison)\.yml|tools/icloud_price_comparison/(data-contract\.js|data-model\.js|script\.js|scripts/(market-registry|reserved-market-registry|update-prices|render-static-page|static-page)\.mjs))$'
          if printf '%s\n' "$changed" | grep -Eq "$critical"; then
            for doc in tools/icloud_price_comparison/README.md tools/icloud_price_comparison/OPERATIONS.md; do
              if ! printf '%s\n' "$changed" | grep -Fxq "$doc"; then
                echo "Critical iCloud architecture changed without required documentation update: $doc" >&2
                exit 1
              fi
            done
          fi
      - name: 配置 Node.js
"""
text = replace_once(text, old_checkout, new_checkout, 'validation documentation gate')
write(path, text)

# 10) remove the standing rekey tool and all temporary runner files before policy tests.
migration = PROJECT / 'scripts/migrate-market-id.mjs'
if not migration.exists():
    raise SystemExit('expected migrate-market-id.mjs before simplification')
migration.unlink()
for temporary in [
    ROOT / '.github/workflows/agent-identity-simplify.yml',
    PROJECT / 'scripts/agent-identity-simplify.py'
]:
    if temporary.exists():
        temporary.unlink()
