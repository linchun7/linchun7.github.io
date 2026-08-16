import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(projectDir, 'og-image.png');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

try {
  await page.setContent(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
  body {
    font-family: "Noto Sans CJK SC", "Noto Sans SC", "Microsoft YaHei", sans-serif;
    color: #17212b;
    background:
      radial-gradient(circle at 18% 18%, rgba(17,104,212,.10), transparent 28%),
      radial-gradient(circle at 84% 78%, rgba(17,104,212,.08), transparent 26%),
      #eef2f6;
  }
  .frame {
    position: absolute;
    inset: 54px 64px;
    padding: 52px 58px 42px;
    background: rgba(255,255,255,.98);
    border: 1px solid #dce4eb;
    border-radius: 26px;
    box-shadow: 0 24px 70px rgba(24,43,61,.12);
  }
  .top { display: flex; align-items: center; gap: 24px; }
  .mark {
    width: 86px; height: 86px; flex: 0 0 86px;
    display: grid; place-items: center;
    color: #1168d4; background: #eaf3ff;
    border: 1px solid #cfe2fa; border-radius: 22px;
  }
  .mark svg { width: 54px; height: 54px; }
  h1 { margin: 0; font-size: 55px; line-height: 1.08; letter-spacing: -1.5px; font-weight: 800; }
  .subtitle { margin: 13px 0 0; color: #596773; font-size: 23px; line-height: 1.35; font-weight: 500; }
  .tiers { display: flex; gap: 14px; margin-top: 40px; }
  .tier {
    min-width: 118px; padding: 11px 20px;
    color: #0755b5; background: #f1f7ff;
    border: 1px solid #cfe2fa; border-radius: 999px;
    font-size: 22px; line-height: 1; font-weight: 760; text-align: center;
  }
  .features { display: flex; align-items: center; gap: 15px; margin-top: 30px; color: #33485c; font-size: 21px; font-weight: 650; }
  .dot { width: 5px; height: 5px; border-radius: 50%; background: #9aa9b7; }
  .footer {
    position: absolute; left: 58px; right: 58px; bottom: 37px;
    display: flex; justify-content: space-between; align-items: center;
    padding-top: 20px; border-top: 1px solid #e5ebf0;
    color: #697784; font-size: 18px; line-height: 1;
  }
  .source { font-weight: 550; }
  .domain { color: #0755b5; font-weight: 700; }
</style>
</head>
<body>
  <main class="frame">
    <div class="top">
      <div class="mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M20.5 48h27.3C55.1 48 61 42.4 61 35.5S55.4 23 48.4 23c-1.4 0-2.8.2-4.1.7C41.8 16.8 35.3 12 27.7 12 18.5 12 11 19.1 10.4 28.1 5 29.8 1 34.7 1 40.5 1 47.4 6.9 53 14.2 53h6.3" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <div>
        <h1>iCloud+ 全球价格对比</h1>
        <p class="subtitle">比较全球各地区当地月费与人民币参考价</p>
      </div>
    </div>

    <div class="tiers" aria-label="容量">
      <span class="tier">50GB</span>
      <span class="tier">200GB</span>
      <span class="tier">2TB</span>
      <span class="tier">6TB</span>
      <span class="tier">12TB</span>
    </div>

    <div class="features">
      <span>全球月费</span><span class="dot"></span>
      <span>人民币参考价</span><span class="dot"></span>
      <span>最低价排名</span><span class="dot"></span>
      <span>价格历史</span>
    </div>

    <div class="footer">
      <span class="source">数据来源：Apple 支持页</span>
      <span class="domain">www.linchun.com.cn</span>
    </div>
  </main>
</body>
</html>`, { waitUntil: 'load' });

  await page.screenshot({ path: outputPath, type: 'png', fullPage: false, animations: 'disabled' });
} finally {
  await browser.close();
}
