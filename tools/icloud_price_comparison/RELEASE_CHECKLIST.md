# iCloud+ 全球价格比较发布清单

适用于每次生产发布；上线前终验结论见 [RELEASE_REVIEW_2026-08-09.md](RELEASE_REVIEW_2026-08-09.md)，日常处理见 [OPERATIONS.md](OPERATIONS.md)。

规则：

- `P0/P1` 未关闭时不得发布，除非项目所有者和对应风险负责人留下明确、可追溯的书面接受记录。
- “已测试”必须附 commit SHA、运行 URL 或本地日志摘要；口头确认不算完成。
- Cloudflare、GitHub ruleset、DNS、Secret 和许可均为外部状态，代码测试通过不能代替它们。
- 发布操作员勾选后在文末签字；不要把 Secret、私密法律意见或 Token 截图提交到仓库。

## A. 发布记录

- [ ] 发布负责人：`________________`
- [ ] 项目所有者：`________________`
- [ ] 法律/隐私审批人：`________________`
- [ ] GitHub 管理员：`________________`
- [ ] Cloudflare/DNS 管理员：`________________`
- [ ] 候选 commit SHA：`________________________________________`
- [ ] 目标部署时间（Asia/Shanghai）：`________________`
- [ ] 回滚 commit SHA：`________________________________________`
- [ ] 发布/回滚沟通渠道：`________________`

## B. P0 法律与数据许可门禁

- [ ] 已取得 Apple 对当前自动访问方式和公开展示/复制价格内容的适用书面许可；或法律顾问已书面批准合法替代方案和约束。
- [ ] 已取得 ExchangeRate-API 对“公开展示由其汇率生成的套餐人民币参考价、但不公开 raw rates”的书面确认。
- [ ] 上述批准仍在有效期内，覆盖当前域名、更新频率、数据字段、归属标识和商业/非商业性质。
- [ ] 页面免责声明、Apple 独立关系说明、ExchangeRate-API attribution 与批准要求一致。
- [ ] 法律文件保存位置已记录在受控系统中，不提交到公开仓库。

若任一项未完成：**No-Go**。

## C. 候选与仓库卫生

- [ ] 当前分支和 commit 已冻结；审查基线 SHA 已记录。
- [ ] `git status --short` 仅包含预期业务/文档改动，没有 `node_modules`、浏览器、截图、日志、tar/zip、临时 fixture 或 Secret。
- [ ] `git diff --check` 无空白错误；所有 JSON 可解析；JS/MJS 通过 `node --check`。
- [ ] 完整 diff 已由至少一名非作者审查，尤其是抓取、汇率、事务、契约、workflow 和公开数据。
- [ ] gitleaks 对完整历史和候选树均为 0 finding。
- [ ] Unicode/bidi/replacement char、UTF-8、NFC path、case collision、mixed EOL 检查通过。
- [ ] tracked 文件 mode 符合预期；无可执行数据/前端文件、symlink、submodule 或异常大文件。
- [ ] `git fsck --strict` 通过；仓库与 `history.json` 容量未触发人工处置阈值。
- [ ] README、快照 README、第三方 notices、运维手册、发布清单和终验报告相互一致，内部链接有效。

## D. 运行时、依赖与供应链

- [ ] 使用 Node.js 22 的已校验发行包；记录完整版本和官方 SHA-256。
- [ ] 使用 `packageManager` 中 Corepack SHA-512 固定的 pnpm 10.14.0；记录 npm registry integrity 校验和错误 hash 失败探针。
- [ ] 在不复用旧 `node_modules` 的全新隔离目录执行 `pnpm install --frozen-lockfile --ignore-scripts`。
- [ ] lockfile 直接版本精确固定，所有 npm package resolution 有 SHA-512 integrity，无非预期 git/file/http 来源。
- [ ] `pnpm audit --audit-level low` 为 0 known vulnerabilities；outdated 结果已人工评估。
- [ ] 所有 GitHub Action 使用完整 40 位 SHA，注释 tag 与官方仓库 tag 指向一致。
- [ ] 官方 Action 自动合并只接受最多 20 个 workflow 文件、一对一 SHA 替换、精确 tested head/base 和匹配的官方 semver tag；超限/额外改动在 merge 请求前失败。
- [ ] actionlint 与 ShellCheck 对全部 workflow 通过。
- [ ] `pnpm test:vendor` 证明 Chart.js/Lucide 文件集、上游字节/icon node、SHA-256、实际使用和 notice 一致。
- [ ] `THIRD_PARTY_NOTICES.md` 和 `vendor/manifest.json` 版本、来源、许可、hash 一致。

## E. 核心、数据与抓取验收

在目标运行时和干净依赖目录中：

- [ ] `pnpm test:core`
- [ ] `pnpm validate:artifact`
- [ ] `pnpm validate:snapshots`
- [ ] `pnpm check:live`，结束后候选工作树 hash/diff 不变

结果核对：

- [ ] Apple 两条关联路径结果逐字段一致；若不是 `cross-checked`，已停止发布并人工调查。
- [ ] Apple HTML 5 MiB、FX JSON 1 MiB 响应上限和共享网络预算测试通过；不安全 Content-Length、无 stream 超限和非法 UTF-8 均失败关闭。
- [ ] 地区、容量、价格点、币种、发布日期和中文名称映射合理；所有新增/移除结构变化经过第二次无缓存抓取确认。
- [ ] 同币种/换币种价格异常、FX 导致至少 50% 派生 CNY 漂移、新市场相对中位数 20 倍离群、未来/倒退日期、重复键、不安全对象键、未支持容量单位和缺失价格均失败关闭。
- [ ] FX 时间、生产币种完整性、认证/open fallback 和 36 小时 stale 回退路径通过。
- [ ] schema 3 `prices.json` 精确字段集合通过；每个 plan 有正值、最多两位小数 `cnyPrice`。
- [ ] 所有公开文件都不包含 raw FX rates、API Key 值、Authorization header 或 API Key 配置/状态。
- [ ] `history.json` 与当前价格一致；发布日期变化可由相邻活动快照重算。
- [ ] snapshot index、`contentHash`、`dataSha256`、`firstConfirmedDate` 和精确文件集合一致。
- [ ] run log 最新运行与当前价格一致，数量不超过 retention。
- [ ] tar 在展开前后拒绝 traversal、绝对路径、重复路径、链接、设备、非 ustar、异常 mode、超限和额外文件。
- [ ] Linux CI 已实际执行 Windows 本地无法表达的 POSIX 权限测试；不得用本地 skip 代替。

## F. 前端功能与兼容性

- [ ] `pnpm test:browsers`：Chromium、Firefox、WebKit 的同一套 UI 验收全部通过。
- [ ] `pnpm test:ui`、`pnpm test:firefox`、`pnpm test:webkit` 各自确实运行完整 suite，不是仅设置环境变量后退出。
- [ ] 320、360、375、390、768、1024、1280、1440、1920 宽度无页面水平溢出。
- [ ] 价格加载、8 秒正文级超时、retry、慢网提示、有效 localStorage 回退、损坏缓存拒绝和历史可选降级正常。
- [ ] `prices.json` / `history.json` 分别执行 1 MiB / 8 MiB 流式上限、Content-Length 预检、redirect 拒绝和 fatal UTF-8；响应头先到但正文停滞时仍超时。
- [ ] 地区搜索、分区、容量、国家/价格排序、URL 状态恢复、最低价和并列处理正常。
- [ ] 地区历史、发布日期历史、延迟 Chart 加载、超长内容和窄屏 Dialog 正常。
- [ ] 资源 query version 与本次变更一致；HTML preload URL 和 module import URL 不冲突。
- [ ] JavaScript 关闭时显示明确 noscript 提示，不呈现误导性的完整工具状态。

## G. 可访问性与视觉验收

- [ ] html-validate 为 0 error / 0 warning。
- [ ] axe 在 Chromium 与 WebKit 的移动/桌面视口为 0 WCAG 2 A/AA、2.1 AA、2.2 AA 和 best-practice violation。
- [ ] Skip Link 在 Chromium、Firefox、WebKit/Safari 路径可聚焦并跳到价格区。
- [ ] 全站键盘可达；可见 focus；Dialog 初始焦点、Tab/Shift+Tab 循环、Escape 和关闭后焦点恢复正确。
- [ ] 原生控件有可感知 label/名称，表格 header/scope/caption/aria-sort 正确，动态状态可由辅助技术感知。
- [ ] 交互目标与相邻间距满足 WCAG 2.2；小尺寸仅限合规的行内文本链接情形。
- [ ] forced-colors 下边框、焦点、链接、按钮和“最低”文字可辨识，不只依赖颜色。
- [ ] `prefers-reduced-motion` 禁用非必要平滑移动/动画。
- [ ] 320px 和 1440px 最终截图已人工检查，未出现裁剪、覆盖、断词异常或瞬时 Chart canvas 溢出。
- [ ] Lighthouse 移动/桌面性能、可访问性、最佳实践、SEO 达到批准阈值；CLS/LCP/INP 或替代实验指标已记录。

## H. 隐私与应用安全

- [ ] 候选源代码、HTML、CSP、README 和 vendor 中没有 Google Analytics、GTM、Google Signals 或 Google 分析域。
- [ ] 初始 URL 只保留规范且去重的 `tier`、`sort`、`dir`、`region`；最多 160 个 code point 的 `q` 只进入内存，未知参数/fragment 在数据请求/分析执行前移除。
- [ ] meta 与 HTTP `Referrer-Policy` 均为 `origin`；子资源 Referer 不含路径、搜索词或未知参数。
- [ ] 前端不写 Cookie/sessionStorage/IndexedDB；localStorage 只保存通过 schema 3 验证的公共价格缓存。
- [ ] 已明确接受首次 document URL 仍可被浏览器/CDN/源站看到，且同 origin 页面可伪造格式合法 localStorage 的边界；否则迁移独立 origin 或删除持久缓存。
- [ ] 无 `innerHTML`、`outerHTML`、`insertAdjacentHTML`、`eval`、`new Function`、`document.write` 或字符串事件处理器。
- [ ] 动态值使用 `textContent`/DOM API；`target=_blank` 外链含 `noopener noreferrer`。
- [ ] CSP 不含 `unsafe-inline`/`unsafe-eval`/通配第三方；仅 allowlist 自有资源和 Cloudflare Beacon。
- [ ] 404 返回真实非 2xx，不回退为工具 HTML；JSON/JS/CSS MIME 和 `nosniff` 正确。

## I. GitHub 外部治理

- [ ] `main` 禁止删除、non-fast-forward 并要求 linear history。
- [ ] 已启用 PR 审查和 required status checks，至少要求完整验证 workflow；或项目所有者书面接受当前直接推送风险。
- [ ] Ruleset 对 GitHub Actions 自动数据发布有明确且最小化 bypass/例外，不赋予所有 workflow 或所有人广泛绕过权限。
- [ ] Actions 默认 workflow 权限、fork PR 权限和允许 Action 列表已复核。
- [ ] Secret 仅存在于需要的 repository/environment，持有人、轮换日和恢复联系人已记录。
- [ ] Cloudflare 外部 dispatch 凭据只可触发目标 workflow，已验证 08:05 主触发；08:10 GitHub 备用不会重复发布。
- [ ] 最近一次 update、validate、Pages 构建和 Dependabot 状态正常。
- [ ] 发布 commit 的签名/来源策略符合项目要求。

## J. Cloudflare、TLS、DNS 与缓存

- [ ] 工具路径 HTTP CSP 已更新为 [OPERATIONS.md](OPERATIONS.md) 的精确候选策略，无 Google 域。
- [ ] HTTP `Referrer-Policy: origin`，并保留 nosniff、DENY、Permissions Policy 和 HSTS。
- [ ] Cloudflare Minimum TLS Version 为 1.2；TLS 1.0 与 1.1 实际握手失败，TLS 1.2/1.3 成功。
- [ ] HTTP 到 HTTPS 只有一次同路径永久跳转；旧 `linchun7.github.io` 入口不经过主域 HTTP，或该风险已书面接受并计划修复。
- [ ] IPv4、IPv6、证书主机名/链/到期日正常。
- [ ] Cloudflare DNSKEY 与父区 DS 匹配，DNSSEC 验证链实际生效；或风险已由 DNS 管理员接受。
- [ ] HSTS preload 状态已复核；若仍 `pending`，已记录跟踪负责人和日期。
- [ ] HTML/JSON 与版本化静态资源缓存规则符合运维基线；没有缓存错误页或跨 MIME 内容。
- [ ] Cloudflare Web Analytics 自动注入开启且只产生预期 Beacon/同源 RUM；若关闭，CSP 同步收紧。
- [ ] 发布前已保存 Cloudflare/DNS 规则基线和回滚方法。

## K. 部署与部署后验证

- [ ] 候选通过正常 PR/合并路径进入 `main`；没有 force push、手工 JSON 拼接或直接生产编辑。
- [ ] GitHub Pages 部署成功；等待缓存 TTL 或对工具路径定向 purge。
- [ ] 生产 HTML 显示本候选的 `price-bootstrap.js`、CSS、module 和 data-contract 版本。
- [ ] JS/CSS/vendor/JSON SHA-256 与候选一致；Cloudflare 自动注入造成的 HTML 字节差异已解释。
- [ ] `prices.json` 是 schema 3；地区/容量/价格点、生成时间、Apple 日期、FX 时间与候选一致。
- [ ] 用带 `q` 和未知私密标记 URL 验证地址清理、Referer 和资源请求。
- [ ] 干净浏览器 Network 无 Google 请求；无新 `_ga` Cookie、GA 全局对象或未批准存储。
- [ ] 页脚只显示“本工具与 Apple Inc. 无关联，数据仅供参考。”和版权行，不显示已删除的统计服务说明或冗长商标措辞。
- [ ] Cloudflare Beacon 带预期完整性属性，`/cdn-cgi/rum` 成功且未要求放宽 CSP。
- [ ] Chromium、Firefox、WebKit 至少执行关键生产 smoke；控制台无应用 error/CSP violation。
- [ ] 键盘、Dialog、搜索、排序、历史、Chart、缓存回退和 320px 窄屏生产行为正常。
- [ ] 主页、`index.html`、data、核心 assets、favicon、真实 404、MIME、压缩和缓存响应均正常。
- [ ] HTTP/TLS/DNS/HSTS 检查通过。
- [ ] 手动执行或观察一次每日更新，确认生成、artifact、发布、幂等备用和 Healthchecks。
- [ ] 观察下一次完整只读三浏览器 workflow 成功。

## L. 回滚准备与发布签字

- [ ] 上一已知良好 commit 和完整 `data/` 已验证可回滚。
- [ ] 发布操作员有 `git revert` 和 Cloudflare 路径级规则恢复权限。
- [ ] 自动更新暂停方法、定向 purge 方法和事故联系人已现场确认。
- [ ] 回滚触发条件已约定：错误价格/历史、法律通知、Google/查询泄漏、白屏/CSP、严重安全头/TLS 回退、不可恢复数据损坏。
- [ ] 发布后观察窗口结束前，负责人保持可联系。

最终结论：

- [ ] **Go**：所有 P0/P1 和生产部署后门禁关闭。
- [ ] **No-Go**：存在未接受的 P0/P1 或候选尚未完成生产复验。
- [ ] **条件性 Go**：仅用于已书面接受、具有负责人/截止日期/回滚条件的残余风险。

签字：

| 角色 | 姓名 | 结论 | 时间（Asia/Shanghai） | 证据/审批记录 |
| --- | --- | --- | --- | --- |
| 项目所有者 |  |  |  |  |
| 发布操作员 |  |  |  |  |
| 法律/隐私 |  |  |  |  |
| GitHub 管理员 |  |  |  |  |
| Cloudflare/DNS 管理员 |  |  |  |  |
