# iCloud+ 全球价格比较

静态价格比较工具。每天从 Apple Support 的公开页面读取 iCloud+ 月度价格，在浏览器中按容量比较不同国家和地区，并保存价格变化历史。

## 功能

- 同表比较 50 GB、200 GB、2 TB、6 TB 和 12 TB 月度价格
- 点击任一容量表头，按折合人民币价格升降序排列
- 每个价格同时显示人民币换算值和 Apple 当地货币原价
- 搜索国家、地区或币种，并按大区筛选
- 使用每日参考汇率换算成人民币后排序
- 点击国家或地区查看各容量价格历史
- 只在当地价格或币种发生变化时追加历史事件
- Apple 页面结构异常或价格变化异常时终止更新，保留上一份有效数据
- 网络请求使用超时、五次退避重试和响应内容检查
- 更新失败时上传诊断文件，便于分析 Apple 页面结构变化
- Apple 新增且五档价格完整的国家或地区会自动进入下一份数据
- 桌面和手机响应式布局

## GitHub 首次配置

1. 将整个仓库推送到 `linchun7/linchun7.github.io` 的 `main` 分支。工作流必须位于仓库根目录的 `.github/workflows/update-icloud-prices.yml`，工具目录必须是 `tools/icloud_price_comparison`。
2. 打开仓库 **Settings > Pages**，在 **Build and deployment** 中选择 **Deploy from a branch**，分支选择 `main`，目录选择 `/(root)`，然后保存。
3. 打开 **Settings > Actions > General**。在 **Actions permissions** 中允许仓库使用本工作流引用的 Actions；在 **Workflow permissions** 中选择 **Read and write permissions** 并保存。
4. 如果 `main` 设置了分支保护或 Ruleset，需要允许 GitHub Actions 写入该分支；否则抓取可以成功，但最后的自动提交会失败。
5. 打开 **Actions > Update iCloud prices**，点击 **Run workflow**，分支选择 `main`，手动运行第一次抓取。
6. 等待运行结束。绿色表示抓取、校验、测试和数据提交全部成功；随后确认仓库中出现由 `github-actions[bot]` 创建的 `chore: update iCloud prices` 提交。
7. 访问 `https://linchun7.github.io/tools/icloud_price_comparison/`，核对页面日期、地区数量以及至少一个当地价格。

工作流不需要 API Key 或 GitHub Secret。GitHub 的定时任务可能比设定时间延迟数分钟，属于正常情况。

## 自动更新

工作流位于仓库根目录的 `.github/workflows/update-icloud-prices.yml`，每天北京时间 12:00 运行（GitHub 可能有几分钟排队延迟），也可以在 GitHub Actions 页面手动运行。

首次使用前，在仓库的 **Settings > Actions > General > Workflow permissions** 中选择 **Read and write permissions**。工作流会：

1. 下载并解析 Apple 的公开价格页。
2. 校验国家数量及五档容量是否完整。
3. 与上一份有效数据比较，拦截国家数量骤降或异常价格跳变。
4. 获取以 USD 为基准的公开参考汇率；失败时保留上一份汇率。
5. 更新 `data/prices.json`。
6. 仅在价格变化时更新 `data/history.json`。
7. 运行测试并把数据提交到 `main` 分支。

Apple 请求最多尝试五次，等待时间逐步增加。所有校验通过后才会原子写入数据文件；失败时旧价格不会被覆盖，并会在该次 Actions 运行中保留 14 天诊断附件。

生产页面优先读取同域 GitHub Pages 数据，避免部分网络环境无法访问 `raw.githubusercontent.com`；同域数据读取失败或结构异常时，再回退到仓库 `main` 分支的原始 JSON。每个数据请求都有超时限制，历史文件异常也不会阻止主价格表显示。

## 数据保存与运行状态

- `data/prices.json`：最近一次成功抓取的完整价格与汇率。
- `data/history.json`：各国家和地区的价格变化事件；价格不变时不会重复追加。
- Git 提交历史：自动任务每次成功后都会提交 `data` 目录，因此可以查看任意一天的完整快照。
- `artifacts/`：失败诊断文件，不提交到仓库；GitHub Actions 会把它作为附件保留 14 天。

在 GitHub 仓库的 **Actions > Update iCloud prices** 中查看每次运行：

- 绿色运行：摘要会显示国家数量、价格数量、Apple 页面日期和汇率日期。
- 红色运行：展开 **Fetch and validate prices** 查看直接错误；在页面底部下载 `icloud-price-diagnostics-*` 附件。
- `update-failure.json` 保存失败时间、错误信息和调用栈。
- `apple-response.html` 仅在已经取得页面但解析或校验失败时生成，便于定位 Apple 的结构变化。

## 本地运行

需要 Node.js 22 或更高版本以及 pnpm。

```bash
pnpm install
pnpm test
pnpm check:live
pnpm update:data
```

`pnpm check:live` 会真实访问 Apple 和汇率接口并执行全部校验，但不会修改价格或历史文件。`pnpm update:data` 才会在校验成功后写入数据。

用任意静态服务器打开本目录即可预览。例如在仓库根目录运行：

```bash
python -m http.server 4173
```

然后访问 `http://127.0.0.1:4173/tools/icloud_price_comparison/`。

## 数据说明

- 当前价格来源：[Apple Support](https://support.apple.com/en-us/108047)
- 中文名称参考：[Apple 中文支持](https://support.apple.com/zh-cn/108047)。中文页更新较慢，未收录的新增地区使用规范中文名。
- 每日参考汇率来源：[ExchangeRate-API](https://www.exchangerate-api.com/docs/free)
- 历史基线来自本工具原有的 2024-12-08 数据，此后按实际检测到的价格变化追加
- 汇率换算仅用于跨币种比较，不代表结算价格
- Apple 的税费、服务可用性及购买区域限制可能因国家和地区而异

本工具与 Apple Inc. 无关联。
