# 中国银行业100强数据说明

本目录保存 `tools/bank_rank/` 的结构化数据。前端只读取 `data/rankings.json`；`index.html` 同时保留最新年度静态快照，供无 JavaScript 场景和搜索引擎使用。

## 第一版范围

当前第一版已完成 **2023–2025** 三个年度、共 300 条记录的逐条结构化和校验。

中国银行业协会自 2016 年开始连续发布中国银行业前100名单，因此 `2016–2022` 已列入历史回填范围。旧年度官方页面/附件中完整表格的呈现方式并不统一，部分为图片或附件；在完成与当前年度同等强度的来源核验前，不把不确定数据写入正式 `rankings.json`。

## 数据来源与口径

第一方来源：中国银行业协会（CBA）。

- 2023：https://www.china-cba.net/Index/show/catid/14/id/42295.html
- 2024：https://www.china-cba.net/Index/show/catid/14/id/43906.html
- 2025：https://www.china-cba.net/Index/show/catid/14/id/45489.html

榜单按 **核心一级资本净额** 排序。`rankingYear` 是榜单发布年度，`dataYear` 是数据对应的年末年度，因此通常满足：

`dataYear = rankingYear - 1`

例如，2025 年榜单使用 2024 年末数据。

官方历史页面的完整100强表格部分以图片呈现。第一版的结构化表格输入采用公开可文本化转录，并使用中国银行业协会官方页面提供的榜单口径、机构类型数量、入围门槛和年度汇总值进行交叉验证。正式数据保留在仓库，不在用户访问页面时实时抓取第三方网站。

## 文件

- `rankings.json`：前端唯一正式数据源。包含稳定银行实体、历史名称、机构类型、关系事件和年度榜单。
- `source-snapshot.json`：本次结构化时使用的逐年文本快照及来源元数据，不保存原始 HTML。
- `audit.json`：数据校验、名称规范化、并列排名和实体治理记录。

## 银行实体与更名/合并

年度记录通过稳定 `bankId` 连接，不直接依赖银行名称字符串。

纯更名属于同一法律主体，使用同一个 `bankId`，历史名称写入 `aliases`，必要时在 `relations` 中记录更名日期和来源。例如：

- `威海市商业银行` → `威海银行`（2025-02-26 正式更名）。

合并、吸收合并、新设合并 **不等同于改名**。新主体不会自动继承前身机构的历史排名。例如海南农村商业银行由原海南省农村信用社联合社及19家市县法人农信社（农商银行）以新设合并方式组建，本项目将其作为新主体处理。

## 2023 口径变化

2023 年中国银行业协会首次将外资法人银行纳入排名。因此跨 2022/2023 比较时需要把参评范围变化作为背景信息；第一版前端已显示这一口径提示。

## 并列名次

榜单允许并列。2024 年瑞穗银行(中国)与花旗银行(中国)的核心一级资本净额均为 210.20 亿元，并列第 95 名，下一名为第 97 名。

validator 使用“竞赛排名”（competition ranking）规则，不要求 1–100 名次唯一。

## 校验

运行：

```bash
python tools/bank_rank/scripts/validate_data.py
python tools/bank_rank/scripts/test_future_year.py
python tools/bank_rank/scripts/render_static.py
python tools/bank_rank/scripts/render_static.py --check
```

`validate_data.py` 会检查：

- 每个正式年度恰好 100 条记录；
- `rankingYear` / `dataYear` 一致；
- 核心一级资本净额按非增序排列；
- 并列名次遵循竞赛排名规则；
- 银行 ID 和年度实体引用唯一；
- 规范名称与 aliases 不跨实体冲突；
- `rankings.json` 与 `source-snapshot.json` 逐条一致；
- 年度表格合计值按万亿元四舍五入后与中银协官方公布汇总值一致。

`render_static.py` 自动选择数据中的最大年份生成 `index.html` 最新年度静态榜单；新增年度后不需要手改默认年份。
