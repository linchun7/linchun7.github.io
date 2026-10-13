# iCloud 维护与排障

使用、代码入口及验证命令见 [README](README.md)。

## 数据与身份

- 当前价格唯一事实源是 `data/prices.json`（schema 4）。Apple 英文页决定价格、币种、容量及原始 Published Date，中文页只用于人工名称映射。双解析器须一致，语义变化另需独立抓取；两种解析不是两个独立来源。
- 身份按已发布 prices/history 的 identity ledger → `scripts/market-registry.mjs` → 确定性 `apple-*` 解析。已发布 `marketId` 永久冻结，不 rekey、不复用退市 ID；source alias 只绑定来源措辞，不猜改名。价格历史按永久 ID 连续，发布日期事件保留原 source name，不重写历史价格或观察时间。
- 全精度人民币值生成排名，展示四舍五入到分，前端不按展示金额重排。Apple 失败保留完整旧快照，不伪造成功观察单独刷新汇率；汇率失败只沿用校验通过且兼容的旧派生结果，保留原源日期，不设年龄淘汰。缺原始汇率不能从人民币分位反推或计算新价/新币种。独立确认市场下架时，兼容市场保留人民币值，按原排名分组消除空档，保留次序和并列。
- 最低价账本只追加可核验变化，证据不全保留缺口。Git 回填遇缺失或不可解析价格版本即停止并报告 SHA，不跳过重写。价格、history.json、快照、运行日志和静态页跨文件一致；`assertStaticPageMatches` 及暂存 Git tree 门禁同时核验内嵌数据和表格。
- Apple 快照只保存规范化 JSON，不保存原始 HTML，不覆盖同日不同修订。A → B → A 不倒退活动修订，候选与活动快照不符即停止；导入及恢复见[快照说明](data/apple-snapshots/README.md)。

## 中文名称

`scripts/country-names.zh.json` 只存稳定 ID 对应的人工核验中文名称，原样取 Apple 中文页，禁止翻译、按行序或同价猜配；不确定保留英文，不阻断更新。欧元区显示“欧盟”。变更需逐项核对英文身份、官方中文原文及来源，保留 ID，更新显示映射后完整验证并核对页面；core 的成员/映射一致性检查不能代替人工身份核验。

监测分别检查英文数据仍显示英文的成员变化，以及中文来源新增未复核/尚未显示的官方名称。`scripts/apple-zh-reviewed-markets.json` 只增不减，名称消失不视为新问题；告警不自动绑定市场，“已复核”不等于“已上线”，仅改复核集合不能替代显示映射。

## 发布与权限

1. prepare 拒绝旧工作流并固定最新 main SHA；生成/测试 job 只读，从该版本生成候选，通过 core、锁定 Playwright Chromium、工件和静态投影验证。
2. 独立发布 job 重验下载工件，不安装项目依赖。main 只有无关工具变更时保持工件字节并重验；iCloud 相关变化须废弃候选，禁止强推。
3. `stage-price-publication.mjs` 仅暂存已测 data/index 路径，从 Git tree 读取原始 blob，核对完整文件集、字节并深验；忽略规则或属性转码导致差异即在提交前停止。CLI 与暂存门禁共用严格页面投影判断：容量增删只允许对应生成区域及六处确定的 SEO/品牌文案改变，CSP、资源引用及其余 shell 必须逐字保持。发布日期回归以临时完整合成工件测试新日期，不固定生产数据日期。
4. 等待 Pages，验证 canonical 数据、HTML 投影及资源实际哈希；仅完整成功构成每日幂等/恢复证明。可信 main 完整后继版本可接管旧验证，包括只更新资源；同时间异数据、混合资源或缺可信证据均拒绝，被取代的旧验证不冒充恢复。

GITHUB_TOKEN 发布数据提交不会再触发普通 push 验证，updater 必须保留完整验收；普通 main 代码提交在核心/三浏览器通过后使用同一生产校验器。YAML 改变后从 main 新建 Run workflow，不重跑旧定义。关键契约、生成器和 update/validate workflow 变化须同步两份指南，测试、工件复验和生产验收门禁均保留。

## 排障与告警

先看失败 run 的首个失败步骤、错误码和真实价格/汇率时间，不先改 JSON。

- 网络/来源失败：保留旧数据，查来源状态，短暂故障交后续正常更新
- `STALE_WORKFLOW_DEFINITION`：从最新 main 新建运行
- parser disagreement/独立确认不一致：查官方页或挑战页，用 fixture 修解析，不关闭交叉核验
- Published Date 倒退/未来：查官方日期及系统时钟，不改成今天
- FX stale/缺币种：查真实源日期和兼容条件，不伪造汇率
- artifact/snapshot/static mismatch：定位跨文件根因，不要逐个手拼 JSON、改 active hash 或单换 prices.json
- main advanced：相关变更须重新生成，不覆盖新 main
- 内嵌数据读取失败：静态价格可读，查 HTML、console、CSP 和生成区域；启动不读 prices.json，清 localStorage 无助于修复
- 时钟纠正后仍离线：可见/恢复及交互只本地复核，有效快照应恢复价格、日期、最低价及交互，不请求主价格；已打开最低价历史独立复核其检查时间
- Actions 成功但页面旧：核对最终 Pages SHA、canonical 验证及资源哈希
- lock/journal 残留：确认无活跃更新，让正常入口恢复，不手删新鲜事务文件
- `bad tree object`：从权威远端恢复精确 Git 对象，不 prune、删分支或改数据掩盖缺失

诊断用 `pnpm test:core`、`pnpm validate:artifact`、`pnpm validate:snapshots`，界面问题查看三浏览器结果。不要用 `pnpm update:data` 试探生产；只读在线检查用 `pnpm check:live`。

完整生产成功且汇率未降级才发送健康心跳 /0；沿用旧汇率可发布可靠价格，但不发成功心跳、不因当天较早成功跳过更新。严重数据/测试/发布失败发送 /1；单次 transient 与持续汇率故障由缺失成功心跳的宽限期发现。仅真实验证恢复后关闭故障，中文监测另查结果。


下载 Action 升级须通过 artifact-roundtrip；HTTP 429 重试不能替代哈希核对或放宽发布门禁。

## 回滚与外部配置

回滚用 revert 完整坏提交，保留 Git 历史。数据事故先协调自动更新，恢复整组数据/快照/索引/HTML，通过工件、浏览器及线上验证后恢复自动更新，不单独 checkout prices.json。

- `EXCHANGE_RATE_API_KEY` 仅用于认证源 HTTPS Authorization: Bearer，不进 URL、日志或工件
- `ICLOUD_HEALTHCHECK_PING_URL` 整值是凭据，不打印或入库
- GitHub、Cloudflare、DNS 和外部触发器状态不能由仓库单独证明
- HTML/JSON 短缓存；静态资源内容哈希用 assets:update/check 管理，不手填。资源声明放在 meta CSP 后、内嵌 JSON 前，既保留 CSP 又及早发现资源
- Cloudflare HTTP CSP 与页面 meta CSP 保持最小一致权限；frame-ancestors 需 HTTP header，不为加载扩大第三方域名

HTTP 基线：Referrer-Policy: origin、X-Content-Type-Options: nosniff、X-Frame-Options: DENY；Permissions-Policy 禁用摄像头/麦克风/定位/支付/USB；HSTS max-age=31536000; includeSubDomains; preload。保持 HTTPS、最低 TLS 1.2、有效证书及 DNSSEC 链，控制面变化单独核验。

## 依赖与归属

Dependabot 每周一北京时间 10:20（iCloud npm）、11:20（共享浏览器 Playwright）、12:20（Actions）错峰检查，保持独立 PR。npm 精确稳定版本 major/minor/patch 在严格文件范围及完整测试通过后可自动合并；Playwright 验证 Chromium/Firefox/WebKit。官方 Action 仅同 major 精确 SHA 向前升级可自动合并，Action major 更新和第三方 Action 人工复核。


上传 Action 升级须验证 artifact-roundtrip 的上传、下载及 SHA 一致性；不扩大工件内容或权限。

保留 LICENSE、THIRD_PARTY_NOTICES、vendor 来源/哈希及规范化价格证据。长期文档仅 README、本说明、短快照说明和第三方归属。
