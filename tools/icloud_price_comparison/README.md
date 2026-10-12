# iCloud+ 全球价格比较

[打开价格页](https://www.linchun.com.cn/tools/icloud_price_comparison/) · [维护与排障](OPERATIONS.md)

比较 Apple 各地区 iCloud+ 当地月费及人民币参考价。价格、币种、容量和发布日期以 [Apple 英文价格页](https://support.apple.com/en-us/108047) 为准；中文名称仅用人工核对的 [Apple 简体中文价格页](https://support.apple.com/zh-cn/108047) 原文，不自行翻译或猜配，缺失或不确定时保留英文。税费、付款资格和最终结算以 Apple 为准。

## 使用与数据

- 默认按 200GB 人民币价升序，不存在则取首个容量。价格用生成器的全球排名，筛选不重排名；国家排序显示当前列表序号。最近通过校验的价格、人民币值、排名、最低价与历史不设展示期限，失败保留旧值和真实价格核验/汇率源日期。
- 静态表格与安全转义的紧凑内嵌 JSON 来自同一价格产物；校验后启用交互，启动不请求 prices.json。坏内嵌数据保留只读静态表，明显未来的价格暂不作为当前价；刷新按钮重新加载整页。国家、发布日期及最低价历史按需读取，发布日期从历史投影，图标异步加载。
- 搜索经 NFKC 规范化，支持 marketId、中英文名称、地区和完整币种代码。URL 只保存容量、排序及地区筛选，不存搜索词；地址同步失败不阻塞交互。页面不轮询新价、不因年龄禁用价格，应用不持久缓存价格。
- 国家历史与最低价历史独立；容量下架/恢复和证据缺口不造虚假涨跌，不同步的历史不推算当前涨跌。已验证最低价历史的检查时间覆盖页面快照时重复打开复用；刷新失败保留记录及真实截止时间，拒绝检查时间或检查点倒退。
- 交互及页面可见/恢复时仅本地复核系统时钟。打开的最低价历史独立复核时间；时钟回拨使记录明显处于未来时暂隐藏事件，纠正后恢复同一记录，不重新抓取。
- 历史关闭后回到可用的原触发按钮或对应替代按钮，均不可用时回到表格工作区；旧关闭事件不抢走后来设置的焦点。鼠标/触摸只抑制国家历史按钮回焦轮廓，Tab、Enter 或无指针辅助激活恢复键盘提示，Escape 保留最近输入方式。

## 数据与代码入口

- `data/prices.json`：已核验当前价格及全球排名
- `data/history.json`、`data/minimum-history.json`：原币价格/发布日期历史、最低价账本
- `data/apple-snapshots/`：规范化 Apple JSON 证据，见[快照说明](data/apple-snapshots/README.md)
- `data/run-log.json`：最近 90 次成功运行
- `scripts/update-prices.mjs`、`data-contract.js`：生成入口及共享数据契约
- `scripts/market-registry.mjs`、`scripts/country-names.zh.json`：稳定身份及人工中文映射
- `scripts/static-page.mjs`、`scripts/render-static-page.mjs`：静态生成源

发布前的页面与暂存 Git tree 使用同一严格投影门禁：仅允许校验价格生成区域及由该价格确定的六处 SEO/品牌文案变化，容量变化不会放宽 CSP、脚本引用或其他页面内容。生产日期断言跟随已校验历史投影，固定日期语义在临时合成工件中验证。

`index.html` 为生成产物。`seoProjection()` 维护 `ICLOUD_STATIC_*` markers 外的 SEO Projection，不直接改生成结果；JS/CSS 变化用内容哈希更新资源版本。关键契约、生成器或发布规则变化需同步本说明及 OPERATIONS。

## 更新与验证

- [更新价格](../../.github/workflows/update-icloud-prices.yml)：Cloudflare 主触发约北京时间 08:05，GitHub 08:10 兜底；手动选择 main
- [完整验证](../../.github/workflows/validate-icloud-price-comparison.yml)：核心、工件、全部快照、依赖安全及锁定 Playwright 的 Chromium/Firefox/WebKit；main 代码提交再验线上数据、页面和资源哈希
- [中文名称监测](../../.github/workflows/monitor-icloud-zh-markets.yml)：提醒人工核对，不自动绑定身份

自动入口只有当日完整生产成功证明才跳过，手动不跳过。上游失败保留已发布数据；汇率降级不发健康心跳，也不跳过自动重试。Cloudflare 触发、DNS 和安全头需查看控制面，不能由仓库文字证明。

运行环境 Node.js >=22.1.0、pnpm 10.14.0，依赖以 package/lockfile 为准。项目目录内的验证入口：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
pnpm test:browsers
pnpm audit --audit-level low
```

定向生成/检查：`pnpm render:static`、`pnpm render:static:check`、`pnpm assets:update`、`pnpm assets:check`。日更使用锁定 Playwright 配套 Chromium。`pnpm check:live` 为只读在线诊断，`pnpm update:data` 会写数据，不用于试探排障。

## 来源、隐私与许可

汇率来自 ExchangeRate-API，认证源不可用时尝试[开放源](https://open.er-api.com/v6/latest/USD)。页面加载 GA4 和 Cloudflare Web Analytics；加载前清理搜索词及非法 URL 参数，GA4 可能写统计 Cookie。

本工具与 Apple Inc. 无关联。自有代码见 [LICENSE](LICENSE)，第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
