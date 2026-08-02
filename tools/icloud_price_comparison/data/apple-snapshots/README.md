# Apple 页面快照

本目录保存 Apple iCloud+ 价格页面的可追溯证据。前端不直接展示这些文件；价格页面、历史记录和发布日期记录使用经过校验后的结构化数据。

## 文件结构

- `YYYY-MM-DD.html`：Apple 页面原始 HTML。
- `YYYY-MM-DD.json`：与 HTML 对应的规范化地区、容量、币种和价格。
- `YYYY-MM-DD-<hash>.html/json`：同一 Apple `Published Date` 的已验证修订版，文件名中的 hash 是内容指纹前缀。
- `index.json`：快照索引。每个发布日期只有一个记录，可包含多个修订版，并标记当前活动修订。

索引中的关键字段：

- `publishedDate`：Apple 页面显示的官方发布日期。
- `firstConfirmedDate`：本项目首次确认该修订版的北京时间日期。
- `contentHash`：规范化价格内容指纹，用于去重和识别同日修订。
- `file` / `dataFile`：HTML 证据和 JSON 数据文件名。
- `archiveUrl`：Wayback 来源地址（历史导入时存在）。

## 导入与生产保存

2024 至 2026 年的历史页面可通过 `scripts/import-apple-archives.mjs --input <目录>` 离线导入。输入目录必须包含现有历史发布日期（当前 live 日期除外）；空目录或不完整目录会被拒绝，避免误删历史。

历史导入使用旧版解析器，生产更新仍只使用生产解析路径。未来检测到新的 Apple 发布日期时，生产任务会在解析、双路径校验、完整性、汇率和价格异常检查全部通过后，同时保存 HTML、JSON 并更新 `index.json` 与价格历史。

同一发布日期、同一内容不会重复保存；同一发布日期但价格、容量、地区或其他规范化内容不同，会生成新的 hash 修订版并正常进入价格历史。旧 HTML/JSON 不覆盖、不手工删除。

快照写入采用临时 staging 目录；HTML、JSON、历史和索引任一环节失败，正式目录会回滚并保留上一份有效数据。

Wayback 的抓取时间仅用于历史导入排序和来源追溯；历史导入会将其换算为北京时间后写入 `firstConfirmedDate`，不把 UTC 日期直接当作确认日期。前端展示以 Apple 官方 `publishedDate` 和项目 `firstConfirmedDate` 为准。

请勿手工修改 `index.json`，也不要只复制单个快照文件进行重建；应保留完整目录后再运行导入工具。
