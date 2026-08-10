# iCloud+ 全球价格比较

正式页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

原 GitHub Pages 地址（仅作为旧入口）：<https://linchun7.github.io/tools/icloud_price_comparison/>

本工具以 Apple Support 的 iCloud+ 价格页作为价格与发布日期来源，保留当地月费，并使用 ExchangeRate-API 数据生成两位小数的人民币参考价。人民币金额只用于横向比较，不是 Apple 结算价。

日常值守、自动更新、告警、事故处理、恢复和外部配置基线请阅读 [OPERATIONS.md](OPERATIONS.md)。一次性的发布清单与终验报告属于项目内部审计资料，不纳入公开仓库；它们不参与运行时，也不影响数据更新和页面展示。


## 功能

- 展示 Apple 页面解析出的地区、分区、币种、容量和当地月费，以及人民币参考价。
- 汇总每个容量的最低价和对应地区，支持地区搜索、分区筛选、容量/地区排序和 URL 状态恢复。
- 点击地区查看当地月费、人民币参考价、价格历史和涨跌比例；Chart.js 仅在需要绘图时延迟加载。
- 展示 Apple `Published Date`，并记录发布日期变化时的容量、地区、分区、币种和价格差异。
- 记录新增或移除的地区和容量；地区恢复后继续使用原有历史。
- 使用已复核的 Apple 中文名称映射；没有映射时保留 Apple 官方英文名。
- 提供慢网络、重试、缓存回退、旧数据和旧汇率状态；适配键盘、减弱动画、forced-colors、桌面和平板/手机窄屏。

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
2. 在共享 5 分钟网络预算内抓取 Apple 页面；`document-order` 和 `apple-markers` 两条结构关联路径分别解析后逐字段交叉核对。
3. 校验发布日期、地区、分区、容量、价格、汇率时间和异常调价。普通价格变化不要求第二次网络抓取；只有地区或容量集合新增/移除时，才在共享网络预算内执行可重试的无缓存确认，并要求两份成功的完整结果一致。确认抓取暂时不可用时保留上一份稳定数据，等待下一次运行重试，不发布部分结构。
4. 以事务方式生成 `prices.json`、`history.json`、`run-log.json` 和规范化 Apple JSON 快照，再运行数据与 runner Chrome 验收。
5. 深验整个 `data/`，打包 ustar 并上传只读工件；独立发布 job 重新检查 tar、展开目录和远端基线，只在最后一步提交并推送完整 `data/`。

生成与发布 job 权限隔离：抓取、依赖安装和测试 job 只有 `contents: read`；只有不安装项目依赖的发布 job 拥有 `contents: write`。远端 `main` 在生成或推送前前进时，本次发布失败关闭，等待下一次重新生成。

## 数据文件与公共契约

| 文件 | 内容 | 保留策略 |
| --- | --- | --- |
| `data/prices.json` | schema 3 当前价格、来源、运行元数据、汇率来源/时间/状态，以及每个套餐两位小数的 `cnyPrice` | 只保留最新有效快照；不公开 raw FX rates、API key 状态或密钥 |
| `data/history.json` | 地区价格/币种事件和 Apple 发布日期事件 | 真实变化才追加；同一发布日期不重复 |
| `data/run-log.json` | 成功运行的来源、数量、耗时、非凭据汇率状态和差异 | 最近 90 条成功运行；不公开 API Key 配置/状态 |
| `data/apple-snapshots/` | Apple 页面解析后的规范化 JSON 证据和索引 | 不保存原始 HTML；同日修订不覆盖，见目录 README |

当前快照包含 73 个地区、44 种实际使用币种、5 个容量和 365 个价格点；后续合法的 Apple 变化可以改变数量。更新器每次从 Apple 结果重算所需币种集合：新币种只有在在线响应提供有效汇率时才可发布，已不再使用的币种会从内部计算集合移除，缺失汇率不会被臆造。

为保持数据来源透明，公共 FX 元数据仍会说明本次成功结果来自认证 endpoint、开放 endpoint 或受控 stale 回退；这可能间接表明某次运行成功使用了认证来源，但不会公开 Key 值、Key 是否配置、失败原因、有效性或额度状态。若连成功来源模式也被视为敏感，应在下一版契约中统一为供应商级 provenance。

前端只接受当前公共 schema 3，并要求精确字段集合、受控来源 URL、合法时间关系、完整套餐和两位小数正值 `cnyPrice`。网络优先；只有通过同一契约校验的 `localStorage` 当前价格缓存可在网络失败时显示，并明确标记“已验证缓存/网络刷新失败”。历史文件是可选增强：历史加载失败不阻断当前价格，但损坏的生产历史会阻断下一次自动更新。

## 变化、失败关闭与工件保护

- Apple HTML 最大 5 MiB，汇率 JSON 最大 1 MiB；同时检查声明的 `Content-Length` 和流式实际字节数，超限即取消读取。声明长度不是安全整数、无 stream 时响应超限或正文不是严格 UTF-8 也会拒绝。
- 两条 Apple 关联路径只有逐字段一致时才标记 `cross-checked`，**生产发布强制要求该状态**；单路失败只可用于诊断，不再发布降级结果。两路共享数字/币种/容量规范化，因此不宣称是完全独立实现。
- Apple 发布日期缺失、格式无效、倒退、晚于观测日期或与历史不一致时拒绝更新。
- 拒绝重复地区、关键分区缺失、重复/非规范容量、未支持但像容量的 KB/MB/PB/EB/IEC 单位、价格点不完整和不安全对象键。
- 同币种单项价格超过旧价 10 倍或低于旧价 1/10 时拒绝；换币种时使用新旧汇率分别折算并执行相同硬限制和联合异常阈值。当地价格/币种不变但派生 CNY 因 FX 变化至少 50% 时拒绝；新市场相对当前市场中位数超过 20 倍或低于 1/20 也拒绝。
- FX 时间最多允许相对生成时间未来 5 分钟，且不能早于生成时间 36 小时 + 5 分钟；在线与回退路径执行同一生产币种完整性校验。
- 浏览器读取 `prices.json` / `history.json` 的上限分别为 1 MiB / 8 MiB；拒绝 redirect、超限和非法 UTF-8，8 秒超时覆盖响应体读完而不只是收到响应头。
- 生产文件使用原子写入和持久事务日志；被强制终止后，下次运行先恢复未完成事务。
- `validate-data-artifact.mjs` 在 tar 展开前拒绝 traversal、绝对路径、链接、设备、非 POSIX ustar、可执行或特殊权限等；展开后再次检查文件类型、权限和精确文件集合。
- 工件验证会深度解析全部快照、核对索引/hash/当前价格，并从相邻活动快照重算发布日期变化，拒绝与 `history.json` 变化描述不一致的数据。
- 整目录发布保留删除语义；不要只替换单个 JSON，也不要手工拼接历史。

## 日常维护

在 **Actions > Update iCloud prices** 检查：

- 成功摘要：解析状态、地区/价格点数量、Apple 日期、汇率时间/来源和本次变化。
- 黄色提示：汇率回退需要立即复核；解析器降级会停止发布并按严重状态处理。
- 红色失败：查看第一个失败步骤，再下载 `icloud-price-diagnostics-*`。附件只含结构化报告和成功解析后的规范化 JSON，不保存失败响应、Apple 原始 HTML 或 Secret。

可选 Healthchecks 心跳使用 Secret `ICLOUD_HEALTHCHECK_PING_URL`：完整成功或幂等跳过发送 `/0`，数据损坏、解析降级、工件验证失败等严重故障发送 `/1`；单次暂时网络故障不立即发送失败，由 Healthchecks 的 Grace Time 判断连续缺失。Ping URL 不得进入仓库、Issue 或日志。

容量预警阈值为 Git 历史 500/800 MiB 或 `history.json` 2 MiB；工作流不自动改写 Git 历史。完整值守、告警分级、Secret 轮换和恢复步骤见 [OPERATIONS.md](OPERATIONS.md)。

## GitHub Actions 与供应链

- `.github/workflows/validate-icloud-price-comparison.yml` 在相关 PR、人工 `main` push、手动触发及每周计划任务中，以只读权限运行核心、完整数据工件、全部 Apple 快照、Chromium、Firefox、WebKit 和依赖漏洞检查。
- 每日数据任务使用 runner 预装 Chrome；自动数据提交不会再次触发完整三浏览器工作流，因此发布工件在推送前必须已通过每日 job 自身的 core/data/Chrome 验收。
- Dependabot 每周检查 npm 与 GitHub Actions。只有官方 `actions/*`、最多 20 个 workflow 文件、完整 40 位 SHA、一对一替换、精确 tested head/base 且 SHA 与注释中的官方 semver tag 一致的变更可以自动合并；第三方 Action、可变 tag、业务文件或额外 YAML 改动会拒绝。
- vendored Chart.js 和 Lucide subset 的版本、精确文件集、SHA-256、上游字节/icon node、实际使用集和许可 notice 由 `pnpm test:vendor` 校验。
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
- `pnpm test:browsers`：在独立进程中并行运行 Chromium、Firefox、WebKit 的同一套 UI 验收。
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

- 候选版本不包含 Google Analytics、Google Tag Manager、Google Signals 或 Google 域名；页面只使用 Cloudflare Web Analytics。部署后必须用干净浏览器确认没有 Google 请求、`_ga` Cookie 或 GA 全局对象。
- Cloudflare 代理自动注入 Web Analytics Beacon，并回传同源 `/cdn-cgi/rum`。按 [Cloudflare 官方说明](https://developers.cloudflare.com/web-analytics/about/)，该服务不收集或使用访问者个人数据；其他 Cloudflare 安全功能可能有独立的必要 Cookie/披露要求，应由站点隐私负责人核对。
- 初始脚本会在价格数据请求及分析 Beacon 执行前删除 `q`、未知/重复/非法查询参数和未知 fragment；搜索词最多 160 个 Unicode code point，只留在内存。URL 只保留规范的 `tier`、`sort`、`dir`、`region`。更早发出的样式/脚本等子资源请求由 meta Referrer Policy `origin` 保护，Referer 不包含路径或查询参数。
- 客户端无法清理首次文档请求：用户输入的原始 URL 仍可能被浏览器历史、代理、Cloudflare/GitHub Pages 和源站看到，因此不要把 Secret 或个人信息放进 URL。
- 前端不写 Cookie、sessionStorage 或 IndexedDB；localStorage 只保存通过 schema 3 验证的公共当前价格缓存。因为同一 origin 的其他页面可以写同一存储，网络失败时的缓存不能视为防篡改证据；若该边界不可接受，应使用独立 origin 或移除持久缓存。
- 所有动态数据使用 `textContent`、`createTextNode` 和 DOM API 渲染；不使用 `innerHTML`、`eval`、`document.write` 或字符串事件处理器。外链新窗口均带 `noopener noreferrer`。
- Cloudflare HTTP CSP 与 HTML meta CSP 必须保持一致。候选允许来源为：`script-src 'self' https://static.cloudflareinsights.com`、`connect-src 'self'`、`style-src 'self'`、`img-src 'self' data:`；`base-uri`、form/object/frame/worker/media/manifest 均为 `none`，HTTP header 另需 `frame-ancestors 'none'`。精确策略见 [OPERATIONS.md](OPERATIONS.md)。
- HTTP 层还应保持 `X-Content-Type-Options: nosniff`、frame deny、设备权限关闭、HSTS、最低 TLS 1.2，以及可验证的证书/DNS/跳转/404/缓存行为。具体基线见 [OPERATIONS.md](OPERATIONS.md)。
- 自有代码许可见 [LICENSE](LICENSE)；前端第三方资源许可全文见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 `vendor/manifest.json`。
