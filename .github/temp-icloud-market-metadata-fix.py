from pathlib import Path

root = Path('tools/icloud_price_comparison')


def replace_once(path, old, new):
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count} for {old[:100]!r}')
    path.write_text(text.replace(old, new, 1))


update = root / 'scripts/update-prices.mjs'
replace_once(update, '''function summarizeChangedCountries(entries) {
  return summarizeNames(entries.map(({ nameZh, country }) => markdownInline(nameZh || country)));
}
''', '''export function buildPresentationMarketChanges(previousData, currentCountries, publicationChanges) {
  const rawChanges = publicationChanges ?? {
    addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: []
  };
  const addedCountries = rawChanges.addedCountries ?? [];
  const removedCountries = rawChanges.removedCountries ?? [];
  const previousByMarketId = new Map((previousData?.countries ?? [])
    .filter(({ marketId }) => typeof marketId === 'string' && marketId)
    .map((country) => [country.marketId, country]));
  const addedSourceNames = new Set(addedCountries.map(({ country }) => country));
  const removedSourceNames = new Set(removedCountries.map(({ country }) => country));
  const renamedCountries = [];

  for (const current of currentCountries ?? []) {
    if (typeof current?.marketId !== 'string' || !current.marketId) continue;
    const previous = previousByMarketId.get(current.marketId);
    if (!previous || previous.country === current.country) continue;
    if (!addedSourceNames.has(current.country) || !removedSourceNames.has(previous.country)) continue;
    renamedCountries.push({
      marketId: current.marketId,
      fromCountry: previous.country,
      toCountry: current.country,
      nameZh: current.nameZh || previous.nameZh || current.country
    });
  }
  renamedCountries.sort((first, second) => first.marketId.localeCompare(second.marketId));
  const renamedAddedNames = new Set(renamedCountries.map(({ toCountry }) => toCountry));
  const renamedRemovedNames = new Set(renamedCountries.map(({ fromCountry }) => fromCountry));
  return {
    ...rawChanges,
    addedCountries: addedCountries.filter(({ country }) => !renamedAddedNames.has(country)),
    removedCountries: removedCountries.filter(({ country }) => !renamedRemovedNames.has(country)),
    renamedCountries
  };
}

function summarizeChangedCountries(entries) {
  return summarizeNames(entries.map(({ nameZh, country }) => markdownInline(nameZh || country)));
}

function summarizeRenamedCountries(entries) {
  return summarizeNames(entries.map(({ fromCountry, toCountry }) => (
    `${markdownInline(fromCountry)} → ${markdownInline(toCountry)}`
  )));
}
''')
replace_once(update, '''  const publicationChanges = summary.publicationChanges ?? {
    addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: []
  };
  const changedCountries = publicationChanges.changedCountries ?? [];
''', '''  const publicationChanges = summary.publicationChanges ?? {
    addedTiers: [], removedTiers: [], addedCountries: [], removedCountries: [], changedCountries: []
  };
  const presentationChanges = summary.presentationChanges ?? publicationChanges;
  const changedCountries = presentationChanges.changedCountries ?? [];
  const chineseNamePendingMarkets = summary.chineseNamePendingMarkets ?? [];
''')
replace_once(update, '''  if (publicationChanges.addedTiers.length) {
    changes.push(`新增容量：${publicationChanges.addedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
''', '''  if (presentationChanges.addedTiers.length) {
    changes.push(`新增容量：${presentationChanges.addedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
''')
replace_once(update, '''  if (publicationChanges.removedTiers.length) {
    changes.push(`移除容量：${publicationChanges.removedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
''', '''  if (presentationChanges.removedTiers.length) {
    changes.push(`移除容量：${presentationChanges.removedTiers.map(({ label, id }) => markdownInline(label || id)).join('、')}`);
  }
''')
replace_once(update, '''  if (publicationChanges.addedCountries.length) {
    changes.push(`新增地区：${summarizeChangedCountries(publicationChanges.addedCountries)}`);
  }
''', '''  if (presentationChanges.addedCountries.length) {
    changes.push(`新增地区：${summarizeChangedCountries(presentationChanges.addedCountries)}`);
  }
''')
replace_once(update, '''  if (publicationChanges.removedCountries.length) {
    changes.push(`移除地区：${summarizeChangedCountries(publicationChanges.removedCountries)}`);
  }
''', '''  if (presentationChanges.removedCountries.length) {
    changes.push(`移除地区：${summarizeChangedCountries(presentationChanges.removedCountries)}`);
  }
  if (presentationChanges.renamedCountries?.length) {
    changes.push(`地区名称变化：${summarizeRenamedCountries(presentationChanges.renamedCountries)}`);
  }
''')
replace_once(update, '''  for (const market of summary.chineseNamePendingMarkets ?? []) {
    reviewDebt.push(`- **CHINESE_MARKET_NAME_PENDING**：marketId=${markdownInline(market.marketId)}；sourceName=${markdownInline(market.sourceName)}；暂用 Apple 英文名称显示`);
  }
''', '')
replace_once(update, '''  if (reviewDebt.length) {
    lines.push('', '### 市场元数据待复核（不改变永久 ID）',
      `UNKNOWN_APPLE_MARKET=${summary.unknownMarkets?.length ?? 0}；CHINESE_MARKET_NAME_PENDING=${summary.chineseNamePendingMarkets?.length ?? 0}；MARKET_IDENTITY_RENAME_SUSPECTED=${summary.marketIdentityRenameSuspicions?.length ?? 0}`,
      '', '<details><summary>展开完整待复核明细</summary>', '', ...reviewDebt, '', '</details>');
  }
  lines.push('');
''', '''  if (reviewDebt.length) {
    lines.push('', '### 市场身份待复核（不改变永久 ID）',
      `UNKNOWN_APPLE_MARKET=${summary.unknownMarkets?.length ?? 0}；MARKET_IDENTITY_RENAME_SUSPECTED=${summary.marketIdentityRenameSuspicions?.length ?? 0}`,
      '', '<details><summary>展开完整待复核明细</summary>', '', ...reviewDebt, '', '</details>');
  }
  if (chineseNamePendingMarkets.length) {
    lines.push('', '### 中文名称同步状态',
      `- 待同一 Apple iCloud+ 中文价格页同步/确认：${chineseNamePendingMarkets.length} 个；当前继续显示 Apple 英文名称，不作为异常或 review debt。`);
  }
  lines.push('');
''')
replace_once(update, '''  const reviewDebt = `UNKNOWN_APPLE_MARKET=${unknownMarkets.length}; CHINESE_MARKET_NAME_PENDING=${chineseNamePendingMarkets.length}; MARKET_IDENTITY_RENAME_SUSPECTED=${marketIdentityRenameSuspicions.length}`;
  if (unknownMarkets.length || chineseNamePendingMarkets.length || marketIdentityRenameSuspicions.length) {
    console.warn(`MARKET_REVIEW_DEBT: ${reviewDebt}; details in Action summary; published IDs remain frozen`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const level = marketIdentityRenameSuspicions.length ? 'warning' : 'notice';
      console.log(`::${level} title=Apple market review debt::${escapeGitHubCommandMessage(reviewDebt)}`);
    }
  }
''', '''  const reviewDebt = `UNKNOWN_APPLE_MARKET=${unknownMarkets.length}; MARKET_IDENTITY_RENAME_SUSPECTED=${marketIdentityRenameSuspicions.length}`;
  if (unknownMarkets.length || marketIdentityRenameSuspicions.length) {
    console.warn(`MARKET_REVIEW_DEBT: ${reviewDebt}; details in Action summary; published IDs remain frozen`);
    if (process.env.GITHUB_ACTIONS === 'true') {
      const level = marketIdentityRenameSuspicions.length ? 'warning' : 'notice';
      console.log(`::${level} title=Apple market review debt::${escapeGitHubCommandMessage(reviewDebt)}`);
    }
  }
''')
replace_once(update, '''  const publicationChanges = buildSnapshotChanges(previousData, countries, parsed.tiers);
  const historyUpdate = updateHistory(previousHistory, countries, observedAt, parsed.tiers, generatedAt);
''', '''  const publicationChanges = buildSnapshotChanges(previousData, countries, parsed.tiers);
  const presentationChanges = buildPresentationMarketChanges(previousData, countries, publicationChanges);
  const historyUpdate = updateHistory(previousHistory, countries, observedAt, parsed.tiers, generatedAt);
''')
replace_once(update, '''    publicationDateChanged: publishedDateUpdate.changed,
    publicationChanges,
    observedAt
''', '''    publicationDateChanged: publishedDateUpdate.changed,
    publicationChanges,
    presentationChanges,
    observedAt
''')

market_test = root / 'test/market-registry.test.mjs'
with market_test.open('a') as file:
    file.write('''\n\ntest('published fallback identities stay permanent without recurring unknown review debt', () => {\n  const unknown = [];\n  const pending = [];\n  const marketId = 'apple-published-fallback-12345678';\n  const attached = attachMarketIdentity([fixtureCountry('Published Fallback Market')], {\n    resolve: () => ({ id: marketId, sourceName: 'Published Fallback Market', unknown: true, published: true }),\n    chineseNames: {},\n    onUnknown: (market) => unknown.push(market.id),\n    onChineseNamePending: (market) => pending.push(market.id)\n  });\n  assert.equal(attached[0].marketId, marketId);\n  assert.deepEqual(unknown, []);\n  assert.deepEqual(pending, [marketId]);\n});\n''')

update_test = root / 'test/update-prices.test.mjs'
replace_once(update_test, '''  buildSnapshotChanges,\n  buildRunLog,\n  buildActionSummaryLines,\n''', '''  buildSnapshotChanges,\n  buildPresentationMarketChanges,\n  buildRunLog,\n  buildActionSummaryLines,\n''')
replace_once(update_test, '''    assert.match(summary, new RegExp(`UNKNOWN_APPLE_MARKET.*${publishedUnknown.marketId}.*${unknown.region}.*${unknown.currency}`, 's'));
    assert.match(summary, new RegExp(`CHINESE_MARKET_NAME_PENDING.*${publishedUnknown.marketId}.*New Apple Market`, 's'));
    assert.ok(summary.includes('<details><summary>展开完整待复核明细</summary>'));
''', '''    assert.match(summary, new RegExp(`UNKNOWN_APPLE_MARKET.*${publishedUnknown.marketId}.*${unknown.region}.*${unknown.currency}`, 's'));
    assert.doesNotMatch(summary, /CHINESE_MARKET_NAME_PENDING/);
    assert.match(summary, /### 中文名称同步状态/);
    assert.match(summary, /待同一 Apple iCloud\+ 中文价格页同步\/确认：1 个/);
    assert.ok(summary.includes('<details><summary>展开完整待复核明细</summary>'));
''')
replace_once(update_test, '''  assert.match(pendingChineseName, /CHINESE_MARKET_NAME_PENDING.*marketId=mu.*sourceName=Mauritius/);
''', '''  assert.doesNotMatch(pendingChineseName, /CHINESE_MARKET_NAME_PENDING/);
  assert.match(pendingChineseName, /### 中文名称同步状态/);
  assert.match(pendingChineseName, /待同一 Apple iCloud\+ 中文价格页同步\/确认：1 个/);
''')
marker = "test('publication snapshot changes keep Apple source-name renames visible even when marketId stays stable', () => {"
text = update_test.read_text()
if text.count(marker) != 1:
    raise SystemExit(f'{update_test}: expected source-name rename marker once')
presentation_test = '''test('presentation changes fold stable market source-name renames without mutating raw publication evidence', () => {\n  const previousData = { countries: [\n    { marketId: 'ci', country: 'Ivory Coast', nameZh: '科特迪瓦' },\n    { marketId: 'us', country: 'United States', nameZh: '美国' }\n  ] };\n  const currentCountries = [\n    { marketId: 'ci', country: "Cote D'Ivoire", nameZh: '科特迪瓦' },\n    { marketId: 'us', country: 'United States', nameZh: '美国' },\n    { marketId: 'apple-new-market-12345678', country: 'New Market', nameZh: 'New Market' }\n  ];\n  const raw = {\n    addedTiers: [], removedTiers: [],\n    addedCountries: [\n      { country: "Cote D'Ivoire", nameZh: '科特迪瓦' },\n      { country: 'New Market', nameZh: 'New Market' }\n    ],\n    removedCountries: [{ country: 'Ivory Coast', nameZh: '科特迪瓦' }],\n    changedCountries: []\n  };\n  const presented = buildPresentationMarketChanges(previousData, currentCountries, raw);\n  assert.deepEqual(raw.addedCountries.map(({ country }) => country), ["Cote D'Ivoire", 'New Market']);\n  assert.deepEqual(raw.removedCountries.map(({ country }) => country), ['Ivory Coast']);\n  assert.deepEqual(presented.addedCountries.map(({ country }) => country), ['New Market']);\n  assert.deepEqual(presented.removedCountries, []);\n  assert.deepEqual(presented.renamedCountries, [{\n    marketId: 'ci', fromCountry: 'Ivory Coast', toCountry: "Cote D'Ivoire", nameZh: '科特迪瓦'\n  }]);\n});\n\n'''
update_test.write_text(text.replace(marker, presentation_test + marker, 1))

readme = root / 'README.md'
replace_once(readme, '''首次出现且不在 active registry 的 Apple 市场直接生成可复现的 `apple-<slug>-<hash>`，记录 `UNKNOWN_APPLE_MARKET`，经正常 Apple 语义确认且无冲突后允许自动发布。一旦发布，这个 `apple-*` 永久不 rekey；以后正式识别时 active registry 也必须继续沿用该 ID，只能补 source alias 和中文名称 authority。

中文名称继续以 `scripts/country-names.zh.json` 为唯一 Apple 简体中文事实源；pending 时显示 Apple 英文 `sourceName` 并记录 `CHINESE_MARKET_NAME_PENDING`。浏览器端不维护独立的搜索别名表，只搜索当前公共 `marketId`、中英文名称、Apple 英文 region / 中文地区标签和完整币种代码；完整 `marketId` 优先。
''', '''首次出现且不在 active registry 的 Apple 市场直接生成可复现的 `apple-<slug>-<hash>`，仅在首次发布候选中记录 `UNKNOWN_APPLE_MARKET`，经正常 Apple 语义确认且无冲突后允许自动发布。一旦发布，identity ledger 就把这个 `apple-*` 视为永久身份，不再重复计入 unknown review debt；以后正式识别时 active registry 也必须继续沿用该 ID，只能补 reviewed source alias，不得 rekey。

中文名称继续以 `scripts/country-names.zh.json` 为唯一 Apple 简体中文事实源，该文件只固化同一 iCloud+ 简体中文价格页已经确认的名称。中文价格页尚未覆盖时继续显示 Apple 英文 `sourceName`，只在 Action summary 汇总为同步状态，不作为异常或 identity review debt，也不从其他中文页面补名。浏览器端不维护独立的搜索别名表，只搜索当前公共 `marketId`、中英文名称、Apple 英文 region / 中文地区标签和完整币种代码；完整 `marketId` 优先。

`sourcePublishedDates`、run-log 与 snapshot 继续保留 Apple 原始 source-name 的 added/removed 证据；Action 的人类可读摘要可以在 removed/added 已由同一稳定 `marketId` 明确证明时，仅在展示层折叠为“地区名称变化”。该折叠不得写回证据账本或参与 identity 推断。
''')

operations = root / 'OPERATIONS.md'
replace_once(operations, '''- active registry 未命中的新市场直接使用 deterministic `apple-*` fallback，记录 `UNKNOWN_APPLE_MARKET`，经正常语义确认且无冲突后可自动发布。
- 已发布 `apple-*` 永久保持原 ID。后续正式识别或 Apple 英文 wording 改变时，只能在 active registry 中沿用该 ID并补 source alias；不得改成友好两位码。
- `scripts/country-names.zh.json` 仍是 Apple 简体中文名称唯一事实源；pending 继续显示 Apple 英文 `sourceName`。
''', '''- active registry 未命中的新市场直接使用 deterministic `apple-*` fallback；`UNKNOWN_APPLE_MARKET` 只表示首次发布候选中的新身份。首次成功发布后，identity ledger 即成为其永久身份依据，后续运行不得继续把同一 source identity 计为 unknown。
- 已发布 `apple-*` 永久保持原 ID。后续正式识别或 Apple 英文 wording 改变时，只能在 active registry 中沿用该 ID并补 reviewed source alias；不得改成友好两位码。
- `scripts/country-names.zh.json` 仍是 Apple iCloud+ 简体中文价格页名称的唯一事实源；pending 继续显示 Apple 英文 `sourceName`，只作为中文页同步状态，不从其他 Apple 中文页面补齐，也不作为 identity review debt。
''')
replace_once(operations, '''`UNKNOWN_APPLE_MARKET`、`CHINESE_MARKET_NAME_PENDING` 汇总为 review debt，完整明细保留在 summary 折叠区；未解决的 rename suspicion 单独计数、冲突仍报错。FX provider 的任意错误正文、HTTP statusText、JSON 片段与 transport exception 不得进入公开日志；只输出受控分类。12% dailyized sanity 仍是保守运维异常拦截值，不是对真实汇率波动的统计保证，阈值不因本轮测试而放宽。
''', '''只有首次发布候选中的 `UNKNOWN_APPLE_MARKET` 与未解决的 rename suspicion 属于 identity review debt；已发布 fallback identity 不重复告警，`CHINESE_MARKET_NAME_PENDING` 仅汇总为中文页同步状态。Action 摘要可把“同一稳定 `marketId` 的旧 source name removed + 新 source name added”展示为名称变化，但 `sourcePublishedDates`、run-log 与 snapshot 中的原始 added/removed 证据必须保持不变。FX provider 的任意错误正文、HTTP statusText、JSON 片段与 transport exception 不得进入公开日志；只输出受控分类。12% dailyized sanity 仍是保守运维异常拦截值，不是对真实汇率波动的统计保证，阈值不因本轮测试而放宽。
''')

architecture = root / 'ARCHITECTURE.md'
replace_once(architecture, '''- `marketId` 只定义长期价格/历史身份，不覆盖 Apple source evidence：`sourcePublishedDates[].changes` 必须按规范化 Apple 快照中的原始 `country` 名称比较，因此 source wording 从旧名变为新名时仍记录“旧名移除 + 新名新增”；这与价格事件继续归入同一 `marketId` 并不冲突。完整 artifact 深验核对价格事件时也必须先把快照 source name 解析回稳定 `marketId`，不能用当前 `record.country` 反向拆分历史。价格事件日期同时受证据锚点约束：历史回填可使用该 revision 的 `publishedDate`，在线首次确认可使用 `firstConfirmedDate`；其他日期不得仅凭价格相同而通过。

这使 `history.json`、深链接、历史快照和未来名称修订都能围绕同一个身份累计。
''', '''- `marketId` 只定义长期价格/历史身份，不覆盖 Apple source evidence：`sourcePublishedDates[].changes` 必须按规范化 Apple 快照中的原始 `country` 名称比较，因此 source wording 从旧名变为新名时仍记录“旧名移除 + 新名新增”；这与价格事件继续归入同一 `marketId` 并不冲突。完整 artifact 深验核对价格事件时也必须先把快照 source name 解析回稳定 `marketId`，不能用当前 `record.country` 反向拆分历史。价格事件日期同时受证据锚点约束：历史回填可使用该 revision 的 `publishedDate`，在线首次确认可使用 `firstConfirmedDate`；其他日期不得仅凭价格相同而通过。

已发布 identity ledger 同时承担 review-state 边界：deterministic `apple-*` 在首次候选里仍是 unknown，但成功发布后即是永久已知身份，不应在后续运行重复制造 unknown 告警。中文名称状态独立于 identity；只有同一 iCloud+ 简体中文价格页已经确认的名称才能进入中文事实源，尚未同步时显示英文即可。Action 摘要中的 rename folding 只是由“同一稳定 `marketId` + raw added/removed 对”派生的展示投影，不能反向修改原始 publication evidence。

这使 `history.json`、深链接、历史快照和未来名称修订都能围绕同一个身份累计。
''')
