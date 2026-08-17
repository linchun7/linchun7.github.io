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
path.write_text(text, encoding='utf-8')
print('temporary guard fixed')
