# iCloud+ 全球价格比较

正式页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

原 GitHub Pages 地址（保留为旧入口）：<https://linchun7.github.io/tools/icloud_price_comparison/>

本工具只把 Apple Support 的 iCloud+ 价格作为价格和发布日期来源；当地价格会保留，并按汇率换算人民币作横向比较。人民币金额不是 Apple 的结算价。

## 功能

- 展示 Apple 页面解析出的地区、分区、币种、容量和当地月费，并计算人民币参考价。
- 汇总每个容量的最低价和对应地区，支持地区搜索、分区筛选、容量排序。
- 点击地区查看当地月费、人民币参考价、价格历史和涨跌比例。
- 展示 Apple `Published Date`，并在发布日期变化时记录容量、地区、分区、币种和价格差异；发布日期历史在移动端自适应显示，无需左右滑动。
- 记录新增或移除的地区和容量；地区恢复后继续使用原有历史。
- 使用 Apple 中文支持页面的名称映射；没有映射时保留 Apple 官方英文名。
- 提供加载、慢网络、重试、旧数据和旧汇率状态；适配桌面、平板和手机，支持键盘和减弱动画。

## 自动更新

工作流：`.github/workflows/update-icloud-prices.yml`

- Cloudflare 主触发：每天北京时间 08:05（UTC 00:05），以 `workflow_dispatch` 的 `trigger_source=cloudflare` 运行。
- GitHub 原生备用：每天北京时间 08:10（UTC 00:10）。
- 两个自动入口共用每日幂等保护：当天已有成功的自动运行，且汇率不是旧值、抓取日期也是当天，北京时间备用任务会跳过；`main` 分支上的手动运行始终允许。

汇率按以下顺序获取：

1. 使用 Actions Secret `EXCHANGE_RATE_API_KEY`，通过 ExchangeRate-API 的认证接口请求；密钥放在请求头，不写入 URL。
2. 认证接口失败、额度耗尽、响应缺字段或缺少所需币种时，改用 ExchangeRate-API 开放接口。
3. 两个在线来源都失败时，只沿用 36 小时内且覆盖全部生产币种的上一份有效汇率；否则停止更新。

Secret 只配置在仓库 **Settings > Secrets and variables > Actions**。密钥缺失或认证接口失效但开放接口成功时只写普通提示；沿用旧汇率才写警告。

一次完整更新的顺序是：

1. 安装锁定依赖，运行 `pnpm test:core`。
2. 抓取 Apple 页面，由 `document-order` 和 `apple-markers` 两条 DOM 关联路径分别解析并逐字段比对。前者按通用标题/列表的文档顺序关联地区与价格，后者按 Apple 的区域 ID 和 `.gb-header` 标记关联；两者共享币种、数字、容量等底层规范化，因此属于结构关联层冗余，不宣称完全独立实现。
3. 校验发布日期、地区、分区、容量、价格、汇率和异常调价。
4. 写入当前价格、历史、运行日志和规范化 Apple JSON 快照；随后运行 `pnpm test:data`，并用 runner 预装的 Chrome 验证更新后的页面。
5. 将已经通过测试的 `data/` 打包并校验哈希，以只读构建任务上传；拥有写权限的独立发布任务只下载该工件、确认远端 `main` 仍是生成基线，再提交并推送。远端已前进时停止发布并等待下次重试。

UI 测试、抓取、解析、数据校验或生产写入任一步骤失败都会停止提交；生产写入失败时恢复上一份有效数据。

## 数据文件

| 文件 | 内容 | 保留策略 |
| --- | --- | --- |
| `data/prices.json` | 当前有效价格、Apple 来源和发布日期、容量、计算所需的最小汇率集、解析器和运行时间 | 只保留最新有效快照 |
| `data/history.json` | 地区价格/币种事件和 Apple 发布日期事件 | 真实变化才追加；同一发布日期不重复 |
| `data/run-log.json` | 成功运行的来源、数量、耗时、汇率状态和差异 | 最近 90 条成功运行 |
| `data/apple-snapshots/` | Apple 页面解析后的规范化 JSON 证据和 `index.json` | 见 `data/apple-snapshots/README.md`；不保存原始 HTML，旧修订不覆盖 |

当前有效快照的生成时间和 Apple `Published Date` 见 `data/prices.json`；当前快照包含 73 个地区、44 种实际使用币种、5 个容量和 365 个价格点，后续自动运行可能改变这些数量。每次更新都从本次 Apple 地区结果重新计算所需币种集合：新币种只有在在线汇率响应包含有效汇率时才会进入生产数据；已经不被任何现存地区使用的旧币种会在本次成功更新中移除；新币种缺汇率时整次更新失败，不会发布缺失或臆造汇率的数据。

`history.json` 的 `sourcePublishedDates` 会保存首次记录和后续发布日期变化；发布日期未变化时，价格、币种、分区等变化仍记录在地区事件和 `run-log.json` 中。前端把历史文件视为可选数据：历史文件加载失败时仍可显示当前价格；更新脚本读取到损坏的生产 JSON 会停止并要求从 Git 历史恢复，不会静默修复。

## 变化与保护

- 两条 DOM 关联路径逐字段一致时标记 `cross-checked`；单路失败可降级，两路分歧或同时失败则拒绝更新。两路采用不同的页面结构定位维度，但共享底层价格/币种/容量规范化；它能发现区域定位和列表关联漂移，不能对共享规范化代码里的同一缺陷提供完全独立证明。
- 只接受 Apple 价格；Wayback 仅用于导入历史 Apple 页面证据，不是替代价格源。
- Apple 发布日期缺失、格式无效、倒退或晚于本次观测日期时拒绝更新。
- 拒绝重复地区、关键分区缺失和价格容量不完整。若 Apple 合法下架任意数量的地区，必须用第二次独立请求得到相同发布日期、相同规范化内容和完全一致的下架名单才允许同步；数量不再决定能否下架。分区数量保护仍会拦截标题或区域结构被误解析造成的批量假下架。
- 同一币种的单项价格超过旧价 10 倍或低于旧价 1/10 时拒绝更新。
- 币种变化时使用新旧汇率分别折算人民币，同样执行 10 倍硬限制和联合异常校验，不能通过换币种绕过检查。
- 联合异常需同时达到至少 200% 的涨幅、当地金额门槛、按旧汇率计算的人民币门槛和按当前汇率计算的人民币门槛；人民币门槛为 `max(15 元, 上次人民币价值 × 50%)`。
- Key 接口和开放接口执行相同的响应、时间戳和所需币种校验；汇率过旧或在未来时也会失败。
- 上一份回退汇率也执行 36 小时新鲜度和生产币种完整性校验。
- Apple 与汇率请求共享 5 分钟网络预算；每次超时和重试等待都受剩余预算限制，Apple 超时停止更新，汇率超时可沿用上一份有效数据。
- 生产 JSON 使用原子写入；快照、历史或索引写入失败时清理本次文件并回滚上一份有效数据，历史导入不会覆盖未入索引的既有证据。

## 日常维护

在 **Actions > Update iCloud prices** 查看：

- 成功摘要：解析状态、地区/价格点数量、Apple 日期、汇率时间、汇率来源和本次变化。
- 黄色提示：解析降级或汇率回退需要复核；核心数据可能已经提交。
- 红色失败：先看第一个失败步骤，再下载 `icloud-price-diagnostics-*` 附件。失败附件只含结构化运行报告和成功解析后的规范化 JSON，不保存失败响应或 Apple 原始 HTML。

可选的第三方告警已接入 Healthchecks，启用步骤如下：

1. 在 [Healthchecks.io](https://healthchecks.io/) 免费账户中新建检查，名称建议 `iCloud price daily update`。
2. 推荐使用 Cron 计划 `5 0 * * *`、时区 `UTC`、Grace Time `4 hours`；它对应北京时间 08:05 主触发，并给 GitHub 08:10 备用和完整更新留出时间。也可用简单周期 `26 hours` 加 `4 hours` 宽限。
3. 给检查启用至少一个真正会查看的通知渠道（邮件最简单），复制该检查的私密 Ping URL。
4. 在仓库 **Settings > Secrets and variables > Actions > New repository secret** 新建 `ICLOUD_HEALTHCHECK_PING_URL`，值为不带结尾 `/0` 或 `/1` 的基础 Ping URL。
5. 在 **Actions > Update iCloud prices > Run workflow** 手动运行一次，确认 Healthchecks 最近事件显示退出码 `0`。不要把 Ping URL 写进仓库、日志或公开 Issue。

工作流完成后成功发送 `/0`、失败发送 `/1`；每日幂等跳过也视为成功。心跳步骤设置了 `continue-on-error`，未配置或告警服务短暂不可用都不会反过来阻塞价格更新。Cloudflare 08:05 仍是主触发，GitHub 08:10 是备用；外部心跳的价值是当两个入口都没有完成时仍能从 Cloudflare/GitHub 之外发出“未按时运行”告警。

Healthchecks 不是唯一选择。UptimeRobot 免费版包含 heartbeat/cron 和网站可用性监控，Better Stack 免费版也包含 heartbeat、站点监控和事件管理；但当前 `/0`、`/1` 实现按 Healthchecks 的退出码 Ping API 编写，换服务前要适配对应的成功/失败 URL。Cloudflare Cron Events 能查看 Worker 最近 100 次计划调用；Cloudflare 独立 Health Checks 可监测网址/源站可用性，但仅 Pro 及以上提供，并不能直接证明每日 GitHub 数据更新成功。若由同一个 Cloudflare 账户同时负责触发和告警，Cloudflare 自身故障时会形成共同失效点，因此仍建议保留一个外部心跳。

容量预警阈值为 Git 历史 500 MiB、800 MiB，或 `history.json` 2 MiB；工作流不会自动清理 Git 历史。恢复数据时使用 Git 历史中的完整 `data/` 文件，不要手工拼接 JSON。

## 官方 Action 自动升级

- Dependabot 每周检查 GitHub Actions，只为 GitHub 官方 `actions/*` 创建分组升级 PR，包括主版本升级。
- Action 引用始终使用完整 40 位提交 SHA，并保留版本注释。
- PR 必须通过只读的核心、Chrome、WebKit 和依赖审计；自动合并任务还会核对 Dependabot 身份、默认分支、已测试的 base/head SHA 和逐行差异。
- 只有 `.github/workflows/*.yml|yaml` 中 `actions/*@完整SHA # v…` 的一对一替换可自动合并；第三方 Action、业务文件、可变标签或额外 YAML 改动都会停止自动合并。

## 本地验证

以下命令从 `tools/icloud_price_comparison/` 执行，需要 Node.js 22+、pnpm，并先安装 Playwright Chromium 与 WebKit：

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm test
pnpm test:core
pnpm test:data
pnpm test:browsers
pnpm test:ui
pnpm test:webkit
pnpm validate:snapshots
pnpm check:live
pnpm audit --audit-level low
```

- `pnpm test`：先运行核心测试，再并行运行 Chromium 和 WebKit 验收。
- `pnpm test:core`：运行更新前的解析、数据契约、快照哈希、幂等和工作流核心测试。
- `pnpm test:data`：只检查当前提交的价格、历史、运行日志和快照索引。
- `pnpm test:browsers`：在独立进程中并行运行 Chromium 和 WebKit 的同一套 UI 验收。
- `pnpm test:ui`：启动本地静态服务器并优先使用 Playwright Chromium；未安装时回退系统 Chrome/Chromium，CI 没有浏览器会失败，本地没有浏览器会跳过。
- `pnpm test:webkit`：使用 Playwright WebKit 运行同一套 UI 验收，用于覆盖 Safari/WebKit 兼容性。
- `pnpm validate:snapshots`：深度校验全部规范化 Apple JSON 快照、索引和哈希；任何未入索引的 HTML 或 JSON 都会失败。
- `pnpm check:live`：只读访问 Apple 和汇率服务并执行校验，不写生产文件。
- `pnpm update:data`：写入生产数据，只用于明确的手动更新或隔离环境。

`.github/workflows/validate-icloud-price-comparison.yml` 会在相关 PR、人工 `main` 推送和手动触发时以只读权限运行核心、Chromium、WebKit 和依赖漏洞检查；手动及每周计划任务还会深度审计全部 Apple 快照；每周计划任务在北京时间周一 06:05 运行。每日更新使用 runner Chrome，自动数据提交不会重复启动该完整验证。仓库使用的 Action 全部固定到完整提交 SHA。

本地预览从仓库根目录启动静态服务器：

```bash
python -m http.server 4173
```

然后访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## Apple 页面快照与历史导入

`data/apple-snapshots/` 只保存每个 Apple `Published Date` 的规范化 JSON 和索引。生产更新和历史导入的文件命名、修订、`firstConfirmedDate`、回滚和完整性要求见 `data/apple-snapshots/README.md`。导入器可以读取外部历史 HTML，但不会把 HTML 写进仓库。

历史资料导入（命令从本目录执行）：

```bash
node scripts/import-apple-archives.mjs --input <包含完整历史快照的目录>
```

输入目录必须包含索引中除当前 live 日期以外的所有既有发布日期；空目录或不完整目录会拒绝。导入使用隔离临时目录，校验和写入任一环节失败都会恢复原有历史和索引。

这里的“当前 live 日期”是 `data/prices.json.source.publishedDate` 规范化后的日期。

## 数据来源与限制

- 价格和发布日期：[Apple Support](https://support.apple.com/en-us/108047)
- 中文名称：[Apple 中文支持](https://support.apple.com/zh-cn/108047)
- 汇率：[ExchangeRate-API](https://www.exchangerate-api.com/docs/overview)，开放接口作为自动回退

人民币金额仅用于横向比较；税费、可用性和购买区域限制以 Apple 对应地区页面及结算结果为准。本工具与 Apple Inc. 无关联。

## 隐私、安全与许可

- Google Analytics 不写在阻塞渲染的 HTML 中；页面及核心价格数据加载完成后，浏览器在空闲阶段异步加载统计脚本。页面不显示统计同意弹窗或隐私设置入口；Google 服务无法访问时不影响价格比较。
- 前端只展示本页换算所需的币种汇率，汇率署名链接固定为 [Rates By Exchange Rate API](https://www.exchangerate-api.com)。
- 本项目自有代码许可见 `LICENSE`，第三方前端资源的版本、哈希和完整许可文本见 `THIRD_PARTY_NOTICES.md` 与 `vendor/manifest.json`。Dependabot 每周检查 npm 和 GitHub Actions 更新。
