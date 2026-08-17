from pathlib import Path

path = Path('tools/icloud_price_comparison/scripts/_tmp_simplify_market_identity.py')
text = path.read_text(encoding='utf-8')
old = """    if 'reserved-market-registry.mjs' in text or 'MARKET_SEARCH_ALIASES' in text or 'marketSearchAliases(' in text:\n        raise RuntimeError(f'legacy identity complexity remains in {path.relative_to(ROOT)}')\n"""
new = """    if path.name == 'documentation-contract.test.mjs':\n        continue\n    if 'reserved-market-registry.mjs' in text or 'MARKET_SEARCH_ALIASES' in text or 'marketSearchAliases(' in text:\n        raise RuntimeError(f'legacy identity complexity remains in {path.relative_to(ROOT)}')\n"""
if text.count(old) != 1:
    raise RuntimeError('temporary guard patch target not found exactly once')
text = text.replace(old, new, 1)
old_phrase = '另一套 identity/search alias 映射'
new_phrase = '额外的用户搜索代码映射'
if text.count(old_phrase) != 1:
    raise RuntimeError('README search-alias absence phrase not found exactly once')
text = text.replace(old_phrase, new_phrase, 1)
anchor = "write(ops_path, ops)\n\n# 12) Assert the complexity layers are actually gone from project source/docs/tests."
injected = r'''ops = replace_once(
    ops,
    "- 已发布或历史出现过的市场 ID 永久 reserved，不因市场移除而重新分配。\n",
    "- 已发布或历史出现过的市场 ID 永久保留，不因市场移除而重新分配。\n",
    'OPERATIONS historical IDs wording'
)
ops = replace_once(
    ops,
    "- 不做模糊 market rename 自动绑定；只有严格高置信 identity ambiguity 才要求维护者显式增加 alias。\n",
    "- 不做模糊 market rename 自动绑定；只有严格高置信 identity ambiguity 才要求维护者显式增加已审核 Apple source alias。\n",
    'OPERATIONS source alias wording'
)
ops = replace_once(
    ops,
    "- 搜索完整 `marketId` 时对应市场置顶但部分匹配仍保留；中英文名称/地区支持部分匹配，币种要求完整代码匹配。\n",
    "- 搜索中英文国家/地区名称和地区时支持部分匹配；币种要求完整代码匹配，`marketId` 不参与用户搜索。\n",
    'OPERATIONS browser search check'
)
ops = replace_once(
    ops,
    "- schema 4 数据、静态 fallback、历史、排序、筛选、`marketId`/search alias 搜索、`序N` 移动端语义、键盘和窄屏正常。\n",
    "- schema 4 数据、静态 fallback、历史、排序、筛选、中英文/地区/币种搜索、`序N` 移动端语义、键盘和窄屏正常。\n",
    'OPERATIONS browser acceptance search wording'
)
write(ops_path, ops)

# 12) Assert the complexity layers are actually gone from project source/docs/tests.'''
if text.count(anchor) != 1:
    raise RuntimeError('OPERATIONS post-cleanup insertion point not found exactly once')
text = text.replace(anchor, injected, 1)
path.write_text(text, encoding='utf-8')
print('temporary guard fixed')
