# iCloud+ 全球价格比较

线上页面：<https://linchun7.github.io/tools/icloud_price_comparison/>

本目录从 Apple Support 官方页面抓取 iCloud+ 月费，使用参考汇率换算人民币，并展示各地区价格、最低价和历史变化。

## 自动更新

工作流：`.github/workflows/update-icloud-prices.yml`

- 计划触发：每天北京时间 07:52（UTC 前一天 23:52）
- 选择 `:52`：避开常见整点和半点高峰，让排队后的实际运行尽量落在 08:30 以后
- GitHub 可能准时或延迟执行；Action 摘要会显示实际抓取时间和汇率发布时间

运行顺序：

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
- 汇率缺失时拒绝更新；汇率服务临时失败时沿用并标记上一份有效汇率。
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
- 汇率：[ExchangeRate-API](https://www.exchangerate-api.com/docs/free)

人民币金额仅用于横向比较，不代表 Apple 实际结算价。税费、可用性和购买区域限制可能不同。本工具与 Apple Inc. 无关联。
