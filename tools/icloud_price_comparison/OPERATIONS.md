# iCloud+ 全球价格比较运维手册

本文面向项目所有者、发布操作员和事故响应人员，记录当前生产架构、自动任务、监控、Secret、Cloudflare、部署、回滚和故障处理。一次性的发布清单、审计记录和终验报告由项目所有者内部留存，不进入公开仓库。

生产页面：<https://www.linchun.com.cn/tools/icloud_price_comparison/>

代码目录：`tools/icloud_price_comparison/`

## 1. 服务边界与事实源

```text
Apple Support HTML ─┐
                    ├─ update workflow（只读生成/测试 job）
ExchangeRate-API ───┘        │
                             ├─ 完整 data/ 深验 + 静态页面投影
                             └─ 独立 contents:write 发布 job
                                      │
                                      └─ main / GitHub Pages → Cloudflare → 浏览器
```

- 页面为静态 HTML/CSS/JavaScript，没有自建应用服务器或数据库。
- `data/prices.json` 是当前价格的唯一事实源；公共契约为 schema 4。
- `data/history.json` 保存以稳定 `marketId` 为键的价格、币种和 Apple 发布日期事件。
- `data/run-log.json` 只保留最近 90 次成功运行，不公开 API Key 配置或状态。
- `data/apple-snapshots/` 保存规范化 Apple JSON 证据，不保存原始 Apple HTML。
- `index.html` 的静态价格区域、状态信息及容量相关 SEO 文案是 `prices.json` 的确定性投影，不是第二套价格事实源。
- Apple 英文 108047 是 active market、价格、币种、容量和 `Published Date` 的事实源；Apple 简体中文 108047 只用于已复核的中文市场名称。
- ExchangeRate-API 只参与人民币参考价生成；公共 JSON 不发布 raw FX rates 或内部全精度换算值。

仓库测试可以证明代码和已提交工件的契约，但不能证明 GitHub、Cloudflare、DNS、外部触发器或第三方服务控制面的实时状态。

## 2. 产品与数据不可变约束

维护和事故处理不得绕过以下长期约束：

- schema 4 与稳定 `marketId`。
- 欧元区中文名称保持“欧盟”。中文名称尚未确认时使用 Apple 英文 source name，不机器翻译。
- 未登记 Apple 市场生成确定性 `apple-*` ID；完成正常 Apple 语义确认且无 ID 冲突后允许发布。
- 已发布或历史出现过的市场 ID 永久 reserved，不因市场移除而重新分配。
- 不做模糊 market rename 自动绑定；只有严格高置信 identity ambiguity 才要求维护者显式增加 alias。
- 默认 200GB 人民币参考价升序；200GB 不存在时使用当前 tier 列表首项作为默认容量。
- 最低价提示由生成器 `cnyRank === 1` 决定，不以显示后的两位小数重新排名。
- 当前价格不写入浏览器持久存储；静态 HTML 是无 JavaScript/网络失败时的正式 fallback。
- URL 只保留规范的 `tier`、`sort`、`dir`、`region`；搜索词与未知状态不持久化到 URL。

## 3. 角色与权限

| 角色 | 最低职责 |
| --- | --- |
| 项目所有者 | 确定产品/数据策略、接受发布结论、批准回滚 |
| 发布操作员 | 合并候选、执行外部配置、完成部署后验收 |
| 隐私/合规负责人 | 审核隐私披露和数据处理边界；处理未来收到的外部规则变更、投诉或下架通知 |
| GitHub 管理员 | Ruleset、Actions 权限、Secret、Dependabot 和审计日志 |
| Cloudflare/DNS 管理员 | CSP、安全头、TLS、缓存、Web Analytics、DNSSEC、证书与跳转 |
| 当值响应人 | 每日失败、心跳缺失、数据异常、供应链和凭据事件处理 |

原则：

- 生成/测试 job 默认 `contents: read`；只有依赖隔离的最终发布 job 可以 `contents: write`。
- 不向 fork PR 暴露 Secret，不在 `pull_request_target` 上运行候选代码。
- 生产分支不 force push；代码和数据回滚使用 `git revert`。
- GitHub、Cloudflare 和第三方凭据使用最小权限、可撤销身份，不共用个人全权限 Token。

## 4. 自动任务

### 每日价格更新

工作流：`.github/workflows/update-icloud-prices.yml`

| 入口 | 时间（Asia/Shanghai） | 语义 |
| --- | --- | --- |
| Cloudflare 外部主触发 | 每日 08:05 | `workflow_dispatch` + `trigger_source=cloudflare` |
| GitHub cron 备用 | 每日 08:10 | 主触发未形成合格成功结果时兜底 |
| GitHub 手动触发 | 随时 | 人工验证或恢复；`main` 上不受每日幂等跳过 |

两个自动入口使用北京时间、`run-log.json` 和当前数据状态做每日幂等判断。stale 汇率、未来时间或不完整成功记录都不能阻止备用任务重试。

注意：Cloudflare 外部触发使用的 GitHub 身份和凭据不在仓库定义。当前 `trigger_source` 是 caller 声明，不应被当作认证边界。外部凭据必须保持最小权限并独立轮换。

### 完整只读验证

工作流：`.github/workflows/validate-icloud-price-comparison.yml`

触发范围：相关 PR、人工向 `main` 推送相关路径、手动触发、每周计划任务。

它以只读权限运行：

- `pnpm test:core`
- 当前完整 data artifact 验证
- 全部 Apple snapshots 深验
- Chromium / Firefox / WebKit UI 验收
- `pnpm audit --audit-level low`
- `git diff --check`

每日更新由内置 `GITHUB_TOKEN` 推送的数据提交不会再触发普通 push 验证，因此每日 workflow 自身的 core/data/runner Chrome/工件验证就是自动数据发布门禁。

### Dependabot 与依赖自动合并

- npm：每周一北京时间 10:20 检查；GitHub Actions：每周一 12:20 检查。两个窗口都放在每日价格更新之后，并彼此错开，尽量避免多个自动任务同时推进 `main`。
- npm 的常规 version update 将全部 patch/minor 更新合并为一个 routine PR，major 保持单独 PR；安全更新不受该 version group 限制。routine PR、直接依赖的向前 patch/minor 更新，以及不改变 `package.json` 语义的 lockfile-only 传递依赖更新，都必须先完整通过 core、artifact、全部 snapshots、`pnpm audit` 和 Chromium / Firefox / WebKit 验收。
- 完整验证成功后，可信默认分支上的自动合并器再次确认：作者必须是 `dependabot[bot]`、分支属于本仓库、base/head SHA 与刚通过测试的精确提交一致；文件范围只能是单独 `pnpm-lock.yaml`，或 `package.json` + `pnpm-lock.yaml`。若 `package.json` 发生变化，依赖名称不得新增/删除，除现有依赖精确版本 pin 外其他字段必须完全不变，所有版本只能向前做 patch/minor 更新；若仅 lockfile 变化，则 base/head 的 `package.json` 必须完全一致。全部满足才 squash merge 精确 head SHA。
- npm major 更新、依赖新增/删除、版本范围、`packageManager` / scripts / 业务文件变化，或任意额外文件改动都不会自动合并，必须人工审核。
- Lucide 的实际版本只在 `package.json` / `pnpm-lock.yaml` 固定，不再在 vendor manifest 和 notice 重复维护版本字符串。vendor manifest 仍固定本地 subset 的文件名、包名、许可证和 SHA-256；CI 会验证实际安装包的 version/license，并把页面实际使用的每个 Lucide icon node 与当前 package pin 逐个深度比较。若上游修改许可证元数据或任一已使用图标，自动升级会自然失败关闭，直到人工复核并在需要时更新 subset/hash/notice。
- 官方 `actions/*` 仍走更严格的供应链路径：只允许 workflow 中完整 SHA 一对一替换，自动合并器还会解析对应 release tag 并确认 tag 最终指向被 pin 的精确 commit。第三方 Action、可变 tag 或附带业务改动不会自动合并。
- 自动合并 workflow 使用 `workflow_run`，有写权限的 job 只执行默认分支中的可信校验器，不执行 Dependabot PR 自带脚本，也不使用 `pull_request_target`。

## 5. 生产更新顺序

一次完整生产更新应满足：

1. 固定远端 `main` 生成基线，使用 Node.js 22、项目锁定的 pnpm 与 frozen lockfile 安装依赖，生命周期脚本禁用。
2. 运行 core 测试。
3. 在共享网络预算内抓取 Apple 页面；同一份 HTML 必须由 `document-order` 和 `apple-markers` 两条解析路径逐字段一致后才得到 `cross-checked`。
4. Apple 业务语义发生变化时，执行独立 no-store 完整确认抓取。正常情况是 initial + confirmation；只有 mismatch 或确认解析退化时追加第三样本。
5. 只有稳定、完整的 Apple 语义证据才能继续。A/B/B 或 A/degraded/A 可自动恢复；A/B/A、A/B/C、无法形成稳定证据或确认始终不可用时保留上一份生产数据，等待后续自动重试。
6. 获取并校验汇率。认证候选不可用或 sanity 不通过时尝试开放候选；所有 fresh 在线候选均不可用时，仅允许在既定 freshness 条件内沿用上一份安全 FX/CNY 结果。
7. 事务式生成 prices/history/run-log/Apple snapshots，并执行数据、时间、价格异常、market identity 和跨文件校验。
8. 从已验证 `prices.json` 生成 `index.html` 的静态价格、状态和容量相关 SEO 投影，并执行页面验收。
9. 深验完整 `data/`，将数据与静态首页作为同一受控发布工件上传。
10. 独立发布 job 解包后再次验证工件、静态投影、首页生成边界和远端基线；只有远端 `main` 未前进时才提交并推送。

远端基线变化时必须重新生成，不 rebase 已生成工件，不 force push。

## 6. Market identity 与中文名称

- `scripts/market-registry.mjs` 保存永久 `marketId`、Apple 英文 canonical name 和 aliases。
- `scripts/country-names.zh.json` 是 Apple 简体中文名称唯一事实源：字符串表示 approved，`null` 表示 pending。
- pending 名称继续显示 Apple 英文 `sourceName`，并记录非阻断 `CHINESE_MARKET_NAME_PENDING`。
- unknown Apple market 完成正常语义确认后使用 deterministic ID generator；发布后 prices/history ledger 优先于当前生成器。
- 新 identity 如果撞到 registry 或任一历史 reserved ID，以 `MARKET_IDENTITY_RESERVED_ID_COLLISION` 失败关闭，不随机换 ID。
- 只有 removed 与 added unknown 双向唯一，并且 region、currency、canonical tier set 和完整当地价格向量完全相同，才作为高置信 rename ambiguity 停止并要求显式 alias。
- repricing、多个候选或其他弱信号只记录 `MARKET_IDENTITY_RENAME_SUSPECTED`，不得自动绑定旧 ID。

长期边界由独立 `test/market-registry.test.mjs` 保护，不依赖历史 schema 迁移代码。

## 7. Freshness、异常和 fallback

- 浏览器接受当前网络价格的硬上限为 7 天，允许最多 5 分钟未来偏差。
- 36 小时以内为正常可用窗口；36 小时至 7 天标记旧数据并只作历史参考。
- `fx.stale` 或价格过期时隐藏最低价排名提示。
- 同币种单项当地价格超过旧价 10 倍或低于旧价 1/10 时拒绝；跨币种按既定换算硬边界验证。
- 当前市场相对 CNY 中位数超过 20 倍或低于 1/20 时拒绝。
- Apple 已确认且仍在硬边界内的当地大幅变价可以 warning 后继续；FX-only CNY 异常只能按 FX authority 分类，不能声称由 Apple 确认。
- 显著换币种变化缺少可靠新币种 FX baseline 时要求 review。
- Apple HTML、FX JSON、浏览器 prices/history 都有大小、redirect、UTF-8 和超时边界；不要在故障时放宽这些限制。

## 8. Secret 与凭据

| 名称 | 用途 | 要求 |
| --- | --- | --- |
| `EXCHANGE_RATE_API_KEY` | ExchangeRate-API 认证请求 | 只通过 `Authorization: Bearer` 发送到固定 HTTPS endpoint；不得进入 URL、公共 JSON、附件或日志 |
| `ICLOUD_HEALTHCHECK_PING_URL` | 可选外部心跳 | 整个 URL 等同凭据；不得打印、提交、放入 Issue 或截图 |

`GITHUB_TOKEN` 由 GitHub 每次运行临时签发，不创建长期 Secret。发布 checkout 不保留凭据，只在最终 push 所需步骤使用写权限。

立即轮换的情形包括：人员权限变化、Secret 出现在日志/附件/聊天/浏览器包、第三方异常调用、账号接管、MFA 异常或 Token 来源不明。

轮换原则：新凭据先以最小权限验证，再替换生产 Secret，最后撤销旧凭据；已发生泄露时先撤销旧凭据，不等待代码修复。

## 9. 监控与告警

### 每日检查

建议在自动任务结束后确认：

- 最终结论和首个失败步骤。
- Apple parser 状态必须为 `cross-checked`。
- 地区、容量、价格点数量是否与当前 `prices.json` 相符；合法上游变化可以改变数量，不把历史数量当永久常量。
- Apple `Published Date` 是否倒退、未来或异常跳变。
- 汇率来源、时间和 stale/fallback 状态。
- 新增/移除地区、容量、币种和价格变化。
- 发布 job 是否因远端 `main` 前进而安全停止。

### Healthchecks

- `/0`：完整成功，或已经通过完整 production proof 的幂等跳过。
- `/1`：数据/测试/工件严重失败、解析器降级或 production proof 失败。
- 单次 transient 网络故障不立即发送 `/1`，依靠 Grace Time 识别连续缺失成功心跳。

### 浏览器与生产

至少每周和每次代码发布后检查：

- 主页面、prices/history/run-log、核心 JS/CSS、社交分享图和真实 404。
- 无应用 error、CSP violation、水平溢出或加载死锁。
- GA4 只加载一次，测量 ID 为 `G-K2S9L4CHNP`，`page_location` 不含 `q`、未知参数或未知 fragment。
- Cloudflare Web Analytics Beacon 正常，且没有新增未批准第三方分析域名。
- 页面静态价格、网络价格与数据更新时间一致。

## 10. Cloudflare、CSP、TLS、DNS 与缓存

这些配置不完全存储在 Git 中，发布操作员需要在控制面确认。

路径级 CSP 基线：

```text
default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; worker-src 'none'; media-src 'none'; manifest-src 'none'; script-src 'self' https://www.googletagmanager.com https://static.cloudflareinsights.com; style-src 'self'; connect-src 'self' https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; img-src 'self' data: https://*.google-analytics.com https://www.googletagmanager.com; font-src 'self'
```

HTML meta CSP 与 HTTP CSP 应保持同一最小边界；`frame-ancestors` 只能依赖 HTTP header。

HTML 至少保持：

```text
Referrer-Policy: origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```

同时验证：HTTP→HTTPS、最低 TLS 1.2、证书链、DNS、DNSSEC 信任链和真实 404 行为。

缓存目标：HTML/JSON 只允许短缓存；带内容哈希版本的浏览器静态资源可更长。修改 JS/CSS/数据契约后必须使用 `pnpm assets:update` / `pnpm assets:check`，不要手填资源 query version。

Production verifier 使用 no-store 获取 prices/history/run-log/首页，并以完整数据契约、字节 hash 和静态投影证明部署结果。Cloudflare 可注入 Web Analytics，从而改变 HTML 响应字节，因此 HTML 重点验证语义、资源版本、CSP、页脚和生成区域，而不是强求整页字节 hash。

### 社交分享图与缓存

`og-image.png` 只用于 Open Graph / Twitter metadata，不在页面正文显示。普通页面刷新不会让用户在页面里看到它。

当前 metadata 使用固定资源 URL，因此第三方社交平台可能继续使用自己的旧缓存。若以后**改变分享图视觉内容**并要求平台重新抓取，应同时切换到新的稳定图片 URL（例如新文件名），再验证：

- `og:image` 与 `twitter:image` 一致；
- PNG signature 正确；
- 尺寸 1200×630；
- 页面 metadata 和新图片已经部署；
- 必要时只 purge 工具路径相关 CDN 缓存，不全站 purge。

不要把“浏览器强制刷新能看到新文件”当作社交平台已经重新抓取的证明。

## 11. 标准发布流程

1. 从最新 `main` 建候选分支并记录 BASE SHA；确认没有临时日志、截图、浏览器、下载包或 Secret。
2. 按变更范围取得必要批准。只有当隐私边界、外部规则或控制面配置发生变化时，才要求相应负责人重新复核；普通代码/文档维护不重复制造无关发布门禁。
3. 在 Node.js 22 和 pnpm 10.14.0 环境使用 frozen clean install，运行与改动匹配的完整验证。
4. 审核 diff、Action SHA、lockfile integrity、vendor hash/notice、秘密泄漏、Unicode/bidi、文件 mode 和文档链接。
5. 确认 GitHub ruleset/required checks 与发布方式兼容。
6. 需要时更新 Cloudflare 路径级 CSP、Referrer Policy、缓存或 TLS 配置，并保留可回滚记录。
7. 通过正常 PR 合并；不要直接在 `main` 手工编辑生产 JSON。
8. 等待 GitHub Pages 部署完成；必要时定向 purge 工具路径。
9. 完成部署后验收并保存内部结果。
10. 对结构性改动观察后续自动更新；纯文档变更无需人为制造价格更新任务。

## 12. 部署后快速验收

```bash
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/data/prices.json
curl -fsSIL https://www.linchun.com.cn/tools/icloud_price_comparison/not-a-real-file-<随机值>
```

浏览器使用干净 profile 验证：

- URL 清理后只保留规范状态键；搜索词仍在内存筛选但不留 URL。
- 子资源 Referer 最多为 origin，不含私密 query 标记。
- GA4 / Cloudflare Analytics 域名和次数符合预期。
- 应用自身不写 Cookie、localStorage、sessionStorage、IndexedDB 或 Service Worker。
- 控制台无应用 error/CSP violation。
- schema 4 数据、静态 fallback、历史、排序、筛选、键盘和窄屏正常。

最初 document URL 在脚本执行前仍可能进入浏览器历史、代理、Cloudflare/GitHub Pages 和访问日志，因此任何 Secret、Token 或个人信息都不得放入 URL。

## 13. 故障处理

### Apple 抓取、解析或确认失败

1. 不发布单路解析或未确认数据；上一份有效数据继续服务。
2. 检查 `icloud-price-diagnostics-*` 中的结构化报告和规范化 snapshot，不把原始 Apple HTML 上传到公开仓库或 Actions artifact。
3. 人工确认 Apple 页面是否可访问、是否改版或返回挑战页。
4. 用合法测试 fixture 修复两条解析路径并运行 core、live dry-run、artifact、snapshots 和三浏览器。
5. 若未来收到明确的上游使用限制、合规或下架通知，停止相关自动访问并按“合规或下架通知”流程处理。

### 汇率失败或 stale

1. 检查 Action notice、服务状态、额度和 Secret，绝不打印 Key。
2. 认证来源失败后开放来源成功属于预期自动降级。
3. 两个 fresh 在线来源均失败时，只允许既定 freshness 窗口内且与当前市场/币种结构兼容的 previous FX/CNY fallback。
4. 超过窗口或 required currency 不完整时，不绕过验证；恢复服务、轮换凭据或等待后续自动任务。
5. 若未来收到明确要求停止相关公开用途或下架的通知，停止受影响的人民币换算发布并按“合规或下架通知”流程处理。

### 数据、快照或 artifact 损坏

1. 暂停自动更新，保存失败 run、commit SHA 和工件 hash。
2. 找到上一完整已知良好数据提交并运行 artifact/snapshot 验证。
3. 使用 `git revert <bad-data-commit>` 回滚完整数据提交，不手拼单个 JSON。
4. 生产验收后恢复 workflow，并在需要时人工触发一次正常更新。

### 更新事务中断或锁残留

- 生产更新和历史导入都有持久事务记录；下次正常运行优先自动恢复。
- 不手工删除新鲜锁或事务文件；先确认没有活跃进程。
- 只有满足实现中的 stale-lock 安全条件时才允许回收。

### 远端 `main` 竞态

1. 不 rebase 已生成工件，不 force push。
2. 确认占用 `main` 的新提交。
3. 从新 `main` 重新运行完整更新；旧工件不得复用。

### 前端、CSP、缓存或隐私回归

1. 保存 HAR/console/响应头/资源版本，用干净 profile 复现。
2. CDN 配置漂移时恢复最后已知良好规则并定向 purge。
3. 代码回归使用正常 revert；不要临时加入 `unsafe-inline`、`unsafe-eval` 或通配域名。
4. 分析/查询数据泄漏按隐私事故处理，先停止相关脚本并保留审计记录。

### 合规、外部规则变更或下架通知

1. 保存通知原文、时间和来源，通知项目所有者及必要的合规负责人；不要在公开 Issue 粘贴保密往来。
2. 先停止受影响的持续访问或发布范围，避免扩大影响。
3. 明确哪些功能需要暂停：自动抓取、人民币换算、分析脚本或整个工具。
4. 只有处置方案完成必要确认后才恢复。

### 依赖、Action 或 vendor 供应链事件

1. 停止受影响的自动合并和发布。
2. 固定版本/SHA，核对上游安全公告、tag 与 commit。
3. 重新验证 vendor 精确字节、hash、使用集和 notice。
4. 在干净环境执行依赖漏洞、core、artifact、snapshots 和三浏览器检查。
5. 无法证明完整性时回滚到最后已知良好版本。

## 14. 回滚

代码回滚：

```bash
git checkout main
git pull --ff-only origin main
git revert <引入问题的合并或提交 SHA>
git push origin main
```

数据回滚：暂停自动更新 → revert 完整坏数据提交 → 运行 artifact/data/snapshot/UI 验收 → 推送 → 验证生产 → 恢复自动更新。不要只 checkout `prices.json`。

Cloudflare/DNS 回滚使用发布前保存的配置记录；TLS 最低版本不得随意降低。DNSSEC 变更必须保持父区 DS 与 Cloudflare DNSKEY 匹配。

## 15. 仓库卫生与长期文档

- `run-log.json`：最近 90 次成功运行。
- 诊断 artifact：按 workflow retention；只读发布工件短期保留。
- Apple 原始 HTML：不入库、不上传 Actions artifact。
- 规范化 Apple JSON snapshots：作为历史证据长期保留，同日修订不覆盖。
- 临时浏览器、截图、日志、下载包、本地审计工具和一次性清单放入 ignored `artifacts/`。
- 公开仓库不保留面向特定 AI/代理的 `AGENTS.md`；长期规则写入 README/OPERATIONS。
- 项目长期 Markdown 仅为 `README.md`、`OPERATIONS.md`、`THIRD_PARTY_NOTICES.md` 和 `data/apple-snapshots/README.md`，由 core 测试保护允许列表。
- 页面底部当前只展示“本工具与 Apple Inc. 无关联，数据仅供参考。”及版权信息；不要把 GA4 / Cloudflare Web Analytics 运维说明误写成当前可见 footer 文案。
- GA4 与 Cloudflare Web Analytics 的实际启用状态、隐私边界和检查方法记录在 README/本手册中；若未来要新增用户可见统计披露，应作为明确的产品文案变更，并同步修改页面与 UI 测试。
- 不要在文档中重新引入已经关闭、已经决策或已经由代码契约解决的历史待办；若事实发生变化，按新的具体事件记录和处理。
- 修改文档时同步清理代码、workflow、测试和页面文案中的失效引用。
- Git 历史和 `history.json` 的增长继续由每周维护 workflow 监控；不要由自动任务重写 Git 历史。

## 16. 定期演练

至少定期验证：

- 数据回滚和恢复。
- Secret 轮换与 Cloudflare dispatch。
- Healthchecks 成功、严重失败和缺失心跳。
- TLS/DNSSEC/证书/HSTS 基线。
- 干净浏览器隐私检查、三浏览器 UI、窄屏和键盘流程。
- 外部依赖联系人、账号恢复方式和规则变更通知渠道仍可用。
