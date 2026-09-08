# iCloud+ 全球价格比较架构说明

本文解释系统为什么这样设计、各数据与模块分别拥有什么权威，以及修改一处后必须同步检查什么。产品入口与开发命令见 [README.md](README.md)，生产运行见 [OPERATIONS.md](OPERATIONS.md)，按故障现象排查见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。

## 1. 一句话模型

这是一个“官方页面取证 → 受控解析和确认 → 汇率派生 → 原子数据提交 → 静态页面投影 → GitHub Pages 发布 → 浏览器二次校验”的静态数据产品，而不是一个运行时向 Apple 查询价格的网页应用。

```text
Apple Support 英文价格页 ──┐
                           ├─ update-prices.mjs
汇率认证源 / 开放回退源 ───┘      │
                                  ├─ Apple 双解析 + 语义确认
                                  ├─ market identity
                                  ├─ FX/CNY 派生与异常门禁
                                  ├─ history / snapshot / transaction
                                  └─ data contract
                                         │
                                         ├─ prices.json
                                         ├─ history.json
                                         ├─ run-log.json
                                         └─ apple-snapshots/
                                                │
                         static-page / render-static-page
                                                │
                                           index.html
                                                │
                          GitHub Actions → main → GitHub Pages
                                                │
                                            Cloudflare
                                                │
                    静态 DOM + 网络 JSON + 浏览器 freshness lifecycle
```

## 2. 事实源与派生物

| 对象 | 权威 | 不是什么 |
| --- | --- | --- |
| Apple 当前当地价格、币种、容量、active market、`Published Date` | Apple Support 英文 108047 | Wayback、搜索结果、浏览器缓存都不是独立价格源 |
| 已复核中文市场名称 | Apple Support 简体中文 108047，经 `country-names.zh.json` 固化 | 机器翻译不是权威 |
| 当前公开价格数据 | `data/prices.json` | `index.html` 不是第二套当前价格事实源 |
| 历史价格/币种/结构事件 | `data/history.json` | `run-log.json` 不是历史账本 |
| Apple 页面历史证据 | `data/apple-snapshots/` 的规范化 JSON + index | 不保存原始 HTML；Wayback 仅作历史证据定位 |
| 汇率事实 | 已验证的在线 FX 候选，或满足严格 freshness/兼容条件的上一份安全派生结果 | CNY 不是 Apple 结算价 |
| 页面静态价格与 SEO 投影 | 从已验证 `prices.json` 与生成器确定性生成 | 不应手改生成后的 `index.html` 作为源 |
| 浏览器内当前状态 | 已通过共享数据契约的静态/网络快照 | 浏览器不持久化一份新的价格数据库 |

理解项目时先区分“事实源、历史证据、派生数据、展示投影”。大量保护逻辑都在防止这四类对象互相越权。

## 3. 更新器的阶段和失败边界

生产更新由 `scripts/update-prices.mjs` 驱动，重要阶段按顺序成立，后一步不能为修复前一步而放宽规则。

1. 读取上一份已验证生产数据，建立更新/恢复上下文。
2. 在共享网络预算内获取 Apple HTML；响应大小、HTTPS、redirect、UTF-8 与超时边界先行。
3. 同一份 HTML 分别经 `document-order` 与 `apple-markers` 解析。两路逐字段一致才是 `cross-checked`。
4. 业务语义发生变化时再做独立 no-store 确认；稳定证据才能继续。不能把“网络暂时不同”自动解释成 Apple 改价。
5. 解析结果进入永久 market identity 规则，防止 renamed/removed/unknown market 被错误绑定。
6. 获取并验证 FX；认证源失败可尝试开放源，两个 fresh 来源都不可用时只能在明确条件下沿用上一份安全派生结果。
7. 以全精度 CNY 值计算公开排名，再输出两位小数 `cnyPrice`。显示金额不能反向成为排名事实源。
8. 生成候选 `prices/history/run-log/snapshot`，执行数据、时间、异常价格、身份与跨文件校验。
9. 快照保存或去重后，在事务提交前再次验证 active revision、候选 current prices 与 history 一致性。
10. 只有整个事务成功才替换生产文件；中途失败恢复上一份完整状态。
11. 从已验证数据生成静态 HTML 并做 artifact/static projection 校验。

关键原则：失败关闭优先于“尽量更新”。网络暂时不确定时继续服务上一份已知良好数据，比发布未经证明的新数据更正确。

## 4. Market identity 为什么比市场名称更重要

`marketId` 是永久身份，不是当前 Apple 标题的缩写。

解析后的市场身份按以下优先级解析：

```text
已发布 prices/history identity ledger
        ↓
active market-registry.mjs
        ↓
deterministic apple-* fallback
```

- 一旦 `marketId` 正式发布，就不能因为名称更友好、Apple wording 改变或搜索体验而 rekey。
- registry 的 source alias 只能把新的 Apple source wording 指回同一个永久 ID。
- 真正 unknown market 可产生稳定的 `apple-*` ID；一旦发布，这个 fallback ID 也永久冻结。
- removed market 的历史 ID 不释放给后来者。
- 一对一 removed/added rename 候选仍要求显式确认，不做模糊自动绑定。

这使 `history.json`、深链接、历史快照和未来名称修订都能围绕同一个身份累计。

## 5. CNY、显示金额与排名

人民币金额是为了横向比较而派生，不是 Apple 结算数据。

生成器使用全精度换算值判断价格顺序和并列，再输出：

- `cnyPrice`：展示用两位小数；
- `cnyRank`：由全精度值生成的全球排名。

因此存在一个容易误解但合法的边界：两笔全精度金额足够接近，可以拥有同一排名，但两位小数显示为相差一分钱。反过来，两位小数恰好相同，也不能据此在浏览器重新并列。

共享数据契约会拒绝：

- 非连续/非稠密排名；
- 不同排名与公开金额明显反序；
- 同一排名组公开金额跨度超过允许的舍入边界。

前端搜索和地区筛选始终保留全球 `cnyRank`；只有“国家/地区排序”改为显示当前列表序号。

## 6. Snapshot revision 的语义

Apple `Published Date` 与页面内容版本不是同一个概念。Apple 可能在同一发布日期下修订价格页，因此 snapshot index 允许一个 `publishedDate` 对应多个内容修订。

每个 revision 的核心身份是规范化内容 hash；`firstConfirmedDate` 表示当前证据最早确认该修订存在的北京时间日期。活动修订按当前 index 规则确定，不覆盖旧证据。

特别注意 A → B → A：

- A 和 B 都是已有历史证据；
- 后来再次观察到旧 A，不等于应该自动把 active revision 从 B 倒退到 A；
- 更新器必须在事务内证明 candidate 与 active snapshot 一致，否则整个候选回滚；
- 不应为了让候选通过而自动改写旧 revision 的 active 语义。

这是“证据账本”和“当前候选”分离的原因。

## 7. 浏览器为什么有静态 DOM、网络 JSON 和内存状态三层

页面必须在 JavaScript 关闭、网络失败、GitHub Pages/CDN 短暂不一致时仍能展示最近发布价格，所以 `index.html` 内含 `prices.json` 的静态投影。

JavaScript 可用时：

1. 首屏静态 DOM 先可读；
2. 浏览器读取网络 `prices.json`，通过与生成器共享的 `data-contract.js` 校验；
3. 网络快照更晚且有效时成为当前内存状态；
4. 更早的网络响应不能回滚已接受快照；
5. history 仅在需要时加载并独立校验。

浏览器不把价格写入 Cookie、localStorage、sessionStorage、IndexedDB 或 Service Worker。

## 8. Freshness lifecycle

当前价格有三个主要状态：

- `fresh`：生成时间不超过 36 小时；
- `stale`：超过 36 小时但不超过 7 天，只作旧数据参考；
- `unusable`：超过 7 天，或相对当前时间超前超过允许偏差等时间异常。

`fx.stale`、价格 stale/unusable 会降低或移除最低价提示，避免把旧派生结果继续包装成实时排名。

系统时钟异常是独立风险：页面可能先因“未来/过期”进入 unusable，随后用户修正系统时间。恢复时必须走受并发保护的刷新流程，统一恢复筛选、排序、历史入口、状态和最低价提示；若网络仍失败但内存快照在新时钟下可用，可以恢复操作，但必须保留网络失败提示。

## 9. 静态生成与 SEO 的边界

`index.html` 同时包含人工维护 shell 和确定性生成区域。

- `scripts/static-page.mjs`：生成 `ICLOUD_STATIC_*` markers 内的价格表、最低价、覆盖统计和更新时间等。
- `scripts/render-static-page.mjs` / `seoProjection()`：生成 markers 外的一组 SEO/首屏目标，例如 description、OG/Twitter description、图片 alt、`#brandDescription`。
- `scripts/update-asset-versions.mjs`：根据实际文件 hash 更新静态资源 query version。

因此不要因为某段 HTML 位于 markers 外就认为可以直接手改。生成目标应先改 generator，再执行 `pnpm render:static` / `pnpm assets:update`，最后由 check 命令证明确定性。

## 10. 发布权限为什么拆成两段

每日更新的生成/测试阶段使用 `contents: read`。它可以联网、安装依赖、解析和生成候选，但没有向仓库写入的权限。

独立发布阶段不执行候选依赖代码，只处理已经验证并打包的工件，才拥有 `contents: write`。发布前再次验证：

- 工件完整性；
- 静态投影；
- 生成时记录的 base SHA；
- 远端 `main` 是否仍停在同一个基线。

若 `main` 已前进，旧工件失败关闭并重新生成，不 rebase 旧工件，也不 force push。

普通代码变更走 PR 的只读 CI；合并后 GitHub Pages 自动部署。生产验收不能只看 workflow 绿色，应验证真实页面资源版本/字节与公共数据。

## 11. 信任边界

项目本身能在 Git 中证明的是：代码、测试、工作流定义、已提交 data、快照、静态投影和依赖 pin。

下列控制面只能记录“期望配置”，不能由仓库单独证明实时状态：

- Cloudflare 外部 08:05 dispatch；
- Cloudflare HTTP headers / cache / Analytics；
- DNS / DNSSEC / TLS 账户配置；
- GitHub/Cloudflare 凭据是否实际轮换；
- Healthchecks 外部服务是否收到心跳。

因此文档描述这些项目时应使用“生产要求/预期配置/需控制面确认”，而不是把仓库中的文字当作实时证明。

## 12. 修改影响矩阵

| 修改 | 同步检查 / 必跑 |
| --- | --- |
| `data-contract.js` / schema / `cnyRank` 语义 | `README`、`ARCHITECTURE`、`OPERATIONS`；core、artifact、browsers |
| `data-model.js` 搜索/region/URL 状态核心语义 | `README`、`ARCHITECTURE`；core、browsers |
| `scripts/update-prices.mjs` 抓取、FX、事务、snapshot 语义 | `ARCHITECTURE`、`OPERATIONS`，必要时 `TROUBLESHOOTING`；core、artifact、snapshots |
| `parse-prices.mjs` 或 Apple DOM 关联 | `ARCHITECTURE`，有新故障表现时更新 `TROUBLESHOOTING`；parser/core、live dry-run |
| snapshot index / history 语义 | `ARCHITECTURE`、snapshot README、`OPERATIONS`；data、artifact、snapshots |
| freshness / fallback / lifecycle | `README`、`ARCHITECTURE`、`OPERATIONS`、相关 troubleshooting；core、三浏览器 |
| static/SEO generator | `README` / `ARCHITECTURE`；`render:static`、`render:static:check`、core |
| JS/CSS/vendor 字节 | `assets:update`、`assets:check`；vendor/core、相关浏览器 |
| update / validate workflow、权限或发布边界 | `ARCHITECTURE`、`OPERATIONS`；workflow/core、PR CI |
| Dependabot / auto-merge | `OPERATIONS`；automation/core |
| Cloudflare/DNS/TLS 控制面 | `OPERATIONS`；部署后真实 HTTP/TLS/DNS 验收，不以仓库测试代替 |

关键架构代码/工作流发生变化时，PR CI 强制同步 `README.md`、`ARCHITECTURE.md` 和 `OPERATIONS.md`。`TROUBLESHOOTING.md` 是按症状维护的运行手册，不为每一个架构小改动强制改写；只有故障表现、首查步骤或禁止操作发生变化时才更新。

## 13. 封板原则

当前系统按长期自动运行设计。后续默认不再为“理论上更完美”增加新的事实源、缓存层、自动修复分支或重复校验器。

值得重新打开架构的事件主要是：

- 真实 production failure；
- Apple 页面/业务结构实际变化；
- 数据契约发现可复现完整性缺口；
- 安全/依赖/隐私风险；
- 明确且可验证的用户体验问题；
- 当前复杂度本身已造成维护故障。

否则优先保持现有边界、减少重复说明和测试新增，而不是继续堆叠保险层。