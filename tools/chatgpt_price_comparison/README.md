# ChatGPT 全球价格对比

[打开价格页](https://www.linchun.com.cn/tools/chatgpt_price_comparison/)

比较 OpenAI 官方 ChatGPT 应用在各 iOS App Store 地区公开列出的内购标价，**不是官网或 Google Play 月费排行榜**。覆盖范围由 `markets.json` 决定；人民币金额仅供比较，实际价格、周期、资格及税费以购买页面为准。

## 数据与展示

- 唯一价格来源为 Apple 托管的[官方应用页面](https://apps.apple.com/us/app/chatgpt/id6448311069)：App ID 6448311069、开发者 ID 1684349733。结构化价格与可见 DOM 交叉核对；初次采集和变化另做独立确认。
- 套餐显示 Apple 当前原名；已知更名使用明确的稳定身份规则保持历史连续，例如 Pro 5x → Pro $100、Pro 20x → Pro $200。未知名称不按价格猜身份。
- 同名套餐多金额全部保留，主表仅取该套餐自身最低公开金额，不依赖其他套餐或推断周期。人民币按实际核验汇率用 Decimal 折算到分。
- 最近通过校验的价格、人民币值、排名、最低价与历史不设展示期限。更新失败仍显示旧数据；价格核验时间和汇率源时间保持真实，失败不刷新核验时间。
- 国家历史由 `history_baseline` 和真实变更组成，不用每天更新的 `last_verified_at` 伪造历史起点。新套餐从首次有效观察开始；旧记录超预算时只推进对应市场基线，完整证据仍在 Git 历史。
- 最低价历史独立记录赢家变化。降级或旧汇率形成证据缺口，不制造新事件；只有确认部分汇率影响时用简短“汇率等因素”。事件/缺口/检查点时间必须自洽，刷新失败保留已读取历史及真实截止时间；首次无可用历史才显示简短重试提示。
- 静态 HTML 保留无 JavaScript/网络失败时的表格；网络数据校验通过才接管，应用不新增持久价格缓存。

## 更新与防错

[Update ChatGPT prices](../../.github/workflows/update-chatgpt-prices.yml) 接受 Cloudflare 北京时间 09:05 主触发与 GitHub 09:10 兜底，也可在 main 手动 Run workflow。仅当数据、历史与完整生产成功证明满足每日条件，自动入口才跳过抓取并验证现有线上版本；手动运行不跳过。Cloudflare 实际启用状态需查看外部控制面。

- 普通调价和已知更名经双抓确认后接受；新增/移除/替换套餐、币种变化、多金额变体变化及极端调价进入持久 `pending`，至少 18 小时后再次确认。页面继续使用已接受旧价，未接受候选不参与比较。
- 来源失败时沿用旧价并保留原核验时间（`retained`），无旧价时 `unavailable`。覆盖门禁不足时丢弃整轮尝试价格；仅在配置与完整旧基线兼容且取得完整新汇率时整批重新折算，不混用部分新价。汇率也失败则保留原发布版本。
- 总网络预算 240 秒，其中末尾 45 秒留给汇率。格式、身份、覆盖率、未来时间及跨文件校验不能为“继续更新”而放宽。
- prepare 固定最新 main，独立生成/测试 job 只读。发布 job 重验工件，原子提交 prices、minimum-history、index 三文件；远端 main 前进即停止，不强推。
- 发布后等待 Pages，核验 canonical JSON、HTML build revision 和静态资源实际哈希；后继项目部署接管时旧验证标记 superseded，不能冒充恢复。
- 故障/降级维护同一条 Issue，更新首个失败步骤、原因样例及运行链接，不堆叠重复评论；真实恢复验证完成才关闭。新工作流定义已变时必须从 main 新建运行，不重跑旧 YAML。

公开页面不提供稳定产品 ID，未知更名/拆分/合并无法完全自动还原语义；上游改版、信任根变化或全部套餐消失时保留旧数据并要求人工核验，不将缺失解释为零价。

## 维护入口

- `scripts/pipeline.py`：采集、汇率、校验和静态生成
- `scripts/change_policy.py`：变更确认与隔离；`reviewed-changes.json`：精确人工提前批准
- `scripts/minimum_history.py`：最低价账本与 Git 证据恢复
- `scripts/daily_run_guard.py`、`scripts/verify-production.mjs`：幂等判断及线上验收
- `index.template.html`、`app.js`、`style.css`：页面源；`data/prices.json`、`data/minimum-history.json`、`index.html`：整组生成产物，不手工改价

测试在 [GitHub Actions](../../.github/workflows/validate-chatgpt-prices.yml) 执行：Python 离线回归、候选校验、Chromium 深度 fixture 及锁定 Playwright 的 Chromium/Firefox/WebKit 矩阵；main 还验证实际部署。运行环境 Python 3.10+、Node 22，浏览器依赖版本见 package/lockfile。基础开发与离线测试无需额外 API Key。

从仓库根目录使用以下维护入口：

```sh
python3 -m unittest discover -s tools/chatgpt_price_comparison/scripts -p 'test_*.py' -v
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --output /tmp/chatgpt-candidate
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --check /tmp/chatgpt-candidate
node tools/chatgpt_price_comparison/scripts/browser-test.mjs
```

第二条会访问来源并生成候选，不是离线测试；浏览器测试读取项目检出数据，CI 会先放入已验证候选。修改模板后重新生成 HTML，不能只改产物。回滚使用 revert 整组生成文件，验证后发布，不只恢复一个 JSON。

## 排障与人工确认

先读失败 run 的首个失败步骤及 Issue，区分来源失败、pending、汇率失败、工件错误、分支竞争与部署失败。来源短暂失败不需要删历史或隐藏旧价；pending 需要持续确认，不应直接改成 verified。最低价账本异常仅在需要时读取完整 Git 证据恢复，无法可靠恢复则停止，不能清空账本过关。

如确需提前接受已核验新增套餐：先独立双抓官方证据，再按 `reviewed-changes.json` 的精确市场、旧/新指纹、pending 起点、证据 run 和不超过 48 小时有效期填写。只支持 `plan_added`，无全局 force；正式更新仍重抓并执行全部门禁，任何不匹配回到默认等待。

仅保留本说明与第三方归属；过程、阶段报告及具体验收结果写 PR / Actions。页面与 OpenAI、Apple 无关联。[第三方资源许可](THIRD_PARTY_NOTICES.md) · [汇率服务条款](https://www.exchangerate-api.com/docs/free) · [OpenAI 网页多币种说明](https://help.openai.com/en/articles/10421635-multicurrency-billing)
