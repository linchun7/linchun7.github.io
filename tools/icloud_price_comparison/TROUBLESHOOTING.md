# iCloud+ 全球价格比较故障排查

本文按“看到什么现象”组织。系统设计原因见 [ARCHITECTURE.md](ARCHITECTURE.md)，完整生产要求见 [OPERATIONS.md](OPERATIONS.md)。

## 1. 先做什么

从 `tools/icloud_price_comparison/` 开始，先确认当前代码和已提交数据自身是否健康：

```bash
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
```

涉及浏览器行为再运行：

```bash
pnpm test:browsers
```

涉及真实 Apple / FX 来源但不希望写生产数据时才运行：

```bash
pnpm check:live
```

不要用 `pnpm update:data` 作为“看看会不会好”的诊断命令；它是生产数据写入入口。

排查时先记录：失败 workflow/run、commit SHA、首个失败步骤、错误码、当前 `prices.json.generatedAt` / Apple `Published Date`、是否发生了数据/结构变化。不要先改 JSON 再寻找原因。

## 2. 自动更新失败，但线上旧价格仍可看

这通常是正常的失败关闭，而不是“回滚失效”。

先看：

1. `Update iCloud prices` 的首个失败 job/step；
2. 是 prepare/daily guard、Apple、FX、数据校验、静态生成、artifact 还是 publish 阶段失败；
3. `main` 是否在生成期间被其他提交推进；
4. 上一次成功 `data/run-log.json` 是否仍完整。

不要：

- 为了让任务变绿直接修改 `prices.json`；
- 复用旧生成工件 rebase 到新 `main`；
- force push；
- 因单次网络失败降低 parser/data/snapshot 校验。

若上一份已知良好数据仍在服务，应先修故障原因，再让下一次正常更新产生新候选。

## 3. `Apple parser disagreement` / 两条解析路径不同

含义：同一 HTML 的 `document-order` 与 `apple-markers` 对市场/容量/价格的理解不同。

先看：

- Apple 页面是否真的改版；
- 是否返回 challenge/error/地区化异常页面；
- 哪一个市场或容量开始产生结构分歧；
- 合法 fixture 是否能复现。

处理：同时修复两条解析路径或其共享规则，直到同一有效 HTML 再次 `cross-checked`。

不要把其中任一路临时提升成“唯一可信解析器”发布生产数据。

## 4. Apple 初次抓取和确认抓取不同

若业务语义发生变化，系统会额外获取独立 no-store 样本。A/B/B、A/degraded/A 等模式有明确恢复规则；A/B/A、A/B/C 或始终无法形成稳定证据时应停止。

先确认差异到底是：

- Apple 当地价格变化；
- market/tier/currency 结构变化；
- 页面暂时不同步；
- 某一路 parser 退化；
- 网络/挑战页噪声。

不要把“不稳定”自动归类成“Apple 已更新”。等待后续自动重试通常比手工放行更正确。

## 5. `Published Date` 倒退、未来或异常

Apple `Published Date` 是官方页面事实，不应由抓取当天日期替代。

先看：

- HTML 中实际 `Published Date`；
- 当前 `prices.json.source.publishedDate`；
- snapshot index 中该日期及相邻日期；
- 是否只是本地/runner 系统时钟异常。

不要手工把发布日期改成今天以绕过校验。若 Apple 页面本身异常，保留上一份生产数据并等待/复核。

## 6. FX 认证源失败或 `fx.stale`

先区分：

1. 认证源不可用，但开放源正常；
2. 两个在线源都失败；
3. 在线源返回数据但 sanity/required currency 校验失败；
4. 系统在允许窗口内沿用上一份安全派生结果。

先看 Action notice、来源状态、required currencies 和 fetchedAt。不要打印或复制 `EXCHANGE_RATE_API_KEY`。

不能做：

- 把旧 FX 无期限延长；
- 缺少新币种汇率时硬算；
- 用公开两位小数 CNY 反推 raw FX；
- 把 FX-only 异常描述成 Apple 已确认变价。

## 7. `cnyRank` / 最低价看起来不符合两位小数

先确认是否只是舍入边界。排名由全精度 CNY 值生成，`cnyPrice` 只是两位小数展示。

合法情况：同一 `cnyRank` 的两个地区可能显示相差一分钱。

异常情况包括：

- 同一排名组显示金额跨度超过允许的一分舍入边界；
- 不同排名与显示金额明显反序；
- 排名不稠密/跳号。

不要在前端按 `cnyPrice` 重新计算全球排名。先检查生成器和共享 `data-contract.js`。

## 8. `Apple snapshot active revision does not match current prices`

含义：候选 current price 与该发布日期的活动 snapshot revision 不一致，更新事务必须回滚。

特别注意同日 A → B → A：再次观察到旧 A 不等于自动回滚 active revision 到 A。

先看：

- `data/apple-snapshots/index.json` 的 activeContentHash；
- 同日 revisions 的 contentHash / firstConfirmedDate；
- 当前候选 snapshot content hash；
- history 与 current prices 对应关系。

不要：

- 手工改 activeContentHash 让候选通过；
- 删除 B 修订；
- 覆盖同日旧 snapshot；
- 只写 `prices.json` 而不处理整个事务。

如果规则本身确实需要改变，应作为 snapshot 语义变更设计和测试，而不是事故现场热修数据。

## 9. `validate:artifact` 失败

`validate:artifact` 是跨文件最终一致性校验，不只是 JSON schema check。

先看错误属于：

- 精确文件集合；
- prices/history 关系；
- snapshot index / hash；
- 当前 active snapshot；
- Published Date 事件重算；
- 静态投影相关输入。

不要逐个手拼 JSON 修到验证器不报错。找到最后一个完整已知良好数据提交，定位哪一个生产步骤破坏了整体一致性。

如果生产数据已经错误发布，优先 revert 完整坏数据提交，然后重新跑正常更新。

## 10. `validate:snapshots` 失败

先看具体哪个日期/修订：文件缺失、SHA 不符、schema/市场/容量/价格无效，还是 index 指向异常。

不要只复制一个 snapshot 文件到生产目录。历史修复必须保持 snapshot 文件、index、history 的共同语义；历史导入使用完整输入和正式 import 流程。

## 11. 更新中断、lock 或 transaction journal 残留

更新器和历史导入都设计为下次运行先恢复未完成事务。

先做：

- 确认没有真实活跃的同类进程；
- 查看实现判定 stale lock 的条件；
- 重新运行正常入口，让恢复逻辑先执行。

不要手工删除新鲜 lock、journal 或 `.tmp-*` 文件后继续写生产数据。只有实现明确判定可回收时才处理 stale lock。

## 12. `render:static:check` 失败

常见错误：

- `STATIC_RENDER_MISMATCH`：`ICLOUD_STATIC_*` 生成区域与数据/生成器不一致；
- `SEO_PROJECTION_MISMATCH`：description、OG/Twitter description、图片 alt、`#brandDescription` 等与 `seoProjection()` 不一致。

正确顺序：

1. 判断真正事实源应修改哪里；
2. 修改 `static-page.mjs` / `render-static-page.mjs` 或合法数据源；
3. `pnpm render:static`；
4. `pnpm render:static:check`；
5. core / 必要浏览器回归。

不要直接改 `index.html` 生成目标来消掉错误。

## 13. `assets:check` / vendor hash 失败

资源 query version 和 vendor manifest 都基于实际字节 hash。

若是自有 JS/CSS 或 data-contract 变化：运行 `pnpm assets:update`，不要手填 query version。

若是 vendored Lucide subset 实际字节变化：

- 先确认变更确实来自当前 package pin；
- 更新 vendor manifest SHA；
- 保持许可证/来源说明，不在 vendor 注释或 notices 重复维护包版本号；
- 运行 `pnpm test:vendor` 和 core。

## 14. 页面显示“价格数据暂时无法读取”

先区分：

- 首次网络 JSON 失败，但静态 DOM 可用；
- 静态数据也已经超过硬期限/时间异常；
- 网络返回更早快照，被单调性保护拒绝；
- `prices.json` 本身未通过浏览器数据契约。

使用干净 profile 检查 network/console；不要先清除服务器端历史数据。

页面没有 Service Worker 或应用持久价格缓存，因此“清 localStorage”不是有效修复动作。

## 15. 系统时间修正后页面仍不正常

系统时间异常可能把已加载快照判成 future/unusable。当前设计要求时钟恢复时触发受并发保护的刷新，恢复搜索、地区、排序、发布日期和历史入口。

先复现：

1. 页面先成功加载；
2. 进入 future 或 >7 天状态；
3. 刷新失败；
4. 校正时钟；
5. 检查是否完成一次 guarded refresh。

若网络继续离线但内存快照在新时钟下有效，控件可以恢复，但仍应显示“暂时无法获取更新”。不要通过删除错误提示来冒充刷新成功。

## 16. GitHub Actions 绿色，但线上还是旧版本

不能把 workflow success 当作生产字节已经切换的唯一证明。

先看：

- `pages build and deployment` 是否对应正确 merge SHA；
- 线上 HTML 是否引用新的资源 query version；
- 实际 `script.js` / `data-contract.js` SHA-256 是否等于合并版本；
- Cloudflare/GitHub Pages 的 Last-Modified / cache 状态。

对于带 hash query 的资源，若 HTML 已切换版本但资源字节仍不匹配，这是发布异常；不要只靠浏览器强刷得出结论。

## 17. PR 浏览器矩阵某一个失败

不要因为 Chromium 通过就忽略 Firefox/WebKit 的真实失败。先看失败是否属于：

- 浏览器能力差异；
- race/timing；
- forced-colors 已由明确的 Chromium 专项覆盖而在其他浏览器按既有规则跳过；
- 真正 UI/DOM 状态错误。

只有测试代码已经明确标记的预期 skip 才是 skip；不能临时把失败改成 warning/skip 来合并。

## 18. 新市场、市场改名或 `MARKET_IDENTITY_*` 错误

先以 `marketId` 当身份、Apple source name 当当前名称理解问题。

- unknown 新市场：允许 deterministic `apple-*`，但须正常语义确认且无冲突；
- source wording 改变：registry source alias 必须仍指向原永久 ID；
- removed + added 形成 rename 候选：显式确认，不模糊绑定；
- reserved ID collision：停止，不能复用历史 ID。

不要为了“ID 更漂亮”改已发布 marketId。

## 19. Dependabot / Action 自动合并没有发生

自动合并本来就是严格 allowlist，而不是所有绿色 PR 都必须自动合并。

检查：

- PR 是否由 `dependabot[bot]` 创建；
- head/base 是否与刚通过的 workflow 完全一致；
- iCloud npm 改动是否只在允许的 package/lockfile 范围；
- Action 是否是官方 `actions/*`、完整 commit SHA 和同 major 前进；
- 另一个要求的验证 workflow 是否也在精确 head SHA 上通过。

自动合并拒绝时不要绕过；按人工 PR 评审即可。

## 20. Git 出现 `bad tree object` / `git fsck` 缺对象

先确认是否影响当前 `main`，还是只影响历史本地 branch/tag。生产代码健康和本地对象库健康是两个问题。

安全顺序：

1. `git status` 确认工作树；
2. `git fsck --connectivity-only --no-reflogs` 定位缺失对象；
3. 查哪个 ref/旧 commit 引用它；
4. 优先从权威远端恢复精确对象；
5. 修复后要求 `git fsck --full --no-reflogs` 返回 0。

不要为了让 fsck 变绿直接 `prune`、删旧分支/tag 或重写历史。若 GitHub 仍能按精确对象 SHA 返回 tree/blob，可按对象内容重建，但每一个新对象必须由 Git 自己计算出完全相同 SHA 后才接受。

## 21. Cloudflare / CSP / DNS / TLS 看起来与文档不一致

这些属于外部控制面，仓库无法单独证明实时配置。

先直接检查生产响应、TLS、DNS/DNSSEC、Cloudflare 控制面和最近变更记录。不要因为 README/OPERATIONS 写着某个值就断言控制面仍然如此。

代码需要的最小 CSP 和响应头基线见 [OPERATIONS.md](OPERATIONS.md)。如果控制面漂移，恢复最后已知良好规则并做真实生产验证。

## 22. 什么时候停止继续“优化”

如果没有真实 production failure、Apple 实际结构变化、可复现的数据完整性缺口、安全/隐私问题或明确用户体验问题，不要在故障排查过程中顺手增加新的缓存层、事实源、自动修复分支或重复校验器。

先恢复到已有契约，再单独评估是否真的需要架构变化。