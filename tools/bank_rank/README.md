# 中国银行业100强榜单

静态查询工具，展示中国银行业协会按核心一级资本净额排序的历年榜单。支持年度、银行类型和名称筛选，按稳定银行实体查看历史排名与机构沿革。当前仓内范围为2016–2025年，127个银行实体、1000条年度记录；不据当前日期自动推断新年度榜单已经发布。

## 维护入口

- `data/README.md`：来源分级、年度口径、冻结交叉核验、已知证据缺口和数据维护规则。
- `script.js`：清单与数据校验、索引、筛选排序、弹窗和失败回退。
- `scripts/validate_data.py`：离线数据契约及年度摘要校验。
- `scripts/validate_verification.py`：证据台账与外部冻结榜单交叉核验。
- `scripts/render_static.py`：生成最新年完整静态100强及CSS/JS内容版本。
- `../browser-tests/bank-rank-smoke.mjs`：CI入口，同时运行Python契约测试和扩展浏览器回归。

## 展示边界

榜单年不等于财务年或实际发布日期；财务年为榜单年的上一年。主表保留当年原始银行名称。纯更名保持同一实体；新设合并不能直接继承前身排名。别名兼容全称和简称，不代表都发生过法律更名。海南农商银行的全称“海南农村商业银行”由`relations.json`中的银行官方成立公告佐证。

“较上年”只比较相邻榜单年。已收录上年但该银行不在榜内时，依据更早记录显示“上年未上榜”或“首次记录”；整个上年未收录时显示“上年未收录”，不推断银行落榜。“首次记录”仅指本工具已有数据中的最早记录，不宣称该银行历史上首次入榜。2023年起纳入外资法人银行，跨年度排名还受参评范围影响。

无JavaScript或动态请求失败时，保留最新年完整静态100强并禁用交互。动态数据必须先通过完整性、数值、实体、路径与沿革来源检查，才替换静态表；初始化中途失败也恢复原来的完整静态视图。这里的运行时检查防止格式错误和实体错配，不替代原始来源审计。

## 本地验证

从仓库根目录运行，使用Python 3.10或更高版本，以及`tools/browser-tests/package.json`规定的Node版本。正式JSON、外部冻结快照和审计台账不是测试夹具，不直接写入破坏性测试数据。

```bash
python tools/bank_rank/scripts/validate_data.py
python tools/bank_rank/scripts/validate_verification.py
python tools/bank_rank/scripts/test_contract.py
python tools/bank_rank/scripts/test_future_year.py
python tools/bank_rank/scripts/render_static.py
python tools/bank_rank/scripts/render_static.py --check
```

首次浏览器验证需在`tools/browser-tests/`安装该目录声明的Playwright及对应浏览器。另开一个终端，从仓库根目录运行`python -m http.server 4173 --bind 127.0.0.1`，再在原终端执行：

```bash
PLAYWRIGHT_BROWSER=chromium node tools/browser-tests/bank-rank-smoke.mjs
PLAYWRIGHT_BROWSER=firefox node tools/browser-tests/bank-rank-smoke.mjs
PLAYWRIGHT_BROWSER=webkit node tools/browser-tests/bank-rank-smoke.mjs
```

以上环境变量语法适用于Bash。PowerShell使用`$env:PLAYWRIGHT_BROWSER='chromium'`后运行同一Node命令，另外两种浏览器同理。`BASE_URL`可指定独立本地服务端口。测试结束关闭自己启动的服务，不终止其他项目服务。

## 新年度与发布

本项目没有自动定时抓取银行榜单的任务。新增年份必须先取得可复核的正式发布材料，按`data/README.md`更新年度文件、清单、实体及关联证据，再运行全部校验和静态生成。不得从自己的生产JSON反向复制外部交叉快照，不得为通过校验编造官方来源、日期或补充覆盖。

发布前审阅本工具及对应测试的差异，运行`git diff --check`。HTML必须随生成后的CSS/JS内容版本一起提交。已有三浏览器CI使用上述smoke入口，不需要另建重复工作流。提交、PR、合并及上线须有相应用户授权；本地测试通过不等于线上已经发布。
