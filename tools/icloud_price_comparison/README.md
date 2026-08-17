# iCloud+ 全球价格比较

正式页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

原 GitHub Pages 地址仅作为旧入口：<https://linchun7.github.io/tools/icloud_price_comparison/>

本工具比较 Apple iCloud+ 在不同国家和地区的月费。Apple Support 英文价格页提供当地价格、币种、容量、市场结构和 `Published Date`；人民币参考价优先使用 ExchangeRate-API 认证源生成，认证源不可用或未通过校验时可尝试开放汇率源，并只在受控 freshness 条件内沿用上一份已验证的安全派生结果。人民币金额只用于横向比较，不是 Apple 结算价。

日常值守、自动更新、监控、Secret、Cloudflare、部署、回滚和事故处理见 [OPERATIONS.md](OPERATIONS.md)。Apple 规范化历史证据见 [data/apple-snapshots/README.md](data/apple-snapshots/README.md)。

## 产品边界

当前长期约束如下，修改这些行为应视为产品契约变化，而不是普通 UI 调整：

- 公共数据使用 schema 4，市场使用稳定 `marketId`。
- Apple 英文支持页决定 active market、价格、币种、容量和发布日期；Apple 简体中文支持页只用于已经复核的官方中文市场名称。
- 欧元区中文名称保持“欧盟”。中文名称尚未确认时保留 Apple 英文名称，不阻断价格更新。
- 市场身份按“已发布 identity ledger → active registry → future reservation → deterministic `apple-*` fallback”的安全顺序处理。`scripts/reserved-market-registry.mjs` 只提前预留高置信国家/地区 ID，不代表 Apple 当前提供这些市场；真正未识别的 Apple 市场才生成可复现的 `apple-*` ID，确认无冲突后可自动发布。
- 页面默认按 200GB 人民币参考价从低到高排序；若未来 Apple 不再提供 200GB，则使用当前 `tiers` 中的首个容量作为默认容量。
- 容量排序时显示生成器提供的全球 `cnyRank`，搜索或地区筛选不会把排名重算成局部排名；切换为国家/地区排序时数字改为当前列表序号，移动端明确显示为 `序1`、`序2`、`序3`……，不引入第二套价格排名。
- 搜索对 `marketId`、人工维护的 search alias、中英文国家/地区名称和地区名称使用部分字符串匹配；完整 `marketId` 命中优先级最高，完整 search alias 次之，但都不排除其他合法部分匹配；币种仅按完整代码匹配，避免短字母把同币种市场全部带出。
- 容量、排序方向、地区筛选等可分享状态写入规范 URL；站内搜索词不保留在 URL。允许的页面内跳转 fragment 仅有 `#priceWorkspace`，其他未知 fragment 会被清理。
- 最低价卡片是导航操作：切换对应容量、从低到高排序并定位目标地区。
- 当前价格不写入 `localStorage`、`sessionStorage`、IndexedDB 或 Service Worker；没有浏览器持久价格缓存。
- JavaScript 关闭、网络较慢或网络价格读取失败时，最近一次已发布的静态价格仍可直接使用。

## 页面能力

- 展示 Apple 页面解析出的地区、分区、币种、容量和当地月费，以及人民币参考价。
- 按容量汇总参考最低价和所有并列地区。
- 支持中英文国家/地区、`marketId`、友好 search alias、地区名称和完整币种代码搜索，以及分区筛选、容量排序、地区排序和 URL 状态恢复；精确 `marketId` 命中优先级最高，精确 alias 次之，但部分匹配仍保留。
- 容量价格排序使用全球参考排名；国家/地区排序使用列表序号，移动端用 `序N` 区分序号与排名。
- 点击地区可查看当地月费、人民币换算价、价格变更次数和完整的 Apple 当地标价历史。
- 展示 Apple `Published Date`，并记录发布日期变化时对应的容量、地区、分区、币种和价格差异。
- 记录地区、容量的新增和移除；已存在的市场身份和历史不会因为暂时下线而重新分配。
- 提供 stale/fallback 状态、错误重试、键盘操作、减弱动画、forced-colors 和窄屏适配。

## 数据流与自动更新

自动更新工作流：`.github/workflows/update-icloud-prices.yml`

```text
Apple Support HTML ─┐
                    ├─ 只读生成/测试 job
汇率认证/开放源 ────┘        │
                             ├─ schema / history / snapshot / static HTML 验证
                             └─ 依赖隔离的 contents:write 发布 job
                                          │
                                          └─ main → GitHub Pages → Cloudflare → 浏览器
```

自动入口：

- Cloudflare 主触发：每天北京时间 08:05，通过 `workflow_dispatch` 且 `trigger_source=cloudflare`。
- GitHub cron 备用：每天北京时间 08:10。
- `main` 上的手动触发始终允许执行。

两个自动入口共用每日幂等保护。只有当天已经存在合格成功运行、汇率不是 stale、抓取日期也符合当天条件时，备用任务才跳过。

一次生产更新的核心顺序：

1. 固定远端 `main` 为生成基线，使用 frozen lockfile 安装依赖并运行 core 测试。
2. 在共享网络预算内抓取 Apple 页面。同一份 HTML 由 `document-order` 和 `apple-markers` 两条结构关联路径分别解析，逐字段一致后才得到 `cross-checked` 结果。
3. Apple 业务语义发生变化时，执行独立 no-store 确认抓取；只有稳定、完整、交叉核对一致的结果才能继续。暂时网络不确定性保留上一份生产数据并等待后续自动重试。
4. 获取并校验汇率；认证来源不可用时自动尝试开放来源。所有 fresh 在线候选均不可用时，只允许在既定 freshness 窗口内沿用上一份安全派生人民币结果。
5. 事务式生成 `prices.json`、`history.json`、`run-log.json` 和规范化 Apple 快照。
6. 从已验证的 `prices.json` 确定性生成 `index.html` 的静态价格区域、状态文案和 SEO Projection。容量列表仍由当前 payload 动态驱动；description 同时保留经人工选择的稳定热门国家意图，当前最低价国家则继续由动态正文表达。
7. 深验完整 `data/` 与静态投影，上传只读发布工件；独立发布 job 再次验证远端基线后才提交到 `main`。

生成 job 只有 `contents: read`；只有不安装项目依赖的发布 job 使用 `contents: write`。生成后如果远端 `main` 已前进，本次发布失败关闭，不 rebase 旧工件，也不 force push。

## 数据文件与公共契约

| 文件 | 用途 | 关键约束 |
| --- | --- | --- |
| `data/prices.json` | schema 4 当前价格与公共运行元数据 | 当前价格唯一事实源；含稳定 `marketId`、`cnyPrice`、`cnyRank`；不公开 raw FX rates、内部全精度值或 API Key 状态 |
| `data/history.json` | 以 `marketId` 为键的价格/币种事件和 Apple 发布日期事件 | 只有实际事件、迁移或结构变化时才改写；历史市场 ID 永久保留 |
| `data/run-log.json` | 最近成功运行的来源、数量、耗时和变化 | 保留最近 90 条成功运行，不公开凭据配置/状态 |
| `data/apple-snapshots/` | Apple 价格页面的规范化 JSON 证据与索引 | 不保存原始 HTML；同一发布日期的不同修订不会互相覆盖 |

当前数据数量应直接以 `data/prices.json` 为准，不把地区数、币种数、容量数写成永久常量。Apple 合法新增或移除市场、币种、容量时，这些数量可以自然变化。

前端只接受当前 schema 4，并要求稳定市场 ID、合法 tier、精确字段集合、受控来源 URL、合法时间关系、完整价格和生成器提供的 `cnyRank`。当前价格只有两层来源：

1. `prices.json` 预渲染到 `index.html` 的静态投影；
2. 浏览器再次获取并通过同一契约校验的网络 `prices.json`。

网络数据超过 7 天或相对当前时间超前超过 5 分钟时不会覆盖已显示的静态价格。36 小时以内为正常可用窗口；36 小时至 7 天只作为旧数据参考。最低价提示只由 `cnyRank === 1` 决定，价格过期或 `fx.stale` 时隐藏最低价排名提示。

## 市场身份、预留 ID 与中文名称

`marketId` 的首要职责是**永久数据身份**，不是为了让代码看起来漂亮而随意更换。当前身份体系分为四层：

1. `prices.json` / `history.json` 已经发布过的 identity ledger 优先。某个 Apple source name 一旦以一个 `marketId` 发布，后续普通自动更新继续沿用该 ID。
2. `scripts/market-registry.mjs` 保存当前已知 Apple 市场的稳定 `marketId`、Apple 英文 canonical name 和 aliases。
3. `scripts/reserved-market-registry.mjs` 预留未来可能出现的高置信国家/地区 ID，主要使用未被 active registry 占用的 ISO 3166-1 alpha-2 代码，并额外预留 `xk`。预留项**不是 Apple 可用性清单**，不会因为存在于该文件就进入 `prices.json` 或页面；只有 Apple 英文页真的出现并与明确 canonical name/alias 匹配时才启用该 ID。
4. 如果 Apple 首次出现的名称既不在 active registry，也不在 future reservations，才生成确定性的 `apple-<slug>-<hash>` ID，并记录 `UNKNOWN_APPLE_MARKET`。完成正常 Apple 语义确认且无 ID 冲突后允许自动发布。

中文名称继续独立遵守 Apple 来源规则：`scripts/country-names.zh.json` 是 Apple 简体中文市场名称唯一事实源。已审核 wording 保存字符串；尚待 Apple zh-CN wording 确认则保存 `null` 或视为 pending，前端继续显示 Apple 英文 `sourceName` 并记录 `CHINESE_MARKET_NAME_PENDING`。提前预留一个 market ID 不等于提前创造中文名称。

### 搜索 alias 与已发布 fallback

浏览器端友好搜索别名维护在 `data-model.js` 的 `MARKET_SEARCH_ALIASES`。例如 `uk → gb`、`usa → us`、`turkey → tr`。search alias 只改善用户搜索，不改变永久 `marketId`，也不写入公共价格 schema。

如果一个真正未知市场已经以 `apple-*` fallback 发布，后来才确认它对应某个友好代码，**默认不 rekey**：已发布 identity 继续保持 sticky，可以给原 `marketId` 增加合适的 `MARKET_SEARCH_ALIASES`，让用户用友好代码找到它而不破坏历史。

- 已从 Apple 页面移除的历史市场 ID 仍永久 reserved，不得分配给其他市场。
- 新生成或预留的 ID 如果与 active registry 或历史 ledger 冲突，以 `MARKET_IDENTITY_RESERVED_ID_COLLISION` 失败关闭，不随机换 ID。
- 不做模糊名称匹配，不自动把“疑似改名”绑定到旧市场。只有满足严格双向唯一和完整结构一致的高置信 ambiguity 才停止并要求显式 alias；弱信号只记录 review warning。

### 极少数显式 marketId migration

只有确实需要把一个**已经发布的 `apple-*` fallback**迁移到经过人工复核的 active/reserved ID 时，才使用显式迁移工具。普通 registry 编辑不能静默改历史 ID。

先 dry-run：

```bash
node scripts/migrate-market-id.mjs --from <apple-...> --to <reviewed-id>
```

确认目标 ID 已先进入 active/reserved registry、没有任何 active/history 冲突并审核完整 diff 后，才允许写入：

```bash
node scripts/migrate-market-id.mjs --from <apple-...> --to <reviewed-id> --write
```

工具只接受 `apple-*` 作为源 ID，会同步迁移 `prices.json` 与 `history.json` 的 identity、重新生成 `index.html`，并在失败时恢复原文件。迁移后必须运行 core、artifact、snapshots 和三浏览器验收，再通过普通 PR 发布；不要手工改单个 JSON key。

相关长期边界由 `test/market-registry.test.mjs`、`test/market-identity-reservations.test.mjs` 和 `test/documentation-contract.test.mjs` 共同保护。

## 页面生成与 SEO

`data/prices.json` 是价格事实源，`index.html` 是它的确定性静态投影。当前生成边界有两层，维护时必须区分“生成源”和“生成后的 HTML 产物”：

1. `scripts/static-page.mjs` 生成 `ICLOUD_STATIC_*` markers 内的价格表、最低价、更新时间、覆盖统计等区域；不要手工修改这些 marker 内的内容。
2. `scripts/render-static-page.mjs` 的 `seoProjection()` 生成一组位于 markers 外部的 SEO/首屏目标，包括 `meta description`、Open Graph/Twitter description、OG/Twitter 图片 alt 和 `#brandDescription`。这些位置虽然不在 `ICLOUD_STATIC_*` 内，也同样不能把 `index.html` 当作事实源手工修改；需要改 SEO 时应先改 `seoProjection()`，再重新生成 `index.html`。

```bash
pnpm render:static
pnpm render:static:check
```

`render:static:check` 会同时验证静态 fragments 与 SEO Projection；直接手改生成产物但未同步生成源会以 `STATIC_RENDER_MISMATCH` 或 `SEO_PROJECTION_MISMATCH` 失败关闭。

SEO 当前采用“稳定意图 + 动态数据”的组合：

- description、Open Graph/Twitter description 自然包含美国、日本、中国大陆、俄罗斯、土耳其、尼日利亚、台湾等常见及低价市场词；这组词是稳定搜索意图，不是“当前最低价榜单”，不会因日常汇率波动自动替换。
- description 中的容量列表、OG/Twitter 图片 alt 和首屏产品说明仍由当前 `payload.tiers` 动态生成；未来 Apple 合法新增或移除容量时会同步更新。
- 当前各容量最低价市场、价格、排名、覆盖数量和更新时间继续由静态正文随 `prices.json` 动态生成，搜索引擎可以直接抓取这些真实页面内容。
- 页面 `<title>`、canonical URL 等未列入 `seoProjection()` 的 shell metadata 不是价格更新的动态目标；如需修改应作为明确 SEO 变更并保留相应测试。

### 社交分享图

`og-image.png` 是 Open Graph / Twitter 分享卡片，不是页面正文图片，因此普通刷新页面不会在页面里“看到这张图”。当前契约要求它必须是真实的 1200×630 PNG，`og:image` 和 `twitter:image` 指向同一资源，格式和尺寸由 core 测试校验。

社交平台、聊天应用和搜索引擎可能按 URL 缓存分享图。若未来**视觉内容**发生变化并要求第三方立即重新抓取，优先使用新的稳定资源 URL（例如新的文件名）并同步更新 OG/Twitter metadata；不要只依赖浏览器强制刷新来判断社交预览是否已经更新。

## 验证

从 `tools/icloud_price_comparison/` 执行，要求 Node.js 22+ 和项目声明的 pnpm 10.14.0：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install chromium firefox webkit
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
pnpm test:browsers
pnpm check:live
pnpm audit --audit-level low
```

- `pnpm test:core`：静态资源版本、静态 fragments/SEO Projection、vendor、解析、数据契约、市场 identity、事务、artifact 安全、幂等和 workflow 契约。
- `pnpm validate:artifact`：验证当前完整 `data/` 及跨文件语义。
- `pnpm validate:snapshots`：深度解析所有规范化 Apple 快照修订。
- `pnpm test:browsers`：本地依次运行 Chromium、Firefox、WebKit 的同一套 UI 验收；GitHub Actions 使用三组 matrix runners。
- `pnpm check:live`：只读抓取 Apple 与汇率来源并执行完整 dry-run，结束后工作树必须不变。
- `pnpm update:data`：写生产数据，只用于明确的手动更新或隔离环境。

完整 `pnpm test` 等价于 core 后执行三浏览器验收。

本地预览从仓库根目录启动：

```bash
python -m http.server 4173
```

访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## 历史导入

`data/apple-snapshots/` 只保存规范化 JSON 与索引。完整规则见 [data/apple-snapshots/README.md](data/apple-snapshots/README.md)。

```bash
node scripts/import-apple-archives.mjs --input <包含完整历史快照的目录>
```

导入输入必须覆盖索引要求的既有发布日期；空目录、不完整目录、未知市场、解析失败或跨文件校验失败都会在提交前拒绝。导入器只读取外部 HTML，不把原始 HTML 写入仓库。Wayback 仅用于历史 Apple 页面排序和证据追溯，不是独立价格源。

## 数据来源与使用说明

- Apple 价格、币种、市场结构、容量和发布日期：<https://support.apple.com/en-us/108047>
- Apple 简体中文市场名称：<https://support.apple.com/zh-cn/108047>
- 汇率认证源：`https://v6.exchangerate-api.com/v6/latest/USD`（API Key 通过 `Authorization: Bearer` 传递，不放在 URL 中）
- 汇率开放回退源：<https://open.er-api.com/v6/latest/USD>

人民币结果仅供信息与横向比较；税费、可用性、付款方式、购买区域限制和最终结算以 Apple 对应地区页面与实际结算结果为准。本工具与 Apple Inc. 无关联，数据仅供参考。

## 隐私与 Web 安全

- 页面启用 Google Analytics 4（`G-K2S9L4CHNP`）和 Cloudflare Web Analytics；站内搜索词不会发送给统计服务。
- 初始脚本在价格网络请求和分析脚本执行前清理 `q`、未知/重复/非法查询参数和未知 fragment；URL 最终只保留规范的 `tier`、`sort`、`dir`、`region`，并可保留唯一允许的页面内 fragment `#priceWorkspace`。
- 应用自身不写 Cookie、`localStorage`、`sessionStorage` 或 IndexedDB。GA4 可能按 Google 实现写入 `_ga` 系列 Cookie。
- 动态数据使用 DOM API 和 `textContent` 渲染，不使用 `innerHTML`、`eval`、`document.write` 或字符串事件处理器。
- Cloudflare HTTP CSP 与 HTML meta CSP 应保持同一最小权限边界；完整响应头、TLS、DNS、缓存和发布验收要求见 [OPERATIONS.md](OPERATIONS.md)。

自有代码许可见 [LICENSE](LICENSE)。前端第三方资源许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `vendor/manifest.json`。