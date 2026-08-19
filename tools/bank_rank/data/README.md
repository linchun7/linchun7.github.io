# 中国银行业100强数据说明

本目录保存 `tools/bank_rank/` 的结构化数据。

## 第一版范围

当前已完成 **2023–2025** 三个年度、共 300 条记录的结构化和校验。中国银行业协会自 2016 年开始连续发布前100名单，`2016–2022` 已列为后续历史回填范围；在达到同等来源核验强度前，不把不确定数据写入正式榜单。

榜单按 **核心一级资本净额** 排序。`rankingYear` 是榜单发布年度，`dataYear` 是数据对应的年末年度，通常满足 `dataYear = rankingYear - 1`。例如 2025 年榜单使用 2024 年末数据。

## 文件结构

- `rankings.json`：数据清单、年份元数据、指标口径和年度文件路径。
- `banks.json`：稳定银行实体 ID、规范名、历史名称/别名和银行类型。
- `relations.json`：更名、新设合并等机构沿革事件。
- `years/{year}.json`：对应年度完整100强记录。
- `source-snapshot.json`：来源元数据、记录数、年度正式记录 SHA-256 和规范化说明。
- `audit.json`：实体治理、并列名次、规范化及特殊项审计。

前端先读取 `rankings.json`，再按清单加载银行实体、关系和年度记录。年度拆分后，回填 2016–2022 或增加未来年份不需要扩张一个巨型 JSON。

## 银行实体与更名/合并

年度记录通过稳定 `bankId` 连接，不直接依赖银行名称字符串。

纯更名属于同一法律主体，使用同一个 `bankId`，历史名称写入 `aliases`，必要时在 `relations` 中记录日期和来源。例如 `威海市商业银行` → `威海银行`。

合并、吸收合并、新设合并 **不等同于改名**。新主体不会自动继承前身机构的历史排名。海南农村商业银行的新设合并关系即按独立主体处理。

## 口径与并列排名

2023 年起榜单首次纳入外资法人银行，因此跨 2022/2023 比较需考虑参评范围变化。

榜单允许并列。2024 年瑞穗银行(中国)与花旗银行(中国)核心一级资本净额均为 210.20 亿元，并列第 95 名，下一名为第 97 名。validator 使用竞赛排名规则，不要求名次唯一。

## 校验与静态渲染

```bash
python tools/bank_rank/scripts/validate_data.py
python tools/bank_rank/scripts/test_future_year.py
python tools/bank_rank/scripts/render_static.py
python tools/bank_rank/scripts/render_static.py --check
```

`validate_data.py` 检查每年100条、年度/数据年度关系、稳定实体引用、名称/别名冲突、核心一级资本非增序、竞赛排名、官方汇总值，以及来源摘要中的年度 SHA-256 和元数据。

`test_future_year.py` 用合成未来年度验证新增年份无需修改 validator，并包含重复实体负例。

`render_static.py` 自动选择最大年份生成页面元数据与最新年度前20家无 JavaScript 静态预览；启用 JavaScript 后展示完整100强、年份切换、筛选、排序和历年排名。
