# ChatGPT 各国价格对比

比较 **iOS App Store 公开列出的内购标价**，不是官网月费排行榜。代码位于 `tools/chatgpt_price_comparison/`，入口为工具导航。

## 数据口径

- 只采集 Apple 托管的 OpenAI 官方应用页面，应用 ID `6448311069`、开发者 ID `1684349733`。`markets.json` 配置 60 个待核验地区，不宣称覆盖全球全部市场。
- 国家/地区、当地币种、原始金额文本、来源链接及核验时间一并保留。新的 `ChatGPT ...` 项目名自动保留，非此类的积分等项目只记录未分类名称。
- 同名项目的全部金额并列显示。**不根据金额大小推定月付、年付、促销或新购资格**，不计算月费排名、节省比例或推荐购买地区。
- 网页订阅与 Google Play 的地区价格尚未接入：目前 GitHub 运行环境无法稳定读取官网定价页；不把美国标价的汇率换算伪装成各国官网价格。
- 人民币是参考金额：`当地金额 ÷ 每美元当地货币汇率 × 每美元人民币汇率`，使用 Decimal 计算到分，非最终结算价。汇率来源为 ExchangeRate-API，页面保留其署名。

官方说明：[OpenAI 多币种计费](https://help.openai.com/en/articles/10421635-multicurrency-billing) · [官方应用](https://apps.apple.com/us/app/chatgpt/id6448311069) · [汇率使用规则](https://www.exchangerate-api.com/docs/free)。

## 自动更新与防错

生产自动更新采用主备：**Cloudflare 每日北京时间 08:25** 外部调用 `workflow_dispatch`（`trigger_source=cloudflare`）作为主触发，**GitHub cron 08:30** 仅作兜底；也支持手动运行。两个自动入口先校验当前 `prices.json`：若北京时间当天已发布按当前数据契约判定为非降级、且汇率仍新鲜的数据，备用触发直接跳过；若存在 `retained` / `pending`、fallback 汇率、旧数据或主触发未成功发布，则继续重试。手动运行不受每日幂等跳过。仓库只能验证这一调度契约，不能单独证明 Cloudflare 控制面的实时启用状态。

1. 只读任务运行离线测试、抓取、数据校验与真实 Chrome 测试。无需 API Key、登录态、付费服务、数据库或第三方 Python/Node 包。
2. 校验应用身份、canonical 地区和币种；可见价格必须与两种结构化表示一致。它们是**同一来源的交叉校验**，不是三个独立价格源。初次采集和改价另发一次不使用缓存的确认请求。
3. 并发上限 4，单请求超时最多 15 秒，最多 3 次尝试；请求体上限 4 MB。240 秒后不再启动来源请求，工作流另有整体超时。只允许 HTTPS 官方来源及同一路径的语言重定向。
4. 某地区失败保留上次金额及原核验时间，单独更新检查时间。异常大幅变价、币种变化或项目数骤减先暂存指纹，至少 18 小时后仍一致才自动接受，不要求每天人工审批。
5. 本轮新核验数量不得低于已有有价地区数的 80%（且至少 10 个）；有价覆盖不得低于配置数的 60%。严重降级直接拒绝发布，保留整份原数据。
6. 汇率失败最多沿用 7 天并标明旧汇率。价格超过 36 小时标记旧价；价格或汇率超过 7 天隐藏人民币换算。浏览器不持久缓存价格，拒绝校验不通过或时间倒退的更新。
7. 独立发布任务重新校验工件，JSON 与静态 HTML 同一个 Git 提交发布。只改自身的两份生成文件；远端分支前进即拒绝推送，不强推、不重放旧数据覆盖其他会话。
8. 主分支发布后主动请求 Pages 构建，再从公开站点核对 JSON 与 HTML 的数据版本。故障或部分降级自动创建一条未关闭 Issue，持续失败不重复创建，恢复后自动关闭。

正常变价、汇率更新、短暂网络失败与恢复无需人工处理。上游长期改版、来源撤下、GitHub 权限或调度中断仍可能需要维护；不能保证永久零人工。

## 文件与验收

- `scripts/pipeline.py`：采集、校验、状态、汇率、静态渲染。
- `scripts/daily_run_guard.py`：CF/GitHub 自动主备的每日幂等门禁；不增加数据库或额外状态文件。
- `index.template.html`、`app.js`、`style.css`：静态页面与无框架交互。
- `data/prices.json`、`index.html`：自动生成，不手工改价。数据包含最近 200 条标价变动，不把汇率波动记录为套餐改价；更早版本见 Git 历史。
- `scripts/test_pipeline.py`：离线回归；`scripts/browser-test.mjs`：Chrome 实测。浏览器测试覆盖重复金额、搜索、空结果、窄屏、过期、JSON 失败回退与无 JavaScript。

```sh
python3 -m unittest discover -s tools/chatgpt_price_comparison/scripts -p 'test_*.py' -v
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --output /tmp/chatgpt-candidate
python3 tools/chatgpt_price_comparison/scripts/pipeline.py --check /tmp/chatgpt-candidate
node tools/chatgpt_price_comparison/scripts/browser-test.mjs
```

浏览器测试读取项目目录下的数据；更新工作流会先把候选两文件复制到只读任务的临时检出目录再测试。要求 Python 3.10+、Node 22 和已安装的 Chrome/Chromium，可用 `CHROME_BIN` 指定。

修改模板后必须重新生成 HTML；回滚时将 JSON 与 HTML 作为一组恢复。不要只回滚其中一个文件。现有 iCloud 的代码、数据和工作流不受此项目修改。
