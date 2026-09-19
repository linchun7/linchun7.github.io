import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DETAIL_ITEMS = 20;
const LEGACY_SECTION_PATTERN = /(?:^|\n)### 中文名称同步状态\n- 待同一 Apple iCloud\+ 中文价格页同步\/确认：\d+ 个；当前继续显示 Apple 英文名称，不作为异常或 review debt。\n?/;

function pendingMarkets(data, label) {
  if (data?.schemaVersion !== 4 || !Array.isArray(data.countries)) {
    throw new Error(`${label} has an unsupported price-data structure`);
  }
  const seen = new Set();
  const pending = [];
  for (const country of data.countries) {
    if (typeof country?.marketId !== 'string'
      || typeof country?.country !== 'string'
      || typeof country?.nameZh !== 'string'
      || seen.has(country.marketId)) {
      throw new Error(`${label} has an invalid or duplicate market entry`);
    }
    seen.add(country.marketId);
    // The updater contract intentionally writes the Apple English source name into
    // nameZh while the reviewed Chinese display name is still pending. That makes
    // the committed previous prices.json a sufficient historical baseline; no new
    // state file or schema field is needed just for presentation diffing.
    if (country.nameZh === country.country) {
      pending.push({ marketId: country.marketId, sourceName: country.country });
    }
  }
  return pending.sort((a, b) => a.marketId.localeCompare(b.marketId));
}

export function diffChineseNamePending(previousData, currentData) {
  const previous = pendingMarkets(previousData, 'previous prices.json');
  const current = pendingMarkets(currentData, 'current prices.json');
  const previousIds = new Set(previous.map(({ marketId }) => marketId));
  const currentIds = new Set(current.map(({ marketId }) => marketId));
  return {
    previousCount: previous.length,
    currentCount: current.length,
    added: current.filter(({ marketId }) => !previousIds.has(marketId)),
    removed: previous.filter(({ marketId }) => !currentIds.has(marketId))
  };
}

function summarizeMarkets(markets) {
  const visible = markets.slice(0, MAX_DETAIL_ITEMS)
    .map(({ sourceName, marketId }) => `${sourceName} (\`${marketId}\`)`);
  if (markets.length > MAX_DETAIL_ITEMS) visible.push(`另有 ${markets.length - MAX_DETAIL_ITEMS} 个`);
  return visible.join('、');
}

export function buildChineseNameSyncSummary(previousData, currentData) {
  const diff = diffChineseNamePending(previousData, currentData);
  const lines = [
    '### 英文价格页中文名称待确认',
    '- 口径：这里统计 Apple 英文 iCloud+ 价格页活跃市场中，中文显示名尚未复核的市场；与独立的“Apple 中文页面新地区名称监测”不是同一统计。',
    `- 当前待确认：${diff.currentCount} 个。`
  ];

  if (!diff.added.length && !diff.removed.length) {
    lines.push(`- 较上一轮：${diff.previousCount} → ${diff.currentCount}；成员未变化。`);
  } else if (diff.previousCount === diff.currentCount) {
    lines.push(`- 较上一轮：${diff.previousCount} → ${diff.currentCount}；总数不变，但成员发生变化（新增 ${diff.added.length}，退出 ${diff.removed.length}）。`);
  } else {
    lines.push(`- 较上一轮：${diff.previousCount} → ${diff.currentCount}；新增 ${diff.added.length}，退出 ${diff.removed.length}。`);
  }
  if (diff.added.length) lines.push(`- 新增待确认：${summarizeMarkets(diff.added)}`);
  if (diff.removed.length) lines.push(`- 退出待确认：${summarizeMarkets(diff.removed)}`);
  lines.push('- “退出待确认”只表示不再属于待确认集合：可能是中文名已复核，也可能是英文价格页活跃市场发生变化。', '');
  return lines;
}

export function mergeChineseNameSyncSummary(existingSummary, lines) {
  const section = `${lines.join('\n')}\n`;
  if (LEGACY_SECTION_PATTERN.test(existingSummary)) {
    return existingSummary.replace(LEGACY_SECTION_PATTERN, (match) => {
      const prefix = match.startsWith('\n') ? '\n' : '';
      return `${prefix}${section}`;
    });
  }
  const separator = existingSummary && !existingSummary.endsWith('\n') ? '\n' : '';
  return `${existingSummary}${separator}${section}`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--previous', '--current', '--summary'].includes(key) || !value) {
      throw new Error('Usage: report-chinese-name-sync.mjs --previous <prices.json> --current <prices.json> --summary <summary.md>');
    }
    values.set(key, value);
  }
  if (values.size !== 3) {
    throw new Error('Usage: report-chinese-name-sync.mjs --previous <prices.json> --current <prices.json> --summary <summary.md>');
  }
  return {
    previousPath: values.get('--previous'),
    currentPath: values.get('--current'),
    summaryPath: values.get('--summary')
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { previousPath, currentPath, summaryPath } = parseArgs(argv);
  const [previousData, currentData, existingSummary] = await Promise.all([
    readJson(previousPath),
    readJson(currentPath),
    readOptionalText(summaryPath)
  ]);
  const lines = buildChineseNameSyncSummary(previousData, currentData);
  await writeFile(summaryPath, mergeChineseNameSyncSummary(existingSummary, lines), 'utf8');
  const diff = diffChineseNamePending(previousData, currentData);
  console.log(`中文名称待确认成员差异：${diff.previousCount} → ${diff.currentCount}；新增 ${diff.added.length}，退出 ${diff.removed.length}。`);
  return diff;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`中文名称待确认成员差异生成失败：${error.message}`);
    process.exitCode = 1;
  });
}
