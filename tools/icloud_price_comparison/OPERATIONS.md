# iCloud 维护与排障

使用、代码入口及测试命令见 [README](README.md)。本文只保留维护生产必需的规则；运行结果、修复过程和验收报告放在 PR / Actions，不追加到仓库文档。

## 数据与身份

- 当前价格唯一事实源为 `data/prices.json`（schema 4）。Apple 英文价格页决定价格、币种、容量及原始 Published Date；中文页只用于人工名称映射。双解析器必须一致，语义变化还需独立抓取确认；不把同一页面的两种解析当成两个独立来源。
- 市场身份按已发布 prices/history 的 identity ledger → `scripts/market-registry.mjs` → 确定性 `apple-*` 解析。已发布 `marketId` 永久冻结，不 rekey，不复用退市 ID；source alias 只把新来源措辞绑定回原身份，不模糊猜测改名。
- 价格历史按永久 ID 连续，Apple 发布日期事件保留原 source name 证据。不得为了名称整齐重写历史价格或观测时间。
- 排名由全精度人民币值生成，显示金额四舍五入到分；前端不按展示金额重新排名。
- Apple 失败时保留完整旧快照，不另造一次“成功价格观察”来单独刷新汇率。在线汇率失败时只沿用校验通过且兼容的旧派生结果；不设年龄淘汰，但保留原源日期。缺少原始汇率时不能由两位小数人民币反推汇率，更不能计算新价格或新币种。
- 最低价账本仅追加可核验变化；来源、汇率或历史证据不完整时保留缺口，不虚构价格事件。当前价格、历史、快照、运行日志和静态页必须跨文件一致。
- Apple 快照不保存原始 HTML，不覆盖同日不同修订。A → B → A 不能擅自倒退活动修订；候选与活动快照不符时停止。历史导入与恢复见[快照说明](data/apple-snapshots/README.md)。

## 中文名称

`scripts/country-names.zh.json` 只存稳定 ID 对应的人工核验中文名；未知名称显示英文，不阻断价格更新。欧元区显示“欧盟”。

监测保留两个独立视角：英文价格数据中仍显示英文的成员变化；中文来源新增未复核名称或官方名称尚未显示。复核集合 `scripts/apple-zh-reviewed-markets.json` 只增不减，名称消失不视作新问题。告警只要求人工核对，不自动推测新国家之间的绑定，也不能把“已复核”当作“已上线”。

确认对应关系后更新名称映射，保留市场 ID，执行完整验证并检查实际页面。仅改复核集合不能替代显示名称更新。

## 发布与权限

1. prepare 拒绝过时工作流，固定最新 main SHA；生成与测试只读 job 从该版本生成候选。
2. 候选通过 core、锁定 Playwright Chromium、工件和静态投影验证后上传；不重复跑相同 core。
3. 独立发布 job 重验下载工件。main 仅有其他工具的无关变更时保持工件字节不变并重验；iCloud 相关变更则废弃候选。禁止强推。
4. `stage-price-publication.mjs` 只强制暂存已测 data/index 路径，从 Git tree 读取原始 blob，核对完整文件集和字节，再深验。忽略规则或属性转码造成差异时必须在 commit/push 前停止。
5. 等待 Pages 并验证 canonical URL 的数据、HTML 投影和版本化资源；仅完整成功才构成每日幂等/恢复证明。被新部署取代的旧验证不能冒充恢复。

生成 job 不具备写权限，发布 job 不安装项目依赖。GITHUB_TOKEN 发布数据提交不会再触发普通 push 验证，因此 updater 必须保留自身的完整验收。手动恢复使用 main 的新 Run workflow；如 YAML 已改变，不重跑旧记录。

关键契约/生成器/update/validate workflow 修改需同步 README 和本文件；仅改文档不修改价格。测试、工件复验、生产验收各守不同边界，不能以精简文档为由删减。

## 告警与常见故障

先看失败 run 的首个失败步骤、错误码和实际价格/汇率时间，不先改 JSON。

| 现象 | 处理 |
| --- | --- |
| 网络/来源失败，旧价仍显示 | 保留旧数据，查看来源状态；短暂失败交给后续正常更新 |
| STALE_WORKFLOW_DEFINITION | 从最新 main 新建运行，不重跑旧 YAML |
| parser disagreement、确认抓取不一致 | 检查官方页面/挑战页，以 fixture 修解析；不关闭交叉校验强行发布 |
| Published Date 倒退/未来 | 核对官方日期与系统时钟，不把日期改成今天 |
| FX stale 或币种缺失 | 核对真实源时间与兼容条件；不伪造新汇率、不套用缺失币种 |
| artifact/snapshot/static mismatch | 找跨文件不一致根因；不要逐个手拼 JSON、改 active hash 或只替换 prices.json |
| main advanced | iCloud 相关变化须从新 main 重新生成；禁止将旧候选强行覆盖 |
| 页面 JSON 加载失败 | 静态价格仍可读，检查 network/console/CSP；无应用价格缓存，清 localStorage 无助于修复 |
| 时钟纠正后仍离线 | 有效静态价格/日期/最低价应恢复；交互仍需已校验 JSON，不能假装联网成功 |
| Actions 绿但页面仍旧 | 核对最终 Pages SHA、canonical 验证及线上资源哈希，不能只靠强刷 |
| 事务锁/恢复日志残留 | 确认无活跃更新，让正常入口执行恢复；不手删新鲜 lock/journal |
| bad tree object | 先从权威远端恢复精确 Git 对象；不 prune、删分支或改数据掩盖缺失 |

诊断入口：`pnpm test:core`、`pnpm validate:artifact`、`pnpm validate:snapshots`，界面问题再看三浏览器结果。不要用 `pnpm update:data` 试探生产数据；在线只读检查用 `pnpm check:live`。

外部心跳：完整生产成功且汇率未降级时发送 /0；沿用旧汇率仍可发布可靠价格，但不发送成功心跳，由既有宽限期发现持续汇率故障；当前快照汇率降级时不因当天较早成功而跳过更新；数据/测试/发布严重失败发送 /1；单次 transient 故障由缺失成功心跳的宽限时间处理。只有真实验证恢复才关闭故障状态。中文监测与价格更新独立，分别检查结果。

## 回滚与外部配置

回滚用 revert 完整坏提交，保留 Git 历史。数据事故需先协调自动更新，恢复整组数据/快照/索引/HTML，重新跑工件和浏览器验证、核对线上后恢复自动更新。不要单独 checkout prices.json。

- `EXCHANGE_RATE_API_KEY` 仅由认证源 HTTPS Authorization: Bearer 使用，不进 URL、日志或工件
- `ICLOUD_HEALTHCHECK_PING_URL` 整个值都是凭据，不打印或入库
- GitHub、Cloudflare、DNS 和外部触发器实时状态不能由仓库单独证明
- HTML/JSON 保持短缓存；静态资源以内容哈希版本管理；版本变更用 assets:update/check，不手填
- Cloudflare HTTP CSP 与页面 meta CSP 保持最小一致权限，frame-ancestors 需 HTTP header；不要为修复加载扩大第三方域名

HTTP 基线：Referrer-Policy: origin、X-Content-Type-Options: nosniff、X-Frame-Options: DENY；Permissions-Policy 禁用摄像头/麦克风/定位/支付/USB；HSTS max-age=31536000; includeSubDomains; preload。保持 HTTPS、最低 TLS 1.2、有效证书和 DNSSEC 链；这些控制面变更需单独核验。

## 依赖与文档维护

Dependabot 每周一北京时间 10:20（iCloud npm）、11:20（共享浏览器 Playwright）、12:20（Actions）错峰检查，保持独立 PR。npm 精确稳定版本 major/minor/patch 可在严格文件范围及完整测试通过后自动合并；Playwright 必须验证 Chromium/Firefox/WebKit。官方 Action 仅同 major 精确 SHA 向前升级可自动合并；Action major 更新及第三方 Action 需人工复核。

保留 LICENSE、THIRD_PARTY_NOTICES 和 vendor 来源/哈希；不删除规范化价格证据来减少文档。仓库长期说明限 README、本文件、短快照说明及第三方归属，不存阶段报告、测试截图、运行日志副本或交接流水账。当前故障修复证据留在 PR 与 Actions。
