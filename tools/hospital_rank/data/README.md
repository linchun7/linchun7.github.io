# 医院排名数据说明

本工具用于查询复旦版中国医院综合排行榜的历年记录、地区分布与医院历史名称；不把综合榜单等同于具体科室或个人就诊建议。

## 当前数据与来源

前端唯一正式数据源是 `rankings.json`。2009–2023 年历史基线共 **1,430 条记录、127 个医院实体**：2009 年 50 条、2010 年 80 条、2011–2023 年各 100 条。2009–2022 年为数字排名，2023 年为等级制。

主来源为复旦大学医院管理研究所中国医院排行榜在健康界的年度发布页：

`https://rank.cn-healthcare.com/fudan/national-general/year/{year}`

`source-snapshot.json` 是 2026-08-18 UTC 抓取并规范化的来源快照，**不保存原始 HTML**。只存在年度 URL 或页面标题，不代表该年度存在完整可用榜单；禁止复制旧年度数据充当新榜单。

`audit.json` 保留迁移核对、2011 年缺失数据恢复、名称来源及源站内部异常的审计证据。其 `summary` 描述生成时的迁移结果；后续实体订正见 `entityCorrections`，不得把原迁移的 128 家误作当前实体数。

## 医院实体与名称

`hospitals[]` 包含稳定 `id`（`h_<10位十六进制>`）、规范展示名 `name`、名称数组 `aliases`、当前地理元数据 `province` / `city`。年度记录以 `hospitalId` 关联同一医院，不以名称字符串直接拼接历史。

`sourceName` 是**抓取时该年度来源页面实际显示的院名**，不保证是当年首次发布时的院名。医院更名或实体归并不得改写它；前端搜索同时覆盖规范名、别名和来源名。

历史名称辅助证据来自复旦大学医院管理研究所 2011 年原始发布页：

`https://www.fdygs.com/news2011-2.aspx`

该辅助来源只用于别名和实体核验，不覆盖主来源的排名、分数、等级或 `sourceName`。

**中山大学孙逸仙纪念医院与中山大学附属第二医院是同一医院**，统一使用 `h_9da51a15c9`；2010–2023 年的 14 条记录属于同一历史。中山大学官方名称证据：

`https://rcb.sysu.edu.cn/article/754`（2026-06-23）

独立参加历史榜单的机构，不得仅因同属一个医院集团、现已改为某医学中心或名字相似而自动归并。

## 排名、等级与历史比较

`years[]` 每项包含整数 `year`、`rankingMode`（`numeric` / `grade`）、非空 `records[]`。每条记录都必须包含 `hospitalId`、`sourceName`、`rank`、`grade`、`specialtyReputation`、`researchAcademic`、`overallScore`。

正式数据必须显式包含上述字段；来源快照只要求相应制度实际提供的字段，不适用字段允许缺省或为 `null`，但不能出现虚构值。

数字排名必须是正整数，三项分数为有限非负数，`grade` 为 `null`。保留官方并列名次，例如 2009 年的 `27、27、29`，不强行重新连续编号。等级榜的数字名次和三项分数必须为 `null`，等级顺序固定为 `A++++、A+++、A++、A+、A`。

2023 年官方同一等级内不分先后。JSON 保留来源顺序；页面按各医院最近一次可用的数字排名作同等级辅助排列，**不代表当年名次**。不同制度之间不计算名次升降。

历史弹窗只显示本库收录的上榜记录。比较对象是上一条可用记录；跨越缺失年份时明确显示比较年份与“非同比”。不把缺失年度虚构成第 101 名、零分或连续年度变化。

## 来源分数异常

2014 年复旦大学附属儿科医院来源显示专科声誉 `8.984`、科研学术 `5.795`、综合得分 `14.799`。前两项之和为 `14.779`，相差 `0.020`。保留来源展示值 `14.799`，不自行“算对”后覆盖；异常记录在审计文件与该院历史弹窗中。

## 代码入口与失败边界

`index.html` 保存最新已收录年度的静态榜单；`script.js` 加载并校验 JSON 后启用筛选、排序和历史查询。无 JavaScript、加载中或加载失败时，筛选与排序控件禁用，防止控件所选年份与静态榜单不一致。网络失败、坏数据、响应正文超时保留静态榜单；没有静态榜单时显示可见错误提示。加载超时覆盖响应头和完整 JSON 正文。

`style.css` 控制等级/数字/全部年份的可见列。隐藏列仅针对正常数据行，不得隐藏跨列的空结果或错误提示。

## 校验与更新

从仓库根目录运行（依赖 Python 3 与浏览器测试目录的 Node.js / Playwright 环境）：

```bash
python -B tools/hospital_rank/scripts/validate_data.py
python -B tools/hospital_rank/scripts/test_contract.py
python -B tools/hospital_rank/scripts/test_future_year.py
python -B tools/hospital_rank/scripts/render_static.py
python -B tools/hospital_rank/scripts/render_static.py --check
```

校验器同时检查正式数据和来源快照的字段类型、数字范围、历史制度、记录顺序、逐值一致性、年份/医院引用/别名唯一性与 1,430 条历史基线完整性。来源中相同的错误值不能因为“两份文件相等”就通过校验。2023 年另外检查五档各 20 家。

`test_contract.py` 使用隔离临时数据检查坏值拒绝、官方并列与同院异名历史。`test_future_year.py` 动态选择当前最大年份之后的年度，测试连续新增年度的数字/等级榜及静态渲染，不修改正式数据。

浏览器验收先在仓库根启动仅本机可访问的静态服务器：

```bash
python -m http.server 4173 --bind 127.0.0.1
```

另一个终端运行 `node tools/browser-tests/hospital-rank-smoke.mjs`。通过环境变量 `PLAYWRIGHT_BROWSER=chromium|firefox|webkit` 分别检查三浏览器；`BASE_URL` 可覆盖默认的 `http://127.0.0.1:4173`，`PYTHON` 可指定解释器。该入口自动执行 `hospital-rank-regression.mjs` 和 Python 回归，已纳入现有静态工具 CI，无须另建流程。

新增正式年度必须同时更新正式数据与来源快照，核验实体与来源后通过上述检查。`render_static.py` 自动同步静态行、年份选项、标题、排名制度与资源内容版本。不得只改 JSON 不重建静态页面，也不得使用测试夹具发布新年度。
