# iCloud+ 全球价格比较

正式页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>。原 GitHub Pages 地址仅作旧入口：<https://linchun7.github.io/tools/icloud_price_comparison/>。

比较 Apple 各国家和地区的 iCloud+ 当地月费与人民币参考价。价格、币种、容量、市场结构和原始 `Published Date` 以 Apple Support 英文 108047 为准；人民币换算仅供横向比较，不是 Apple 结算价。地区、币种和容量数量直接读取 `data/prices.json`，不写死为永久常量。

## 文档入口

- [ARCHITECTURE.md](ARCHITECTURE.md)：事实源、数据契约、事务、发布边界和修改影响。
- [OPERATIONS.md](OPERATIONS.md)：自动更新、监控、权限、部署、Cloudflare 和回滚。
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md)：按症状排障及禁止操作。
- [data/apple-snapshots/README.md](data/apple-snapshots/README.md)：规范化 Apple 证据与历史导入规则。

## 产品契约

页面默认按 200GB 人民币参考价升序排列；200GB 不再存在时改用当前首个容量。容量排序使用生成器给出的全球 `cnyRank`，筛选不重排名；按国家/地区排序时显示当前列表序号，移动端以 `序N` 和独立读屏文本区分。最低价卡片是切换容量并定位市场的导航按钮，不是开关。

搜索先做 Unicode NFKC 规范化，匹配 `marketId`、中英文名称、地区标签和完整币种代码；完整 `marketId` 优先，其他部分匹配仍保留。Apple 英文 region 与中文地区标签只在搜索词至少两个 Unicode 字符时参与，避免单字误命中。浏览器不维护另一份搜索名称目录。

容量、排序方向和地区筛选保存在规范 URL；站内搜索词不保留在 URL。仅允许 `#priceWorkspace` 页面内 fragment。应用不持久存储价格到 Cookie、localStorage、sessionStorage、IndexedDB 或 Service Worker。

静态 HTML 提供首屏和无 JavaScript/网络失败时的 fallback；网络 JSON 必须通过共享契约校验才能接管。36 小时内正常可用，36 小时至 7 天只作旧数据参考；超过 7 天或超前超过 5 分钟的网络价格不能覆盖当前页面，重试也不能回退到更早快照。旧数据、过期状态或 stale 汇率不能继续冒充有效最低价；时间恢复后依靠有效快照恢复控件和提示。关闭 JavaScript 时可查带生成时间的静态表，但无法自动重新判断过期。

页面支持当地标价历史、币种变化、最低价并列、键盘操作、读屏、减弱动画、forced-colors 和窄屏。前端日期及发布日期历史隐藏“仅日期变化”的记录；底层 Apple 原始日期证据完整保留。

## 市场身份与中文名称

公共数据使用 schema 4。身份优先级为：已发布 `prices.json` / `history.json` identity ledger → `scripts/market-registry.mjs` active registry → deterministic `apple-*` fallback。已发布 `marketId` 永久冻结，不 rekey；source alias 只处理 Apple 来源措辞变化，不更换历史身份。真正的新市场可获得可复现的 fallback ID，确认无冲突后自动发布；历史身份错误必须作为单独数据事故处理。

Apple 简体中文价格页只提供已人工复核的中文名称，欧元区显示“欧盟”。`scripts/country-names.zh.json` 保存稳定 ID 对应的正式中文显示名；未绑定时显示 Apple 英文名称，不阻断价格更新，也不从其他中文网页猜名。

两种中文状态必须区分：

- 英文价格页的待确认显示名：`nameZh === country` 的 active `marketId` 集合。日更的 `report-chinese-name-sync.mjs` 只读比较前后集合，摘要列出当前数量、新增与退出；数量相同也检查成员变化。退出不必然代表已补中文名，也可能是市场退出。
- 中文价格页的新名称监测：`scripts/apple-zh-reviewed-markets.json` 是只增不减的历史复核集合。已知名称暂时消失或再次出现不告警；从未复核的新名称需要人工检查。独立监测对解析/网络不可用报错，但不猜测中文名称到英文市场的绑定，不改写价格数据。

## 数据与发布

| 文件 | 职责 |
| --- | --- |
| `data/prices.json` | 当前价格唯一事实源，含稳定 ID、人民币参考价和全球排名，不公开原始汇率及凭据信息 |
| `data/history.json` | 按永久 `marketId` 累积价格/币种事件及 Apple 日期证据，仅事件或结构变化时改写 |
| `data/run-log.json` | 最近 90 条成功运行的来源、数量、耗时和变化 |
| `data/apple-snapshots/` | 规范化 JSON 与索引，不保存原始 HTML，不覆盖同日的不同修订 |

`.github/workflows/update-icloud-prices.yml` 的发布顺序：

1. 深验当前 main 数据并检查每日幂等状态；需要更新时固定生成基线，以 frozen lockfile 安装依赖。
2. 抓取 Apple HTML，经 `document-order` 与 `apple-markers` 双路径逐字段核对；业务语义变化还须独立 no-store 抓取确认。列表/表格结构切换、新市场与新容量不能成为放宽校验的理由。
3. 校验汇率并事务式生成候选。认证源不可用时尝试开放源；所有 fresh 在线候选不可用时，只在既定 freshness 窗口内沿用安全派生结果。快照、当前价格与历史不一致时回滚，不覆盖旧证据。
4. 候选依次经过 data 检查、静态页生成、完整 `test:core`、UI 验收和工件深验。完整 core 只运行一次，且针对更新后的真实候选，不以更新前的绿灯替代。
5. 独立发布 job 重新验证工件和远端基线后才推送；main 已前进则停止，不 rebase 旧工件、不 force push。Pages 构建及 canonical 生产 URL 验证完成才算成功；幂等跳过也需生产证明。

生成/测试 job 只有 `contents: read`；仅不安装项目依赖的发布 job 获得 `contents: write`。工件重验、Pages 证明、真实 URL 验证和外部心跳是不同边界，不作为重复检查删除。

生产设计为 Cloudflare 每日北京时间 08:05 外部 dispatch（`trigger_source=cloudflare`），GitHub cron 每日 08:10 兜底；main 上手动运行不受每日幂等跳过。自动入口共用已验证的成功记录、抓取日期及汇率 freshness 条件。仓库不能单独证明 Cloudflare 控制面当天真的触发，实时状态见外部控制面。

历史回填只使用 Apple 页面证据，Wayback 不构成另一价格源。输入须覆盖既有索引，缺失、冲突、未知市场或跨文件校验失败均拒绝提交。已发布 ID 与在线首次确认时间不能被回填重写；规则及命令见快照文档。

## 页面生成、SEO 与隐私

`index.html` 是派生物：`scripts/static-page.mjs` 生成 `ICLOUD_STATIC_*` 区域；`scripts/render-static-page.mjs` 的 `seoProjection()` 生成 markers 外的 SEO Projection，包括 description、分享图 alt 与首屏说明。修改应先改生成源，再运行：

```bash
pnpm render:static
pnpm render:static:check
```

静态正文随当前价格更新。description 的热门地区词属于稳定搜索意图，不是每日最低价榜单；容量列表随 payload 动态变化。`title`、canonical 等未纳入投影的 shell metadata 只在明确 SEO 变更中修改。资源字节变化后使用 `pnpm assets:update` / `pnpm assets:check`，不要手填版本。

`og-image.png` 是 1200×630 PNG 分享卡片，不是正文图片；OG/Twitter 共用该资源。视觉变更需要第三方重新抓取时采用新的稳定资源 URL，普通刷新网页不能证明社交缓存已更新。

页面使用 GA4（`G-K2S9L4CHNP`）和 Cloudflare Web Analytics。加载网络价格及统计脚本前清理搜索词、未知/重复/非法查询参数和未知 fragment；应用不写 Cookie，但 GA4 可能写 `_ga` 系列 Cookie。动态数据使用 DOM API 与 `textContent`。Cloudflare HTTP CSP 与 HTML meta CSP 保持一致的最小权限边界；详细隐私及响应头要求见 OPERATIONS。

## 验证与维护

在 `tools/icloud_price_comparison/` 执行，要求 Node.js >=22.1.0 和声明的 pnpm 10.14.0：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install chromium firefox webkit
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
pnpm test:browsers
pnpm audit --audit-level low
```

`pnpm test` = core + 三浏览器；`test:core` 包括资源/静态投影、vendor、解析、身份、数据、事务、幂等和工作流契约。`validate:artifact` 校验完整 data 的跨文件语义，`validate:snapshots` 深审所有规范化修订。

浏览器检查保持同一职责划分：

| 入口 | 覆盖 |
| --- | --- |
| 日更 `pnpm test:ui` | 同一 `ui-smoke.test.mjs`，复用套件内浏览器；保留高对比度、数据加载、排序、最低价、历史、失效恢复与隐私检查 |
| 本地 `pnpm test:browsers` / PR / push / 每周矩阵 | UI 套件 + 独立降序 URL / static fallback 场景；Chromium、Firefox、WebKit 都执行 |
| `pnpm test:firefox` / `pnpm test:webkit` | 对应浏览器的上述完整场景 |

forced-colors 只保留 UI 套件中的一个实现，Chromium 真正执行，其他引擎按能力跳过；不另起浏览器、不用名称黑名单绕开它、不增加重试。日更仍可使用 runner 自带 Chrome，不新增浏览器下载。浏览器缺失/启动失败必须报错退出，并释放已经创建的测试服务器；core 含不联网的缺浏览器故障回归。

`pnpm check:live` 是只读在线 dry-run，结束后工作树应不变；`pnpm update:data` 会写数据，只用于明确手动更新或隔离环境。不要用它替代只读诊断。

关键数据源、契约、生成器和 update/validate workflow 改动需同步 README、ARCHITECTURE、OPERATIONS；普通 UI 修改按影响更新相关文档，不堆积过程记录。PR 检查永久 ID、文档契约与已提交 diff 格式。价格与历史、依赖锁、供应链校验和生产验收不得因测试减重而放宽。

iCloud 自动化策略只约束本项目及其明确共享的受管 workflow；同仓库其他工具可独立新增 workflow，但额外 workflow 若引用 iCloud 路径或名称会被策略测试拒绝。

本地预览从仓库根运行 `python -m http.server 4173`，访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## 来源与许可

Apple 价格：<https://support.apple.com/en-us/108047>；官方中文名称：<https://support.apple.com/zh-cn/108047>。ExchangeRate-API 认证源使用 `https://v6.exchangerate-api.com/v6/latest/USD`，API Key 仅通过 `Authorization: Bearer` 发送；开放回退源为 <https://open.er-api.com/v6/latest/USD>。

税费、可用性、付款方式、购买区域限制和最终结算以 Apple 对应地区页面及实际结算为准。本工具与 Apple Inc. 无关联。自有代码见 [LICENSE](LICENSE)，第三方资源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `vendor/manifest.json`。
