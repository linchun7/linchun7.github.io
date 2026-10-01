# Apple 规范化快照

仅保存 Apple 价格页解析后的 JSON，不保存原始 HTML；Wayback 仅用于定位历史 Apple 证据，不是另一价格源。

- `YYYY-MM-DD.json` 为首次规范化内容；同发布日期不同内容用 `YYYY-MM-DD-<hash>.json`，不覆盖旧修订
- `index.json`（schema 2）记录 publishedDate、firstConfirmedDate、contentHash、dataSha256、dataFile 和来源
- publishedDate 是 Apple 原始发布日期；firstConfirmedDate 是证据能确认该修订的最早北京时间日期，不能以当前运行时间倒填
- 活动修订、当前价格和历史必须一致；不得手改索引或只复制单个 JSON 修复

历史导入在隔离环境中执行：`node scripts/import-apple-archives.mjs --input <目录>`（从项目目录运行）。输入须覆盖索引中除当前 live 日期外的全部既有发布日期，先验证后事务提交；不完整/冲突输入拒绝写入，失败或中断由恢复逻辑还原整组状态。

变更后通过 `pnpm test:data`、`pnpm validate:snapshots` 和 `pnpm validate:artifact`。日常发布及回滚见 [维护说明](../../OPERATIONS.md)。
