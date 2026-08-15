# iCloud+ 全球价格比较

正式页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

原 GitHub Pages 地址（仅作为旧入口）：<https://linchun7.github.io/tools/icloud_price_comparison/>

本工具以 Apple Support 的 iCloud+ 价格页作为价格与发布日期来源，保留当地月费，并使用 ExchangeRate-API 数据生成两位小数的人民币参考价。人民币金额只用于横向比较，不是 Apple 结算价。

日常值守、自动更新、告警、事故处理、恢复和外部配置基线请阅读 [OPERATIONS.md](OPERATIONS.md)。一次性的发布清单与终验报告属于项目内部审计资料，不纳入公开仓库；它们不参与运行时，也不影响数据更新和页面展示。


## 功能

- 展示 Apple 页面解析出的地区、分区、币种、容量和当地月费，以及人民币参考价。
- 汇总每个容量按人民币参考汇率折算后的参考最低价和所有并列地区，支持地区搜索、分区筛选、容量/地区排序和 URL 状态恢复。
- 点击地区查看当地月费、人民币换算价、价格变动次数和完整的 Apple 当地标价历史记录。
- 展示 Apple `Published Date`，并记录发布日期变化时的容量、地区、分区、币种和价格差异。
- 记录新增或移除的地区和容量；地区恢复后继续使用原有历史。
- Apple 英文支持页决定价格、市场结构、币种、容量和发布日期；简体中文支持页只用于已复核的官方中文市场名称。中文 wording 尚未确认时保留 Apple 官方英文名，不阻断更新。
- 提供慢网络、重试、静态价格保留、旧数据和旧汇率状态；适配键盘、减弱动画、forced-colors、桌面和平板/手机窄屏。

## 自动更新

工作流：`.github/workflows/update-icloud-prices.yml`

- Cloudflare 主触发：每天北京时间 08:05（UTC 00:05），以 `workflow_dispatch` 和 `trigger_source=cloudflare` 运行。
- GitHub 原生备用：每天北京时间 08:10（UTC 00:10）。
- 两个自动入口共用每日幂等保护：当天已有成功自动运行、汇率不是旧值且抓取日期也是当天时，备用任务跳过；`main` 上的手动运行始终允许。

汇率按以下顺序获取：

1. 若配置 Actions Secret `EXCHANGE_RATE_API_KEY`，通过 `Authorization: Bearer` 请求 ExchangeRate-API 认证接口；密钥不进入 URL、公共 JSON或日志。
2. 认证接口失败、额度耗尽、时间戳异常、响应缺字段或缺少生产币种时，改用 ExchangeRate-API 开放接口。
3. 两个在线来源都失败时，只允许沿用 36 小时内、覆盖全部生产币种的上一份有效派生人民币结果；否则停止更新。

一次完整更新的顺序是：

1. 固定远端 `main` 生成基线，安装 lockfile 中的依赖并运行 `pnpm test:core`。
2. 在共享 5 分钟网络预算内抓取 Apple 页面；同一份 HTML 由 `document-order` 和 `apple-markers` 两条结构关联路径分别解析并逐字段交叉核对，两个解析器本身不分别发起网络请求。
3. 校验发布日期、地区、分区、容量、价格、汇率时间和异常调价。Apple 业务语义发生任何变化时，都在共享网络预算内执行第二次可重试的独立无缓存抓取；第二份 HTML 也必须通过双解析器核对，并与第一份规范化语义完全一致。确认抓取暂时不可用时保留上一份稳定数据，等待下一次运行重试，不发布部分结构。
4. 以事务方式生成 `prices.json`、`history.json`、`run-log.json` 和规范化 Apple JSON 快照，再从已验证的 `prices.json` 确定性生成 `index.html` 的价格区域并运行页面验收。
5. 深验整个 `data/`，连同生成的静态首页上传只读工件；独立发布 job 重新检查数据、静态投影、生成区域边界和远端基线，只在最后一步提交并推送。

生成与发布 job 权限隔离：抓取、依赖安装和测试 job 只有 `contents: read`；只有不安装项目依赖的发布 job 拥有 `contents: write`。远端 `main` 在生成或推送前前进时，本次发布失败关闭，等待下一次重新生成。

`data/prices.json` 始终是公共价格的唯一事实源；`index.html` 只保存由它生成的可见投影。页面在 JavaScript 未运行、网络较慢或刷新失败时也能直接显示最近一次已发布价格，JavaScript 只负责校验更新并启用搜索、筛选、排序和历史。使用 `pnpm render:static` 更新生成区域，使用 `pnpm render:static:check` 检查同步；不要手工编辑 markers 内的价格。

## 数据文件与公共契约

| 文件 | 内容 | 保留策略 |
| --- | --- | --- |
| `data/prices.json` | schema 4 当前价格、稳定市场 ID、来源、运行元数据、汇率来源/时间/状态，以及每个套餐的 `cnyPrice`/`cnyRank` | 只保留最新有效快照；不公开 raw FX rates、内部全精度换算值、API key 状态或密钥 |
| `data/history.json` | 以 `marketId` 为键的地区价格/币种事件和 Apple 发布日期事件 | 只有事件、迁移或结构变化时才改写 `updatedAt` 和文件；同一发布日期不重复 |
| `data/run-log.json` | 成功运行的来源、数量、耗时、非凭据汇率状态和差异 | 最近 90 条成功运行；不公开 API Key 配置/状态 |
| `data/apple-snapshots/` | Apple 页面解析后的规范化 JSON 证据和索引 | 不保存原始 HTML；同日修订不覆盖，见目录 README |

当前快照包含 73 个地区、44 种实际使用币种、5 个容量和 365 个价格点；后续合法的 Apple 变化可以改变数量。更新器每次从 Apple 结果重算所需币种集合：新币种只有在在线响应提供有效汇率时才可发布，已不再使用的币种会从内部计算集合移除，缺失汇率不会被臆造。

为保持数据来源透明，公共 FX 元数据仍会说明本次成功结果来自认证 endpoint、开放 endpoint 或受控 stale 回退；这可能间接表明某次运行成功使用了认证来源，但不会公开 Key 值、Key 是否配置、失败原因、有效性或额度状态。若连成功来源模式也被视为敏感，应在下一版契约中统一为供应商级 provenance。

前端只接受当前公共 schema 4，并要求稳定 `marketId`、生成器提供的 `cnyRank`、精确字段集合、受控来源 URL、合法时间关系、完整套餐和两位小数正值 `cnyPrice`。页面只有两层当前价格来源：由 `prices.json` 预渲染的静态 HTML，以及经同一契约校验的网络 `prices.json`；网络数据超过 7 天或超前 5 分钟以上时会被拒绝，不会覆盖已显示的静态价格。36 小时内的数据保持可用，36 小时至 7 天只作为历史参考。参考最低价只由 `cnyRank === 1` 决定，但价格数据过期或 `fx.stale` 时会隐藏最低价排名提示。历史文件是可选增强：历史加载失败不阻断当前价格，但损坏的生产历史会阻断下一次自动更新。

`scripts/market-registry.mjs` 是永久市场 identity catalog，只保存稳定 `marketId`、Apple 英文 canonical name 和历史 aliases；`scripts/country-names.zh.json` 是唯一的 Apple 简体中文名称事实源，字符串表示已审核 wording，`null` 表示仍待 Apple zh-CN authority 确认。pending 时 `nameZh` 使用 Apple 英文 `sourceName` 并记录 `CHINESE_MARKET_NAME_PENDING`，不会阻断英文价格更新。

**Automatic-first**：机器可安全确认的事实自动发布；heuristic suspicion 记录 warning 后继续；暂时不确定时优先自动 retry/fallback；只有高置信 ambiguity、contract corruption 或继续执行可能造成不可逆数据/identity 错误时才 fail closed。Apple 语义变化通常由 initial + 一次 no-store confirmation 确认；仅在 mismatch/confirmation parse degradation 时追加第三样本。A/B/B 或 A/degraded/A 可自动恢复，A/B/A、A/B/C 或无法取得第三样本按 transient 停止并留待后续自动任务重试。两份 Apple `cross-checked` 样本只为当地价格与币种提供 authority：同币种大幅变价在硬边界内以 `PRICE_CHANGE_ANOMALY_CONFIRMED` 继续；Apple 未变化而 FX 导致的 CNY 异常按已选 FX 的 sanity policy 以 `FX_DERIVED_CHANGE_ANOMALY_ACCEPTED` 继续，不能声称由 Apple 确认；换币种导致显著 CNY 变化时，新币种为 CNY 或其 FX check 为 `passed` 才自动继续，否则以 `CURRENCY_CHANGE_VALUE_REVIEW_REQUIRED` fail closed。FX candidate 未通过 sanity 时自动尝试 open source，再安全回退到 36 小时内的 previous FX/CNY 数据，绝不发布异常新汇率。

Apple 第一次出现未登记市场时会生成可复现的 `apple-…-<hash>` ID、记录 `UNKNOWN_APPLE_MARKET` 后继续发布；发布之后，schema 4 prices/history 中的 identity ledger 优先于生成器。registry 后续收录必须沿用已发布 ID，历史中已移除市场的 ID 也永久保留；不同新 identity 撞到 registry 或完整历史保留 ID 时失败关闭。只有 removed 与 added unknown 形成双向唯一，且 region、currency、tier ID structure、完整当地价格向量都完全相同，才属于高置信度 identity ambiguity 并要求维护者显式增加 alias；repricing 或多个 exact candidates 都只记录非阻断 `MARKET_IDENTITY_RENAME_SUSPECTED` 并继续自动发布。两种情况都不进行模糊匹配或自动迁移。

## 变化、失败关闭与工件保护

- Apple HTML 最大 5 MiB，汇率 JSON 最大 1 MiB；同时检查声明的 `Content-Length` 和流式实际字节数，超限即取消读取。声明长度不是安全整数、无 stream 时响应超限或正文不是严格 UTF-8 也会拒绝。
- 两条 Apple 关联路径只有逐字段一致时才标记 `cross-checked`，**生产发布强制要求该状态**；单路失败只可用于诊断，不再发布降级结果。两路共享数字/币种/容量规范化，因此不宣称是完全独立实现。
- Apple 发布日期缺失、格式无效、倒退、晚于观测日期或与历史不一致时拒绝更新。
- 拒绝重复地区、关键分区缺失、重复/非规范容量、未支持但像容量的 KB/MB/PB/EB/IEC 单位、价格点不完整和不安全对象键。
- 同币种单项价格超过旧价 10 倍或低于旧价 1/10 时拒绝；换币种时使用新旧汇率分别折算并执行相同硬比例限制。硬边界内的 Apple confirmed 当地价格异常、通过既定 FX policy 的 FX-only CNY 异常，以及具备 `passed` FX baseline（或直接为 CNY）的 confirmed currency change 会分别记录与其 authority 一致的 warning 后继续；显著 currency change 若缺少可靠新币种 FX baseline 则要求 review。当前市场相对 CNY 中位数超过 20 倍或低于 1/20 始终拒绝。
- FX 时间最多允许相对生成时间未来 5 分钟，且不能早于生成时间 36 小时 + 5 分钟；在线与回退路径执行同一生产币种完整性校验。
- 浏览器读取 `prices.json` / `history.json` 的上限分别为 1 MiB / 8 MiB；拒绝 redirect、超限和非法 UTF-8，8 秒超时覆盖响应体读完而不只是收到响应头。
- 生产文件使用原子写入和持久事务日志；被强制终止后，下次运行先恢复未完成事务。
- `validate-data-artifact.mjs` 在 tar 展开前拒绝 traversal、绝对路径、链接、设备、非 POSIX ustar、可执行或特殊权限等；展开后再次检查文件类型、权限和精确文件集合。
- 工件验证会深度解析全部快照、核对索引/hash/当前价格，并从相邻活动快照重算发布日期变化，拒绝与 `history.json` 变化描述不一致的数据。
- 整目录发布保留删除语义；不要只替换单个 JSON，也不要手工拼接历史。

## 日常维护

在 **Actions > Update iCloud prices** 检查：

- 成功摘要：解析状态、地区/价格点数量、Apple 日期、汇率时间/来源和本次变化。
- 黄色提示记录自动 fallback / anomaly；系统会按既定策略继续或由备用任务自动重试，只有持续异常或明确的 review-required 状态才需要人工处理。解析器冗余降级仍会停止发布。
- 红色失败：查看第一个失败步骤，再下载 `icloud-price-diagnostics-*`。附件只含结构化报告和成功解析后的规范化 JSON，不保存失败响应、Apple 原始 HTML 或 Secret。

可选 Healthchecks 心跳使用 Secret `ICLOUD_HEALTHCHECK_PING_URL`：完整发布并验证真实 production 后发送 `/0`；同日幂等路径也必须先证明已验证 main payload 与真实 production 一致，不能仅凭 skip 成功。数据损坏、解析降级、production proof 失败等严重故障发送 `/1`；单次暂时网络故障不立即发送失败，由 Healthchecks 的 Grace Time 判断连续缺失。Ping URL 不得进入仓库、Issue 或日志。

每周只读维护工作流使用完整历史审计仓库增长：Git 历史达到 500 MiB 时警告、达到 800 MiB 时失败，`history.json` 达到 2 MiB 时警告；工作流不自动改写 Git 历史。完整值守、告警分级、Secret 轮换和恢复步骤见 [OPERATIONS.md](OPERATIONS.md)。

## GitHub Actions 与供应链

- `.github/workflows/validate-icloud-price-comparison.yml` 在相关 PR、人工 `main` push、手动触发及每周计划任务中，以只读权限运行核心、完整数据工件、全部 Apple 快照、Chromium、Firefox、WebKit 和依赖漏洞检查。
- `.github/workflows/icloud-repository-maintenance.yml` 每周以完整历史、只读权限检查 Git 对象和价格历史增长；每日更新与发布 checkout 保持浅克隆。
- 每日数据任务使用 runner 预装 Chrome；自动数据提交不会再次触发完整三浏览器工作流，因此发布工件在推送前必须已通过每日 job 自身的 core/data/Chrome 验收。
- Dependabot 每周检查 npm 与 GitHub Actions。只有官方 `actions/*`、最多 20 个 workflow 文件、完整 40 位 SHA、一对一替换、精确 tested head/base 且 SHA 与注释中的官方 semver tag 一致的变更可以自动合并；第三方 Action、可变 tag、业务文件或额外 YAML 改动会拒绝。
- vendored Lucide subset 的版本、精确文件集、SHA-256、上游 icon node、实际使用集和许可 notice 由 `pnpm test:vendor` 校验。
- `pnpm assets:update` 按依赖顺序计算浏览器资源 SHA-256 前 8 位并更新 HTML/模块引用；`pnpm assets:check` 在 CI 中拒绝陈旧或手工版本号。
- lockfile 中所有直接版本均精确固定，所有 npm 包 resolution 都有 SHA-512 integrity；`packageManager` 还固定 pnpm 10.14.0 的 Corepack SHA-512。CI 使用 Corepack、`pnpm install --frozen-lockfile --ignore-scripts`，并显式安装浏览器，避免全局安装漂移和依赖生命周期脚本。

仓库 ruleset、required checks、Cloudflare 配置和 Secret 值属于外部状态，代码测试无法代替项目所有者的发布前验收；这些控制面应按内部发布清单逐项核对，仓库不保存 Secret 或内部签字记录。

## 本地验证

从本目录执行，要求 Node.js 22+ 和项目声明的 pnpm 10.14.0：

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec playwright install chromium firefox webkit
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
pnpm test:browsers
pnpm test:ui
pnpm test:firefox
pnpm test:webkit
pnpm check:live
pnpm audit --audit-level low
```

- `pnpm test:core`：vendor、抓取/解析、数据契约、事务、工件攻击、幂等、自动合并和 workflow 测试。
- `pnpm validate:artifact`：验证当前完整 `data/` 目录及跨文件语义。
- `pnpm validate:snapshots`：深度解析全部规范化 Apple 快照修订。
- `pnpm test:browsers`：在本机依次运行 Chromium、Firefox、WebKit 的同一套 UI 验收；GitHub Actions 才使用独立 matrix runners 并行运行三种浏览器。
- `pnpm test:ui`：运行 Chromium；本地缺 Playwright Chromium 时可回退系统 Chrome/Chromium，CI 缺浏览器会失败。
- `pnpm test:firefox` / `pnpm test:webkit`：真实导入并运行同一 UI suite，不是仅做启动探测。
- `pnpm check:live`：只读访问 Apple 和汇率服务并执行完整 dry-run，结束后工作树必须不变。
- `pnpm update:data`：写生产数据，只用于明确的手动更新或隔离环境。

完整命令 `pnpm test` 等价于 core 后执行三浏览器 UI 验收。

本地预览从仓库根目录启动：

```bash
python -m http.server 4173
```

访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## Apple 页面快照与历史导入

`data/apple-snapshots/` 只保存规范化 JSON 与索引。生产更新、同日修订、`firstConfirmedDate`、hash、事务回滚和历史导入要求见 [data/apple-snapshots/README.md](data/apple-snapshots/README.md)。

历史资料导入：

```bash
node scripts/import-apple-archives.mjs --input <包含完整历史快照的目录>
```

输入必须覆盖索引中除当前 live 日期外的全部既有发布日期；未知地区、空目录、不完整目录、解析或跨文件校验失败都会在提交前拒绝。导入器只读取外部 HTML，不把原始 HTML 写入仓库；Wayback 只用于历史 Apple 页面排序和证据追溯，不是独立价格源。

## 数据来源、限制与发布许可

- Apple 价格和发布日期：<https://support.apple.com/en-us/108047>
- Apple 中文名称：<https://support.apple.com/zh-cn/108047>
- 汇率：<https://www.exchangerate-api.com/docs/overview>；开放接口只作为自动回退

人民币结果仅供信息与横向比较；税费、可用性、付款方式、购买区域限制和最终结算以 Apple 对应地区页面与结算结果为准。本工具与 Apple Inc. 无关联，数据仅供参考。

发布前必须由项目所有者关闭以下许可风险：

1. [Apple Website Terms of Use](https://www.apple.com/legal/internet-services/terms/site.html) 对 robot、spider、page-scrape、其他自动访问，以及复制/公开发布站点内容设有限制；每日自动抓取与公开价格展示应取得适用的书面授权，或由法律顾问确认合法替代方案。
2. [ExchangeRate-API Terms](https://www.exchangerate-api.com/terms) 禁止其数据再分发，并建议不确定用例取得书面指导。公共 schema 已删除 raw rates，只保留价格比较的派生 CNY，但上线前仍应保存供应商对该具体公开用途的书面确认。

以上是工程发布门禁说明，不构成法律意见。

## 隐私与 Web 安全

- 页面启用 Google Analytics 4（测量 ID `G-K2S9L4CHNP`）和 Cloudflare Web Analytics。GA4 在价格内容完成初始化后低优先级加载；配置明确关闭 Google Signals 与广告个性化信号，不发送站内搜索词。
- Cloudflare 代理自动注入 Web Analytics Beacon，并回传同源 `/cdn-cgi/rum`。按 [Cloudflare 官方说明](https://developers.cloudflare.com/web-analytics/about/)，该服务不收集或使用访问者个人数据；其他 Cloudflare 安全功能可能有独立的必要 Cookie/披露要求，应由站点隐私负责人核对。
- 初始脚本会在价格数据请求及分析 Beacon 执行前删除 `q`、未知/重复/非法查询参数和未知 fragment；搜索词最多 160 个 Unicode code point，只留在内存。URL 只保留规范的 `tier`、`sort`、`dir`、`region`。更早发出的样式/脚本等子资源请求由 meta Referrer Policy `origin` 保护，Referer 不包含路径或查询参数。
- 客户端无法清理首次文档请求：用户输入的原始 URL 仍可能被浏览器历史、代理、Cloudflare/GitHub Pages 和源站看到，因此不要把 Secret 或个人信息放进 URL。
- 应用自身不写 Cookie、localStorage、sessionStorage 或 IndexedDB；GA4 加载后可能按 Google 的实现写入 `_ga` 系列 Cookie。当前价格只来自已验证的静态 HTML 与网络 JSON，不依赖浏览器持久存储。
- 所有动态数据使用 `textContent`、`createTextNode` 和 DOM API 渲染；不使用 `innerHTML`、`eval`、`document.write` 或字符串事件处理器。外链新窗口均带 `noopener noreferrer`。
- Cloudflare HTTP CSP 与 HTML meta CSP 必须保持一致。脚本只允许本站、`www.googletagmanager.com` 和 `static.cloudflareinsights.com`；GA4 连接/像素只允许 `*.google-analytics.com`、`*.analytics.google.com` 和 `www.googletagmanager.com`，其他类型继续使用最小来源。`base-uri`、form/object/frame/worker/media/manifest 均为 `none`，HTTP header 另需 `frame-ancestors 'none'`。精确策略见 [OPERATIONS.md](OPERATIONS.md)。
- HTTP 层还应保持 `X-Content-Type-Options: nosniff`、frame deny、设备权限关闭、HSTS、最低 TLS 1.2，以及可验证的证书/DNS/跳转/404/缓存行为。具体基线见 [OPERATIONS.md](OPERATIONS.md)。
- 自有代码许可见 [LICENSE](LICENSE)；前端第三方资源许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `vendor/manifest.json`。
