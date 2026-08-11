# iCloud+ 全球价格比较运维手册

本文面向项目所有者、发布操作员和事故响应人员。它描述当前生产架构、自动更新、监控、Secret、部署、回滚和故障处理。一次性的发布签字清单和终验报告由项目所有者内部留存，不放入公开仓库。

## 1. 服务边界与架构

生产页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

代码目录：`tools/icloud_price_comparison/`

主要数据流：

```text
Apple Support HTML ─┐
                    ├─ update workflow（只读生成/测试 job）
ExchangeRate-API ───┘        │
                             ├─ 完整 data/ 深验 + ustar 工件
                             │
                             └─ 独立 contents:write 发布 job
                                      │
                                      └─ main / GitHub Pages ─ Cloudflare ─ 浏览器
```

- 页面是静态 HTML/CSS/JavaScript，没有自建应用服务器或数据库。
- 当前价格、历史、成功运行日志和规范化 Apple 快照均在 `data/`；生产发布始终替换完整目录，不单独拼接 JSON。
- `data/prices.json` 是 schema 3 公共契约：只含当地价格、每个套餐的两位小数 `cnyPrice` 和 allowlist 汇率元数据，不含 raw FX rates、API Key 值或 API Key 配置/状态。
- `data/run-log.json` 仅保留最近 90 次成功运行，且同样不得公开 API Key 配置/状态。
- FX provenance 会公开本次成功使用的是认证 endpoint、开放 endpoint 或 stale 回退；它不公开 Key 值、失败/额度状态，但成功认证模式可能间接表明运行时存在可用凭据。若该元数据也被定义为敏感，需通过下一版 schema 迁移统一为供应商级来源。
- Cloudflare 提供 HTTPS、响应头、缓存和自动注入的 Web Analytics；仓库内不手工嵌入其 Beacon。前端另以延迟动态脚本启用 GA4（`G-K2S9L4CHNP`）。
- Apple、ExchangeRate-API、GitHub Actions/Pages、Cloudflare、DNS 注册商和可选 Healthchecks 都是外部依赖。仓库测试不能证明这些控制面的实时状态。

## 2. 角色与权限

上线前应明确指定下列角色；同一人可兼任，但批准记录必须可追溯。

| 角色 | 最低职责 |
| --- | --- |
| 项目所有者 | 接受发布结论、确定数据展示和更新策略、批准回滚 |
| 发布操作员 | 合并候选、执行 Cloudflare/DNS/GitHub 配置、完成部署后验收 |
| 法律/隐私审批人 | 审核 Apple 自动访问与内容展示、ExchangeRate-API 派生公开使用、隐私披露 |
| GitHub 管理员 | Ruleset、Actions 权限、Secret、Dependabot 和审计日志 |
| Cloudflare/DNS 管理员 | CSP/安全头、TLS、缓存、Web Analytics、DNSSEC、证书与跳转 |
| 当值响应人 | 每日失败、心跳缺失、数据异常、供应链和凭据事件处理 |

原则：

- 日常生成 job 只有 `contents: read`；只有不安装项目依赖的发布 job 可以 `contents: write`。
- 不向 fork PR 暴露 Secret，不在 `pull_request_target` 上运行候选代码。
- 生产分支禁止 force push；回滚使用 `git revert`，不改写历史。
- Cloudflare 和 GitHub 凭据使用最小权限、独立账号/应用和可撤销的短期凭据；不要共用个人全权限 Token。

## 3. 自动任务与预期结果

### 每日价格更新

工作流：`.github/workflows/update-icloud-prices.yml`

| 入口 | 时间（Asia/Shanghai） | 用途 |
| --- | --- | --- |
| Cloudflare 外部主触发 | 每日 08:05 | 通过 `workflow_dispatch`，`trigger_source=cloudflare` |
| GitHub cron 备用 | 每日 08:10 | 主触发未完成时兜底 |
| GitHub 手动触发 | 随时 | 人工验证或恢复；`main` 上手动运行不受每日幂等跳过 |

两个自动入口使用北京时间日期、`run-log.json` 和当前数据状态做幂等判断。自动任务在当天已有合格成功运行时跳过；手动运行仍可执行。

成功运行应满足：

1. 固定远端 `main` 生成基线。
2. 使用 Node.js 22、Corepack SHA-512 固定的 pnpm 10.14.0 和 frozen lockfile 安装；依赖生命周期脚本被禁用。
3. core 测试通过。
4. Apple 页面在共享 5 分钟网络预算内抓取并通过双路径解析/结构校验。
5. 汇率在线获取成功，或严格满足 36 小时回退条件。
6. `test:data` 和 runner Chrome UI 测试通过。
7. 完整 `data/` 通过语义验证后打包；发布 job 在展开前后再次验证。
8. 发布前确认远端 `main` 未前进，只在最后一步提交并推送完整 `data/`。

注意：由工作流内置 `GITHUB_TOKEN` 推送的数据提交不会再触发普通 `push` 验证工作流；因此每日工作流自身的 core/data/Chrome/工件验证是发布门禁。完整三浏览器验证由下述独立工作流覆盖。

### Apple 结构变化确认策略

这项门禁不是“每次更新都抓两遍”。每一份成功取得的 Apple HTML 都由 `document-order` 和 `apple-markers` 两个解析器共同解析；两条路径逐字段一致后，该次抓取才得到 `cross-checked` 结果。两个解析器不会各自发起网络请求。

| 第一次完整结果相对生产数据的变化 | Apple 网络抓取次数 | 处理方式 |
| --- | ---: | --- |
| 仅价格变化 | 1 次 | 继续正常校验和发布 |
| 仅币种变化 | 1 次 | 继续正常校验和发布 |
| 仅分区变化 | 1 次 | 继续正常校验和发布 |
| 仅 Apple 发布日期变化 | 1 次 | 继续正常校验和发布 |
| 地区新增或移除 | 2 次 | 执行独立、无缓存的完整确认抓取 |
| 容量新增或移除 | 2 次 | 执行独立、无缓存的完整确认抓取 |

第二次确认抓取同样由两个解析器共同解析，使用与主抓取相同的重试序列，并受同一个 5 分钟网络预算限制：

- 确认抓取因超时、连接重置、临时 5xx/CDN 等原因始终未取得完整响应：记录 `APPLE_CONFIRMATION_UNAVAILABLE`，按 transient 处理，不写生产数据；保留上一份稳定数据，等待下一次计划任务或人工重跑。
- 两次抓取均成功但发布日期、规范化内容 hash 或结构变化集合不一致：视为内容不稳定/完整性异常，按 severe 失败关闭。
- 不得复用第一次 HTML 冒充第二次独立确认，也不得把两个解析器误解为两次网络抓取。

确认不可用与确认不一致必须分开判断。前者允许通过后续运行自动恢复，但不能用第一次结果单独发布结构变化；后者需要检查 Apple 页面和解析器。不得部分合并新旧结构，因为这会破坏价格、历史、容量和快照之间的一致性。
### 完整只读验证

工作流：`.github/workflows/validate-icloud-price-comparison.yml`

- 相关 PR。
- 人工向 `main` 推送相关路径。
- 手动触发。
- 每周一北京时间 06:05。

它以 `contents: read` 运行 core、当前完整工件、全部 Apple 快照、Chromium、Firefox、WebKit 和 `pnpm audit`。

### Dependabot

- npm：每周一北京时间 08:20。
- GitHub Actions：每周一北京时间 08:30。
- 只有 `actions/*`、最多 20 个 workflow 文件、完整 SHA 一对一替换、精确 tested head/base，并且 SHA 与注释中的官方 semver tag 一致的 PR 可以自动合并。
- npm 依赖、第三方 Action、可变 tag、业务文件或额外 workflow 改动必须人工审核。

## 4. Secret 与凭据

### GitHub Actions Secret

| 名称 | 用途 | 处理要求 |
| --- | --- | --- |
| `EXCHANGE_RATE_API_KEY` | ExchangeRate-API 认证请求 | 只通过 `Authorization: Bearer` 发送到固定 HTTPS endpoint；不得放入 URL、JSON、附件或日志 |
| `ICLOUD_HEALTHCHECK_PING_URL` | 可选外部心跳 | 整个 URL 等同凭据；不得打印、提交、放入 Issue 或截图 |

`GITHUB_TOKEN` 由 GitHub 每次运行临时签发，不创建长期 Secret。发布 job 只在最终 push 步骤通过环境变量使用它，checkout 不保留凭据。

Cloudflare 08:05 主触发所使用的 GitHub 凭据/应用不在本仓库定义，必须在 Cloudflare 控制面单独盘点。只授予目标仓库和 workflow dispatch 所需权限，不要使用可写全部仓库的个人 Token。

### 轮换

至少在以下情况立即轮换：

- 人员离岗或权限变化。
- Secret 出现在日志、附件、Issue、浏览器包、shell history 或聊天记录。
- 第三方服务告警、异常调用、额度突变或 Token 来源不明。
- GitHub/Cloudflare/Healthchecks 账号被接管或 MFA 状态异常。

轮换顺序：先创建并验证新凭据，再替换生产 Secret，手动运行一次只读/更新验收，最后撤销旧凭据。若发生泄露，应先撤销旧凭据，不等待代码修复；随后删除可删除的日志/附件并按平台流程保留审计记录。

季度盘点：Secret 最后使用时间、持有人、权限范围、恢复联系人、MFA、备用管理员和第三方账单/额度。

## 5. 监控与告警

### 每日检查

建议在北京时间 08:45 前确认当天状态；这不是代码内 SLO，而是最低值守基线。

在 **Actions > Update iCloud prices** 检查：

- 最终结论和首个失败步骤。
- Apple parser 必须为 `cross-checked`；任何单路降级只作诊断并停止发布。
- 地区数、容量数和价格点是否符合预期；当前基线是 73 / 5 / 365，但合法上游变化可以改变它们。
- Apple Published Date 是否倒退、超前或异常跳变。
- 汇率来源、时间、是否 stale/fallback。
- 新增/移除地区、容量、币种和价格变化。
- 发布 job 是否因远端 `main` 前进而安全停止。
- 容量摘要是否接近 Git 500/800 MiB 或 `history.json` 2 MiB 阈值。

### Healthchecks 语义

- `/0`：完整成功，或幂等跳过。
- `/1`：数据/测试/工件严重失败，或解析器降级等严重状态。
- 单次被分类为 transient 的网络故障不立即发送 `/1`；依靠连续缺失成功心跳的 Grace Time 告警。

推荐将 Healthchecks 周期设为 24 小时，并给主/备触发、重试和发布留至少 45–60 分钟 Grace Time。具体值必须由值守负责人确认，避免一次临时网络抖动误报，同时确保连续一天无成功更新会告警。

### 浏览器与生产监控

至少每周和每次发布后验证：

- 主页面、`prices.json`、`history.json`、核心 JS/CSS 和真实不存在路径。
- 无页面异常、CSP violation、水平溢出或加载死锁。
- GA4 在主内容初始化后只加载一次，测量 ID 为 `G-K2S9L4CHNP`；其 `page_location` 不得包含 `q`、未知参数或未知 fragment，Google Signals 与广告个性化信号保持关闭。
- Cloudflare Beacon 可加载，`/cdn-cgi/rum` 正常响应；不要因此放宽到任意第三方 `connect-src`。
- 数据生成时间不超过 36 小时；页面会标记旧数据，但监控不能只依赖用户发现。
- 浏览器应拒绝 data redirect、非法 UTF-8，以及超过 1 MiB 的 prices / 8 MiB 的 history；8 秒超时必须覆盖完整正文读取。

推荐恢复目标（需所有者正式批准）：

- 静态页面故障 RTO：60 分钟内恢复上一已知良好版本。
- 错误数据 RPO：回到上一成功数据提交；正常情况下最多损失一个每日更新周期。
- 法律/隐私/凭据事故：立即停止自动发布或撤下相关功能，不等待常规 RTO。

## 6. Cloudflare、TLS、DNS 与响应头基线

这些配置不在 Git 中，发布操作员必须在控制面逐项确认。规则应只作用于本工具路径，避免与主站其他页面的策略互相污染。

### 路径级 CSP

候选页面的预期 HTTP CSP：

```text
default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'; script-src 'self' https://www.googletagmanager.com https://static.cloudflareinsights.com; style-src 'self'; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com; font-src 'self'
```

- Google 只允许 GA4 所需的 Tag Manager 脚本域名与 Analytics 采集域名；仍不允许 `unsafe-inline`、`unsafe-eval`、通配脚本源或任意第三方连接。
- Cloudflare 自动 Web Analytics script 来自 `static.cloudflareinsights.com`；其采集请求使用同源 `/cdn-cgi/rum`。GA4 连接/像素仅允许 `*.google-analytics.com`、`*.analytics.google.com` 与 `www.googletagmanager.com`。
- HTML meta CSP 与 HTTP CSP 同时生效，实际策略取交集；但 `frame-ancestors` 只能依赖 HTTP header。
- 若关闭 Cloudflare Web Analytics，应同步删除 `static.cloudflareinsights.com`，而不是保留无用白名单。

### 其他响应头

本工具 HTML 至少应返回：

```text
Referrer-Policy: origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

要求：

- HTTP 永久跳转到同一路径 HTTPS，不经过额外明文跳转。
- Cloudflare zone Minimum TLS Version 至少为 TLS 1.2；TLS 1.0/1.1 握手必须失败。
- TLS 1.2/1.3、证书主机名、完整链、到期日和 IPv4/IPv6 均正常。
- `linchun.com.cn` 的 DNSSEC 不仅要有 Cloudflare DNSKEY，父区还必须发布匹配 DS；只有完整信任链才算启用。
- HSTS preload 状态要持续跟踪；提交后 `pending` 不代表已经进入浏览器列表。
- CAA 可作为额外限制，但未配置不是本项目单独的发布阻断；如添加，必须覆盖实际证书颁发机构和备援方案。

### 缓存

当前运维目标：HTML/JSON 最长约 10 分钟，带版本号静态资源约 30 分钟。修改 JS/CSS/数据契约时必须同步提升 HTML 中 query version。部署后可按工具路径定向 purge；不要全站清缓存，除非事故范围确实是全站。

Cloudflare 可能自动修改 HTML 注入 Beacon，因此 HTML 响应字节 hash 不一定与仓库文件相同。JS、CSS、vendor 和 JSON 不应被改写，可直接比较 SHA-256；HTML 应同时检查候选资源版本、CSP、页脚和脚本列表。

## 7. 标准发布流程

1. 冻结候选分支和 commit，记录基线 SHA；确认工作树中没有临时日志、截图、浏览器、下载包或 Secret。
2. 取得法律/隐私、项目所有者、GitHub 管理员和 Cloudflare 管理员批准。
3. 在 Node.js 22 和 pnpm 10.14.0 的全新目录执行 frozen clean install 与完整测试；Linux CI 必须成功，不能用 Windows 上跳过的 POSIX 权限用例代替。
4. 审核完整 diff、Action SHA、lockfile integrity、vendor hash/notice、gitleaks、Unicode/bidi、文件 mode 和文档链接。
5. 确认 GitHub ruleset/required checks 与自动数据发布方案兼容。
6. 在 Cloudflare 先准备路径级 CSP、Referrer Policy、TLS 1.2 和缓存规则；配置变更保留导出或截图，以便回滚。
7. 通过正常 PR/合并流程发布代码；不要直接在生产分支手工编辑 JSON。
8. 等 GitHub Pages 与 Cloudflare 缓存收敛，必要时定向 purge 工具路径。
9. 按项目所有者内部发布清单完成部署后验收并保存结果；不要把 Secret、私密法律意见或内部签字记录提交到仓库。
10. 观察至少一次每日主/备更新和下一次完整只读验证；确认告警和发布语义正常后关闭发布窗口。

## 8. 部署后验收命令

以下示例仅做快速检查，不能替代三浏览器和网络录制：

```bash
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/not-a-real-file-<随机值>
curl -fsSL https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json > production-prices.json
sha256sum script.js style.css data/prices.json
```

浏览器使用新建 profile/上下文，打开带隐私标记的 URL，例如：

```text
https://www.linchun.com.cn/tools/icloud_price_comparison/?q=privateSearchMarker&privateToken=unknownMarker&tier=200GB
```

确认：

- 地址栏最终只保留允许的状态键；搜索词仍应用到本地筛选但不留在 URL。
- 任一子资源 Referer 不包含两个标记；Referrer 最多为 origin。
- Network 中有且只有获批的 `www.googletagmanager.com/gtag/js?id=G-K2S9L4CHNP`、GA4 采集端点、Cloudflare Beacon 与同源 `/cdn-cgi/rum`；不得出现其他第三方分析域名。
- GA4 配置队列只有一条该测量 ID 的 `config`，其 `page_location` 是清洗后的 URL，且 `allow_google_signals`、`allow_ad_personalization_signals` 都为 `false`。
- 应用自身不写 Cookie、sessionStorage/IndexedDB；GA4 可能写 `_ga` 系列 Cookie，验收时检查其来源和数量，不把正常 GA4 Cookie 误判为应用数据泄漏。
- 控制台无应用 error/CSP violation；对话框、键盘、缓存回退和错误态正常。
- 生产 JSON 是 schema 3，且 `prices.json`、`run-log.json` 都不含 raw rates 或 API Key 状态。

隐私边界：bootstrap 只能在 HTML 开始执行后清理地址。最初的 document URL 仍可能进入浏览器历史、代理、Cloudflare/GitHub Pages 和访问日志；任何 Secret、Token 或个人信息都不得放进 URL。`localStorage` 也不是防篡改存储：同一 origin 的其他页面可写入格式合法但内容伪造的缓存。工具只在网络失败时使用并明确标记该缓存；高隔离要求应使用独立 origin 或禁用持久缓存。

GA4 可能使用域级 `_ga` Cookie，主站其他 GA 页面也可能复用该 Cookie。本工具的隐私边界是：站内搜索词和未知 URL 状态不得进入 GA4 的 `page_location` 或后续 Referer；若业务要求完全无 Cookie 或与主站分析身份隔离，应改用独立 origin 或另行设计同意/无 Cookie 方案。

## 9. 故障处理 Runbook

### 9.1 Apple 抓取或解析失败

症状：Apple fetch 超时/超限、发布日期无效、parser 分歧、地区/容量结构变化无法二次确认。

处理：

1. 不手工发布未校验数据；上一份有效数据继续服务。
2. 下载 `icloud-price-diagnostics-*`，只检查 `run-report.json` 和规范化 `apple-snapshot.json`。
3. 在浏览器人工确认 Apple 官方页面是否可访问、是否改版、是否出现区域/挑战页。
4. 用合法取得的测试 HTML 更新 fixture，在隔离分支同时修复两条关联路径；不要把原始 Apple HTML 提交到仓库或 Actions 附件。
5. 运行 core、live dry-run、artifact、snapshots 和三浏览器测试。
6. 若 Apple 条款/许可发生变化，立即停止自动抓取并走 9.7。

### 9.2 汇率故障或额度耗尽

症状：认证接口失败后使用开放接口；两个在线源均失败；页面显示 stale 汇率。

处理：

1. 检查 Action notice、供应商状态/额度和 Secret 最后更新时间；不要在日志打印 Key。
2. 开放接口成功属于预期降级；确认 attribution 和供应商许可仍有效。
3. 两源失败时仅允许复用 36 小时内、币种/当地价格完全兼容的派生 CNY；任何新增币种、换币种或当地价格变化都会失败关闭。
4. 超过 36 小时或生产币种不完整时，不绕过验证。恢复服务、轮换 Key 或等待供应商恢复后重跑。
5. 如果供应商撤销公开派生用途许可，停止人民币换算发布并走 9.7。

### 9.3 数据、快照或 artifact 损坏

症状：跨文件不一致、hash 不符、unexpected/missing file、tar traversal/link/mode 拒绝。

处理：

1. 禁用或暂停更新 workflow，防止新的自动尝试干扰取证。
2. 保存失败 run URL、commit SHA 和工件 hash；不要展开被拒绝的未知 tar 到生产目录。
3. 找到上一已知良好的完整数据提交，运行 `pnpm validate:artifact` 和 `pnpm validate:snapshots`。
4. 使用 `git revert <bad-data-commit>` 回滚完整 `data/`；不要手工删除快照或拼接 `history.json`。
5. 生产验收后再恢复 workflow，并手动执行一次更新。

### 9.4 更新事务中断或锁残留

- 生产写入使用 `.icloud-price-update-transaction.json`；下次非 dry-run 会先恢复未完成事务。
- 归档导入使用 `.apple-archive-import-transaction.json`，同样先恢复。
- 更新锁 30 分钟后只有在进程已不存活且安全 claim 成功时才回收。
- 不要手工删除新鲜锁或事务文件。先确认没有运行中的进程；优先让同版本程序自动恢复，再用测试验证结果。

### 9.5 远端 `main` 竞态或发布 push 失败

发布 job 在生成后和最终 push 前都比较精确基线。远端前进时失败关闭是正确行为：

1. 不 rebase 已生成工件，不 force push。
2. 检查并合并/等待占用 `main` 的变更。
3. 从新 `main` 重新运行完整更新；旧工件不得复用。

### 9.6 前端、CSP、缓存或隐私回归

症状：白屏、资源被 CSP 拦截、旧 JS/新 HTML 混用、GA4 缺失/重复/测量 ID 错误、未批准第三方请求、查询标记进入 GA4 或 Referer。

1. 立即保存 HAR/console、响应头和受影响资源版本；使用干净 profile 复现。
2. 若是 CDN 规则漂移，恢复最后已知良好的路径级规则并定向 purge。
3. 若是代码回归，执行第 10 节回滚，不临时加入 `unsafe-inline`、`unsafe-eval` 或通配域名。
4. 若发现分析/查询数据泄漏，按隐私事故处理：停止相关脚本、评估范围、保留审计记录并通知隐私负责人。

### 9.7 法律、许可或下架通知

1. 立即通知项目所有者和法律审批人，不自行解释对方条款。
2. 必要时禁用每日更新、撤下派生人民币或整个工具，先控制持续访问/发布。
3. 保存通知原文、时间、来源和采取措施；不要在公开 Issue 粘贴保密往来。
4. 只有取得书面许可或法律批准的新方案后才恢复。

### 9.8 依赖、Action 或 vendor 供应链事件

1. 停止 Dependabot 自动合并和相关发布。
2. 固定受影响版本/SHA，核对上游安全公告、tag 与 commit 所有权。
3. 重新下载 vendor 上游包，运行 `pnpm test:vendor` 比较精确字节/icon node/hash/notice。
4. 在全新目录重新安装 frozen lockfile，运行 gitleaks、audit、core、artifact、snapshots 和三浏览器。
5. 若无法证明来源和完整性，保持停更并回滚到最后已知良好版本。

## 10. 回滚

### 代码回滚

```bash
git checkout main
git pull --ff-only origin main
git revert <引入问题的合并或提交 SHA>
git push origin main
```

### 数据回滚

1. 先暂停自动更新。
2. 找到包含完整已知良好 `data/` 的提交。
3. 对坏数据提交执行 `git revert`；不要只 checkout `prices.json`。
4. 在推送前运行 `pnpm validate:artifact`、`pnpm test:data`、`pnpm validate:snapshots` 和 UI 验收。
5. 推送后定向 purge，核对 JSON hash/时间/历史，并恢复 workflow。

### Cloudflare/DNS 回滚

- 使用发布前保存的规则导出/截图恢复 CSP、Referrer Policy、缓存和 Transform Rule。
- TLS 最低版本不得回退到 1.0/1.1；若兼容问题必须由安全负责人书面批准临时例外。
- DNSSEC DS 变更错误可能导致全域解析失败。先按 Cloudflare/注册商正式流程恢复匹配 DS，不随意删除 DNSKEY。

回滚完成后仍需执行部署后清单；“页面可打开”不足以证明数据、隐私和安全已恢复。

## 11. 保留与仓库卫生

- `run-log.json`：最近 90 次成功运行。
- 诊断 artifact：14 天；只读数据 tar：1 天。
- Apple 原始 HTML：不入库、不上传 Actions artifact。
- 规范化 Apple JSON 快照：作为价格历史证据保留；同日修订不覆盖。
- 临时测试浏览器、截图、日志、下载包、本地审计工具、一次性发布清单和终验报告放在 ignored `artifacts/`，不得提交。
- 公开仓库不保留面向特定 AI/代理的 `AGENTS.md`；长期有效的维护规则统一写入本运维手册，避免内部代理指令和公开项目文档重复或冲突。
- 本项目允许跟踪的 Markdown 仅为 `README.md`、`OPERATIONS.md`、`THIRD_PARTY_NOTICES.md` 和 `data/apple-snapshots/README.md`，并由 core 测试校验。新增 Markdown 必须先证明属于长期维护的用户、运维、公共数据格式、贡献或许可说明，并同步调整允许列表。
- 聊天交接、临时状态、内部签字、TODO 草稿、截图说明、测试输出、故障取证、一次性发布清单和终验/审计报告不得进入公开仓库；需要本地保存时放入 ignored `artifacts/`，不得用 `git add -f` 绕过。
- 页面底部固定为“本工具与 Apple Inc. 无关联，数据仅供参考。”；不要恢复访问统计说明，也不要扩写为复杂的 Apple 商标、授权、赞助或认可声明，除非项目所有者明确提出新文案。
- 修改或删除文档时必须同步清理 README、运维手册、workflow、测试和代码中的链接或引用。
- Git 历史超过 500 MiB 开始人工评估，800 MiB 升级告警；不要由 workflow 自动重写历史。
- `history.json` 2 MiB 是提前人工评估阈值，不是浏览器 8 MiB 硬上限；达到预警后应在接近客户端上限前设计分片/归档并保持旧 URL 的兼容或明确迁移。
- 每次发布检查大文件、秘密、Unicode bidi、文件 mode、case collision、混合换行和 `git fsck --strict`。

## 12. 定期演练

至少每季度执行并记录：

- 从上一数据提交回滚并恢复的桌面演练。
- Secret 轮换与 Cloudflare dispatch 手动验证。
- Healthchecks 成功、严重失败和缺失心跳三种路径。
- TLS 1.0/1.1 拒绝、DNSSEC DS 链、证书到期和 HSTS preload 状态。
- 干净浏览器隐私检查、三浏览器 UI、窄屏和键盘流程。
- Apple/FX 许可联系人和书面批准仍有效。
