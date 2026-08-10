# Apple 页面快照

本目录只保存从 Apple iCloud+ 价格页面解析出的规范化 JSON。前端不直接读取这些文件；价格页、价格历史和发布日期记录使用经过校验的 `prices.json` 与 `history.json`。所有价格仍以 Apple Support 为唯一官方来源，仓库和运行附件均不保存 Apple 原始 HTML。

## 文件结构

- `YYYY-MM-DD.json`：规范化快照，包含 `schemaVersion`、发布日期、容量、地区、分区、币种和数值价格，不包含 Apple 页面结构或格式化价格文本。
- `YYYY-MM-DD-<hash>.json`：同一 Apple `Published Date` 的不同规范化内容修订；`hash` 是 64 位内容指纹的前缀。
- `index.json`：`schemaVersion: 2` JSON-only 索引。每个发布日期只有一个记录，可包含多个修订，并指向按 `firstConfirmedDate` 排序的活动修订。

索引修订中的关键字段：

- `publishedDate`：Apple 页面显示的官方发布日期，规范化为 `YYYY-MM-DD`。
- `firstConfirmedDate`：现有证据能够确认该修订版已经存在的最早北京时间日期，仅供内部追溯和校验，不在前端展示。
- `contentHash`：规范化容量、地区、币种和价格内容的 SHA-256 指纹，用于去重和识别同日修订。
- `dataSha256`：规范化 JSON 文件字节的 SHA-256，用于快速发现证据缺失或被修改。
- `dataFile`：规范化 JSON 文件名。
- `sourceUrl`：Apple Support 来源；`archiveUrl` 仅在历史导入的 Wayback 证据中存在。

## 生产更新

生产更新先完成 Apple 抓取、双解析器校验、发布日期和完整性校验、汇率校验及价格异常检查，再保存规范化 JSON。相同发布日期且内容指纹相同的页面不会重复保存；相同发布日期但规范化内容变化时，生成新的 `YYYY-MM-DD-<hash>.json` 修订，旧修订不覆盖也不手工删除。

JSON 通过同目录临时文件和硬链接排他落盘，`index.json` 使用原子替换；任一快照写入失败只清理本次计划创建的文件，外层更新器还会恢复价格、历史、运行日志和原索引文本。生产任务成功后，活动修订是该发布日期中 `firstConfirmedDate` 最新的修订。

`pnpm test:data` 会核对全部规范化快照的文件存在性与 `dataSha256`，并深度解析当前价格所引用的活动修订；缺少字节哈希的旧索引项也会自动执行深度校验。`pnpm validate:snapshots` 会逐个深度解析全部 JSON 修订，并由手动及每周只读工作流执行。`pnpm validate:artifact` 除了深验全部修订，还会校验精确文件集合、索引/current price/hash 关系，并从相邻活动快照重算 Apple 发布日期变化，核对 `history.json` 的跨文件语义；数据打包前和发布 job 解包后都会运行该验证器。

## 历史导入

当前仓库保留的 2024–2026 历史页面可离线导入（命令从 `tools/icloud_price_comparison/` 执行）：

```bash
node scripts/import-apple-archives.mjs --input <目录>
```

导入目录必须包含索引中除当前 live 日期以外的所有既有发布日期；空目录或不完整目录会在写入前拒绝，避免误删历史。导入器先尝试生产解析器，失败后才使用 `parse-legacy-archive.mjs`；通过解析、至少 60 个地区、价格完整性和快照去重校验后才会提交。

这里的“当前 live 日期”是 `data/prices.json.source.publishedDate` 规范化后的日期。

导入器只读取输入目录中的 HTML 用于离线解析，不把 HTML 复制到仓库。规范化 JSON、重建后的 `history.json` 和 `index.json` 任一环节失败，都会通过持久化事务日志删除计划创建的文件、恢复原历史和索引，并保留上一份有效数据；进程被强制终止后，下次运行会先恢复未完成事务。

Wayback 抓取时间只用于历史 Apple 页面排序、来源追溯和最早确认日期；导入时先换算为北京时间后写入 `firstConfirmedDate`。项目自动监测后的生产版本使用首次成功抓取的北京时间日期。Wayback 不是独立的价格来源。

## 维护规则

- 不要手工修改 `index.json`，也不要只复制单个快照文件进行重建。
- 重新导入前保留完整的 HTML 输入目录，并在隔离目录或 fixture 中测试；不要用生产数据做破坏性测试。
- 需要重建历史时，使用完整输入重新运行导入器，让它同时更新快照、历史和索引。
- 修改快照校验、索引格式或历史语义后，运行 `pnpm test:data`、`pnpm validate:snapshots` 和 `pnpm validate:artifact`。
