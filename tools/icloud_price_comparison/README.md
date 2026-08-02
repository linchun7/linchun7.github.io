# iCloud+ 全球价格比较

线上页面：<https://linchun7.github.io/tools/icloud_price_comparison/>

本目录从 Apple Support 官方页面抓取 iCloud+ 月费，使用参考汇率换算人民币，并展示各地区价格、最低价和历史变化。

## 已实现功能

- 展示 Apple 官网公布的全部地区、币种和容量价格。
- 人民币参考价作为主价格，当地货币原价同时保留。
- 汇总各容量最低价，并标明对应地区。
- 支持地区搜索、分区筛选和容量排序。
- 点击地区查看价格历史、当地月费和涨跌比例。
- 显示 Apple 页面发布日期及发布日期变化记录。
- 发布日期变化时关联容量、地区、分区、币种和价格差异。
- 自动识别新增或移除的地区与容量，地区恢复后沿用原历史。
- 使用 Apple 中文页面名称映射，未知地区保留官方英文名。
- 显示加载、慢网络、失败重试、旧数据和旧汇率状态。
- 适配桌面、平板和手机，并支持键盘操作与减弱动画设置。
- 通过双解析器、异常价格校验、结构化日志和真实 Chrome 测试保护自动更新。

## 自动更新

工作流：`.github/workflows/update-icloud-prices.yml`

- Cloudflare 主触发：每天北京时间 08:05（UTC 00:05）。
- GitHub 原生备用：每天北京时间 09:05（UTC 01:05）。
- 两个入口共用每日幂等保护；当天已有自动成功记录且汇率为当天新数据时，备用任务直接跳过。
- 主任务失败、使用旧汇率或未成功提交时，备用任务仍会完整执行。手动运行不受每日保护限制。

汇率按以下顺序获取：

1. 使用 Actions Secret `EXCHANGE_RATE_API_KEY` 请求 ExchangeRate-API Key 接口。
2. 主接口额度用尽、请求失败、结构异常或缺少所需币种时，自动改用开放接口。
3. 两个在线来源都失败时，沿用并标记上一份有效汇率。

Secret 仅配置在仓库 **Settings > Secrets and variables > Actions**，不要写入代码、日志或数据文件。
Secret 缺失或无效但开放接口成功时仅显示普通提示；两个在线来源都失败时才显示警告。

完整更新的运行顺序：

1. 安装锁定依赖并运行固定 fixture、历史调价、工作流和数据测试。
2. 抓取 Apple 页面，由 `document-order` 和 `apple-markers` 两条路径独立解析。
3. 校验发布日期、地区、容量、价格、汇率和异常调价。
4. 原子更新 `data/`，再运行更新后的真实 Chrome UI 测试。
5. 提交数据并上传 Apple HTML 与诊断附件，附件保留 14 天。

UI 测试失败只产生警告，不阻断已经通过抓取和核心校验的数据；抓取、解析或数据校验失败会停止更新，并保留上一份有效数据。

## 数据文件

| 文件 | 内容 | 保留策略 |
| --- | --- | --- |
| `data/prices.json` | 当前价格、容量、来源、发布日期、汇率和运行时间 | 仅保留最新有效快照 |
| `data/history.json` | 地区价格/币种变化事件及 Apple 发布日期事件 | 只在真实变化时增长 |
| `data/run-log.json` | 成功运行的来源、数量、耗时和差异 | 最近 90 次 |

Apple 当前使用 `Published Date: July 17, 2026` 格式。解析、更新和前端均兼容完整标签、英文日期值及历史 ISO 日期值。

## 变化记录

| 变化 | 记录位置 | Action 摘要 |
| --- | --- | --- |
| 价格或币种 | `history.json`、`run-log.json` | 分别显示变化地区 |
| 新增或移除地区 | `run-log.json`，旧历史不删除 | 显示地区名称 |
| 所属分区变化 | `run-log.json` | 单独显示变化地区 |
| 新增或移除容量 | `run-log.json` | 显示容量名称 |
| Apple 发布日期 | `history.json.sourcePublishedDates`、`run-log.json` | 显示旧日期到新日期 |

发布日期未变化时，其他变化仍会记录和显示。`sourcePublishedDates` 仅在发布日期变化时追加，并保存同次容量、地区、分区、币种和价格差异。

## 核心保护

- 两套解析器一致时标记 `cross-checked`；单路失败可降级，两路分歧或同时失败则拒绝更新。
- 不使用非 Apple 价格源替代官方数据。
- 发布日期缺失、格式无效或倒退时拒绝更新。
- 地区重复、关键分区缺失、容量不完整或地区数异常下降时拒绝更新。
- 单项价格超过旧价 10 倍或低于旧价 1/10 时拒绝更新。
- 联合异常需同时满足 200% 涨幅、当地金额门槛、固定汇率人民币门槛和实际汇率人民币门槛才拒绝；人民币门槛为 `max(15 元, 上次人民币价值 × 50%)`。
- Key 接口和开放接口执行相同校验；两者都无法提供完整汇率时沿用并标记上一份有效结果。
- `history.json` 异常不阻断当前价格页，前端可在数据恢复后重新加载。

## 日常检查

在 **Actions > Update iCloud prices** 查看：

- 成功摘要：解析状态、地区/价格点数量、Apple 日期、汇率时间和本次变化。
- 黄色警告：UI 或非关键步骤需复核，核心数据可能已经成功提交。
- 红色失败：先看第一个失败步骤，再下载 `icloud-price-diagnostics-*`。
- `apple-response-*.html`：本次 Apple 原始页面。
- `run-report.json`：失败阶段、耗时和错误。

容量预警：Git 历史达到 500 MiB、800 MiB，或 `history.json` 达到 2 MiB。工作流不自动清理 Git 历史。

恢复数据时使用 Git 历史中的完整 `data/` 文件，不要手工拼接 JSON。

## 本地验证

需要 Node.js 22+、pnpm 和 Chrome/Chromium。

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm check:live
```

- `pnpm test`：固定数据、当前数据和真实浏览器测试；不访问 Apple，不写生产数据。
- `pnpm check:live`：只读访问 Apple 和汇率服务并执行校验，不写文件。
- `pnpm update:data`：写生产数据，仅用于明确的手动更新或隔离环境。

本地预览需从仓库根目录启动静态服务器：

```bash
python -m http.server 4173
```

访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## 数据来源

- 价格：[Apple Support](https://support.apple.com/en-us/108047)
- 中文名称：[Apple 中文支持](https://support.apple.com/zh-cn/108047)
- 汇率：[ExchangeRate-API](https://www.exchangerate-api.com/docs/overview)，开放接口作为自动回退

人民币金额仅用于横向比较，不代表 Apple 实际结算价。税费、可用性和购买区域限制可能不同。本工具与 Apple Inc. 无关联。
\n+## Apple 页面快照与历史导入

正式入口：<https://www.linchun.com.cn/tools/icloud_price_comparison/>。

`data/apple-snapshots/` 保存每个 Apple `Published Date` 的 HTML 证据、规范化 JSON 和 `index.json` 索引。`publishedDate` 是 Apple 官方日期；`firstConfirmedDate` 是本项目首次以北京时间确认该修订版的日期。Wayback 抓取时间只用于历史导入排序和来源追溯，不替代这两个日期。

同一发布日期且内容指纹相同的页面只保存一次；同一发布日期但价格、容量、地区或其他规范化内容发生变化，会保存为 `YYYY-MM-DD-<hash>.html/json` 新修订版，并正常更新 `history.json`。旧修订版不得覆盖或手工删除。

历史资料使用：

```bash
node scripts/import-apple-archives.mjs --input <包含完整历史快照的目录>
```

导入目录必须包含现有历史发布日期（当前 live 日期除外），空目录或不完整目录会拒绝。生产更新和历史导入均在校验完成后才写入；快照、历史或索引写入失败会回滚并保留上一份有效数据。详见 `data/apple-snapshots/README.md`。

## 全链路验证

```bash
pnpm test
pnpm test:core
pnpm check:live
pnpm audit --audit-level low
```

测试覆盖固定 fixture、旧版快照解析、双解析器一致性、发布日期和价格完整性、汇率主备、快照修订去重、失败回滚、工作流触发、真实 Apple 只读抓取和浏览器 UI。`check:live` 不写生产文件；`update:data` 才允许正式写入。
