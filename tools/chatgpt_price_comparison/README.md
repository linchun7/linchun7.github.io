# ChatGPT 全球价格对比

[打开价格页](https://www.linchun.com.cn/tools/chatgpt_price_comparison/)

比较 OpenAI 官方 ChatGPT 应用在各 iOS App Store 地区的公开内购标价；不代表官网或 Google Play 月费。覆盖范围由 `markets.json` 决定，实际价格、周期、资格和税费以购买页面为准，人民币值仅供比较。

## 数据与展示

- 唯一价格来源为 Apple 托管的[官方应用页面](https://apps.apple.com/us/app/chatgpt/id6448311069)：App ID 6448311069、开发者 ID 1684349733。结构化价格与可见 DOM 交叉核对，初次采集和变化另做独立确认。
- 套餐保留 Apple 原名；已知更名用明确身份规则保持历史连续，如 Pro 5x → Pro $100、Pro 20x → Pro $200，未知名称不按价格猜身份。同名多金额全部保留，主表取该套餐自身最低公开金额，不推断周期。人民币按核验汇率用 Decimal 折算到分。
- 最近通过校验的价格、人民币值、排名、最低价与历史不设展示期限；失败保留旧数据（retained）及真实价格核验/汇率源时间。无旧价时为 unavailable，未接受候选不参与比较，来源缺失不等于零价。
- 国家历史由 `history_baseline` 和真实变更组成；新套餐从首次有效观察开始，不用 `last_verified_at` 伪造起点，不裁剪已接受记录或推进基线。仅配置移除的市场退出当前历史，不以裁剪历史规避来源预算或线上大小门禁。
- 最低价历史只记录赢家地区集合变化，单纯人民币金额变化不新增换榜。事件、缺口和检查点须时间自洽，证据缺口不造事件；原因按前后覆盖市场所用币种的实际换算因子判断，无关币种变化不计入，部分汇率证据使用“汇率等因素”，既有事件不重写。
- 事件的 from/to 保留跨期事实；可选 `comparison` 保存事件同次可靠快照的旧/新赢家价格、汇率、观察时间及 revision，Git 回填另存来源 commit。页面箭头只用同期证据，缺价或未保存证据时明确标注，不借用最新价格。
- 页面使用本次打开的快照，不轮询、不显示相对年龄、不持久缓存价格；刷新页面才获取新版本。静态 HTML 在 JavaScript/网络失败时仍可读，内嵌快照经结构、时间和完整性校验后才启用交互。搜索保留排序表头，结果数按实际行数统计，覆盖数只计有标价地区；图标异步加载。
- 最低价历史按需读取，累计响应字节上限 2 MB，并严格校验 UTF-8。已验证历史的检查时间覆盖当前快照时，重复打开复用已有记录；刷新失败保留记录和真实截止时间，拒绝检查时间或检查点倒退。没有已确认观察时不伪造截止日期。
- 交互及返回可见标签页仅复核本机时钟，不请求新价格；打开的最低价历史独立复核时间。时钟回拨使记录明显处于未来时暂隐藏事件，纠正后恢复同一记录，不因此重新抓取；首次快照校验因未来时间失败仍需刷新页面。
- 历史关闭后回到可用的原触发按钮或对应替代按钮，均不可用时回到表格工作区；旧关闭事件不抢走后来设置的焦点。鼠标/触摸仅抑制国家历史按钮回焦轮廓；Tab、Enter 或无指针的辅助技术激活恢复键盘提示，Escape 保留最近输入方式。

## 更新与发布

[更新工作流](../../.github/workflows/update-chatgpt-prices.yml)：Cloudflare 北京时间 09:05 主触发、GitHub 09:10 兜底，也可在 main 手动运行。自动入口只有数据、历史和完整生产成功证明满足每日条件才跳过抓取并复验线上；手动不跳过。Cloudflare 启用状态需查看外部控制面。

- 普通调价和已知更名经双抓确认后接受；新增/移除/替换套餐、币种、多金额变体及极端调价进入持久 `pending`，至少 18 小时后再次确认。
- 覆盖不足丢弃整轮尝试价格。仅配置兼容完整旧基线且取得完整新汇率时整批重算，不混用部分新价；汇率也失败则保留原发布版本。
- 采集预算 240 秒，末尾 45 秒留给汇率。响应体按 64 KiB 分块，在块间及 EOF 后检查预算，超时不接受内容，非 chunked 响应的有效 Content-Length 用于完整性核验；单次 socket 阻塞空闲超时至多 15 秒。这不是整个 HTTP 请求的硬截止，响应头及 chunked framing 仍可能延迟检查。身份、格式、覆盖、时间及跨文件门禁不能放宽。
- prepare 固定最新 main，生成/测试 job 只读；发布 job 重验工件，原子提交 prices、minimum-history、index 三文件。main 前进即停止，不强推。
- 发布后等待 Pages，核验 canonical JSON、HTML build revision 和资源实际哈希。后继项目部署接管时旧验证标记 superseded，不当作恢复；`scripts/recheck-production.sh` 统一复核接管。
- 故障/降级维护同一条 Issue，保留首个失败步骤、原因样例和运行链接，真实恢复验证后才关闭。YAML 改变后从 main 新建运行，不重跑旧定义。

上游改版、信任根变化或全部套餐消失时保留旧数据并人工核验；公开页没有稳定产品 ID，未知更名/拆分/合并无法完全自动还原。

## 维护与排障

入口：`scripts/pipeline.py` 采集/汇率/校验/生成，`scripts/change_policy.py` 变更确认，`scripts/minimum_history.py` 账本与 Git 恢复，`scripts/daily_run_guard.py` 每日幂等，`scripts/verify-production.mjs` 线上验收。页面源为 `index.template.html`、`app.js`、`style.css`；`data/prices.json`、`data/minimum-history.json`、`index.html` 是整组生成产物，不手工改价；修改模板后重新生成 HTML。

运行环境 Python 3.10+、Node 22、pnpm 10.14.0，浏览器依赖以 package/lockfile 为准；基础开发与离线测试无需额外 API Key。测试在 [GitHub Actions](../../.github/workflows/validate-chatgpt-prices.yml) 执行，保留 Python 离线回归、候选校验、深度 fixture 和锁定 Playwright 的 Chromium/Firefox/WebKit 完整矩阵，main 另验实际部署。

从仓库根目录运行：

```sh
python3 -m unittest discover -s tools/chatgpt_price_comparison/scripts -p 'test_*.py' -v
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --output /tmp/chatgpt-candidate
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --check /tmp/chatgpt-candidate
node tools/chatgpt_price_comparison/scripts/browser-test.mjs
```

第二条访问来源并生成候选；浏览器测试读取检出数据，CI 先放入已验证候选。先看失败 run 和 Issue，区分来源、pending、汇率、工件、分支竞争及部署故障；短暂失败不删历史，pending 不直接改为 verified。账本异常需完整 Git 证据，无法可靠恢复就停止，不能清空过关。回滚 revert 整组生成文件，验证后发布，不只恢复一个 JSON。

人工提前接受仅支持 `plan_added`：独立双抓后临时创建 `reviewed-changes.json`，精确指定市场、旧/新指纹、pending 起点、证据 run 和不超过 48 小时有效期；过期或完成后删除。无全局 force，正式更新仍重抓并通过全部门禁，不匹配则恢复默认等待。

同期证据回填：从项目目录运行 `python3 scripts/enrich_minimum_comparisons.py --write`，只从完整 Git 第一父链精确匹配事件时间及 source_revision 的可靠 prices.json 回填；保留事件、归因、缺口和检查点，重复运行不改已有证据。`--report <path>` 导出来源及无法回填原因。命令只生成历史及对应 HTML，不抓 Apple、不改市场价格、不运行测试。

页面与 OpenAI、Apple 无关联。[第三方资源许可](THIRD_PARTY_NOTICES.md) · [汇率服务条款](https://www.exchangerate-api.com/docs/free) · [OpenAI 网页多币种说明](https://help.openai.com/en/articles/10421635-multicurrency-billing)
