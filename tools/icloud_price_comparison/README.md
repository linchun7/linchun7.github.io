# iCloud+ 全球价格比较

[打开价格页](https://www.linchun.com.cn/tools/icloud_price_comparison/) · [维护与排障](OPERATIONS.md)

比较 Apple 各地区 iCloud+ 当地月费及人民币参考价。价格、币种、容量和发布日期以 [Apple 英文价格页](https://support.apple.com/en-us/108047) 为准；中文名称只使用人工核对的 [Apple 简体中文价格页](https://support.apple.com/zh-cn/108047) 原文，不自行翻译或自动猜配；来源缺失或对应关系不确定时保留英文。人民币金额仅供比较，税费、付款资格和最终结算以 Apple 为准。

## 展示规则

- 默认按 200GB 人民币价格升序；该容量不存在时使用首个容量。价格排名使用生成器给出的全球排名，筛选不重排名；国家排序显示当前列表序号。
- 最近通过校验的价格、人民币折算、排名、最低价与历史不设展示期限。更新失败仍显示旧数据，价格核验日期和汇率源日期保持真实。
- 非法、损坏或明显未来的数据仍被拒绝。静态 HTML 提供无 JavaScript/网络失败时的价格兜底；通过校验的 JSON 才接管交互，网络响应不能回退到更早快照。
- 搜索经 NFKC 规范化，支持 marketId、中英文名称、地区和完整币种代码。URL 只保存容量、排序和地区筛选，不保存搜索词；无变化时不重复写入地址栏，浏览器拒绝地址同步也不阻塞表格交互。价格不写浏览器持久缓存。
- 图标异步加载，加载缓慢或失败不阻塞搜索、排序及历史交互。
- 国家价格历史与最低价历史独立；容量下架、恢复及证据缺口不合并为虚假涨跌。已读取历史在刷新失败时保留并显示真实截止时间；不同步的历史不用于推算当前涨跌。

## 数据与代码入口

- `data/prices.json`：已核验当前价格与全球排名
- `data/history.json`、`data/minimum-history.json`：原币价格/发布日期历史、最低价变化账本
- `data/apple-snapshots/`：规范化 Apple JSON 证据；格式见[快照说明](data/apple-snapshots/README.md)
- `data/run-log.json`：最近 90 次成功运行
- `scripts/update-prices.mjs`、`data-contract.js`：生成入口与共享数据契约
- `scripts/market-registry.mjs`、`scripts/country-names.zh.json`：稳定市场身份及人工中文映射
- `scripts/static-page.mjs`、`scripts/render-static-page.mjs`：静态页面生成源

`index.html` 是生成产物。除 `ICLOUD_STATIC_*` 区域外，`seoProjection()` 还维护 markers 外的 SEO Projection；不要直接改生成结果。修改 JS/CSS 后需同步内容哈希资源版本。

## 自动更新与验证

GitHub Actions 执行测试和发布：

- [更新价格](../../.github/workflows/update-icloud-prices.yml)：Cloudflare 主触发约北京时间 08:05，GitHub 08:10 兜底；手动运行选择 main
- [完整验证](../../.github/workflows/validate-icloud-price-comparison.yml)：核心、工件、全部快照、依赖安全及 Chromium / Firefox / WebKit；main 代码提交随后复验实际线上数据、页面和资源哈希
- [中文名称监测](../../.github/workflows/monitor-icloud-zh-markets.yml)：只提醒需要人工复核的名称，不自动绑定中英文市场

自动入口只有取得当日完整生产成功证明才跳过；手动更新不跳过。上游失败保留已发布数据；汇率降级不会发送健康心跳，也不会跳过后续自动重试。Cloudflare 实际触发、DNS 和安全头需单独查看控制面，不能由仓库文字证明。

运行环境：Node.js >=22.1.0、pnpm 10.14.0；依赖以 package/lockfile 为准。CI 使用以下入口（项目目录内）：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test:core
pnpm validate:artifact
pnpm validate:snapshots
pnpm test:browsers
pnpm audit --audit-level low
```

定向生成/检查：`pnpm render:static`、`pnpm render:static:check`、`pnpm assets:update`、`pnpm assets:check`。浏览器矩阵使用锁定 Playwright；日更也使用其配套 Chromium。

`pnpm check:live` 是只读在线诊断；`pnpm update:data` 会写数据，不能代替只读排障。修改关键数据或发布规则时，同步维护本说明与 OPERATIONS，不追加阶段报告。验收细节保留在 PR 和 Actions。

## 来源、隐私与许可

汇率来自 ExchangeRate-API，认证源不可用时尝试[开放源](https://open.er-api.com/v6/latest/USD)。页面加载 GA4 和 Cloudflare Web Analytics；加载前清理搜索词及非法 URL 参数，GA4 可能写统计 Cookie。应用自身不持久化价格。

本工具与 Apple Inc. 无关联。自有代码见 [LICENSE](LICENSE)，第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
