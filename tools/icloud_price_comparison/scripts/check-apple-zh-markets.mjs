import * as cheerio from 'cheerio';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLE_ZH_ICLOUD_URL = 'https://support.apple.com/zh-cn/108047';
const REVIEWED_MARKETS_URL = new URL('./apple-zh-reviewed-markets.json', import.meta.url);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_PLAUSIBLE_MARKETS = 20;
const MAX_PLAUSIBLE_MARKETS = 400;

const CAPACITY_RE = /\b\d+(?:[.,]\d+)?\s*(?:GB|TB|PB)\b/giu;
const MARKET_HEADER_RE = /^(?:国家(?:或地区)?|国家\s*\/\s*地区|地区|市场|country(?:\s*\/\s*region)?|region|market)(?:\s*[（(][^）)]*[）)])?$/iu;
const NON_MARKET_RE = /(?:icloud|homekit|储存空间|存储空间|价格|定价|方案|月费|国家或地区|国家\s*\/\s*地区|付款方式|发布日期|有帮助|北美洲|南美洲|拉丁美洲|加勒比地区|欧洲、中东和非洲|亚太地区)/iu;
const FOOTNOTE_SUFFIX_RE = /(?:\s*(?:\d+(?:\s*[,，]\s*\d+)*|[⁰¹²³⁴⁵⁶⁷⁸⁹]+))+$/u;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/gu;

export function normalizeVisibleText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function stripFootnotes(value) {
  return normalizeVisibleText(value).replace(FOOTNOTE_SUFFIX_RE, '').trim();
}

function countCapacityMarkers(value) {
  const matches = normalizeVisibleText(value).match(CAPACITY_RE);
  return new Set((matches ?? []).map((item) => item.replace(/\s+/gu, '').toUpperCase())).size;
}

function looksLikeMarketName(value) {
  const name = stripFootnotes(value);
  if (!name || name.length > 60 || NON_MARKET_RE.test(name)) return false;
  if (/^[（(]|[）)]$/u.test(name) || MARKET_HEADER_RE.test(name)) return false;
  if (/[。；;!?！？：:$€£¥₩₽₹₱₦₸]|\b(?:GB|TB|PB)\b/iu.test(name) || /\d/u.test(name)) return false;
  return /[\p{L}\p{Script=Han}]/u.test(name);
}

export function marketNameFromLabel(value, { allowPlain = false } = {}) {
  const text = stripFootnotes(value);
  if (!text) return null;

  const parenthesized = text.match(/^(.{1,90}?)\s*[（(]([^（）()]{1,80})[）)]$/u);
  if (parenthesized) {
    const name = stripFootnotes(parenthesized[1]);
    const context = normalizeVisibleText(parenthesized[2]);
    if (!looksLikeMarketName(name) || countCapacityMarkers(context) > 0) return null;
    return name;
  }

  if (!allowPlain || !looksLikeMarketName(text)) return null;
  return text;
}

function rootForExtraction($) {
  return $('main').first().length ? $('main').first()
    : $('[role="main"]').first().length ? $('[role="main"]').first()
      : $('article').first().length ? $('article').first() : $('body');
}

// Price values establish local record context only; none enter the name set.
// Preserve inline Chinese labels without injecting spaces, but separate price
// text nodes so replacing list/card wrappers cannot join adjacent tier values.
function contextText(node) {
  return node.type === 'text' ? node.data : (node.childNodes ?? []).map(contextText).join(' ');
}

function priceRecordSize(value) {
  const text = normalizeVisibleText(value);
  const matches = [...text.matchAll(CAPACITY_RE)];
  if (!matches.length || matches[0].index !== 0) return 0;
  for (let index = 0; index < matches.length; index += 1) {
    const tail = text.slice(matches[index].index + matches[index][0].length, matches[index + 1]?.index);
    if (!/^\s*[:：]?\s*(?:[\p{Sc}A-Za-z./]{0,8}\s*)\d/u.test(tail)) return 0;
  }
  return matches.length;
}

function tableMarketNames($, table) {
  const rows = $(table).find('tr').filter((_, row) => $(row).closest('table')[0] === table && !$(row).closest('tfoot').length).toArray();
  // A country-availability/features table is not a country-price table. Tier
  // values may change freely (including a single tier), but need local evidence.
  if (!countCapacityMarkers(contextText(table))) return null;
  let column = -1;
  const names = [];
  for (const row of rows) {
    const cells = $(row).children('th,td').toArray();
    const headers = cells.flatMap((cell, index) => MARKET_HEADER_RE.test(normalizeVisibleText($(cell).text())) ? [index] : []);
    if (headers.length > 1) throw new Error('Ambiguous Chinese market table country columns');
    if (headers.length) {
      if (column >= 0 && column !== headers[0]) throw new Error('Chinese market table changes its country column');
      column = headers[0];
      continue;
    }
    if (column < 0) continue;
    if (!cells.length || cells.some((cell) => ['rowspan', 'colspan'].some((attribute) => $(cell).attr(attribute) && $(cell).attr(attribute) !== '1'))) {
      throw new Error('Unexplained Chinese market table row');
    }
    const name = marketNameFromLabel($(cells[column]).text(), { allowPlain: true });
    if (!name) throw new Error('Chinese market table contains an empty or unexplained country cell');
    names.push(name);
  }
  if (column >= 0 && !names.length) throw new Error('Chinese market table contains no countries');
  if (column < 0 && rows.some((row) => $(row).children('th,td').toArray().some((cell) => /[\p{Sc}]\s*\d/u.test($(cell).text())))) {
    throw new Error('Unexplained Chinese pricing table without a country column');
  }
  return column >= 0 ? names : null;
}

export function extractAppleZhMarketNames(html) {
  const $ = cheerio.load(String(html ?? ''));
  const root = rootForExtraction($);
  root.find('script,style,nav,aside,footer,sup,tfoot,[role="note"],[role="doc-footnote"]').remove();
  const markets = new Set();
  let pending = null;
  let activeOwner = null;
  const contains = (parent, node) => {
    for (let current = node; current; current = current.parent) if (current === parent) return true;
    return false;
  };
  const commonOwner = (first, second) => {
    for (let parent = first.parent; parent; parent = parent.parent) if (contains(parent, second)) return parent;
    return null;
  };
  const visit = (node) => {
    const text = normalizeVisibleText(node.type === 'text' ? node.data : $(node).text());
    if (!text) return;
    const size = priceRecordSize(contextText(node));
    if (node.name === 'table' && !size) {
      const names = tableMarketNames($, node);
      if (names !== null) {
        for (const name of names) markets.add(name);
        pending = null;
        activeOwner = null;
        return;
      }
    }
    const label = marketNameFromLabel(text, { allowPlain: true });
    if (label) {
      pending = { name: label, node };
      activeOwner = null;
      return;
    }
    // A wrapper spanning several markets is not one price-only record.
    const hasLabels = size && $(node).find('*').toArray().some((child) => {
      const value = normalizeVisibleText($(child).text());
      return !/^[A-Za-z.]{1,8}$/u.test(value) && marketNameFromLabel(value, { allowPlain: true });
    });
    if (size && !hasLabels) {
      if (pending) {
        markets.add(pending.name);
        activeOwner = commonOwner(pending.node, node);
        pending = null;
      } else if (!activeOwner || !contains(activeOwner, node)) {
        throw new Error('Unexplained Chinese price record without a market label');
      }
      if (size > 1) activeOwner = null;
      return;
    }
    const children = node.childNodes ?? [];
    if (children.length) {
      for (const child of children) visit(child);
    } else {
      pending = null;
      activeOwner = null;
    }
  };
  visit(root[0]);
  return [...markets].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function parseReviewedMarketBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chinese market review baseline must be an object');
  }
  if (value.source !== APPLE_ZH_ICLOUD_URL || !Array.isArray(value.markets)) {
    throw new Error('Chinese market review baseline has an unsupported structure');
  }
  // Reviewed evidence has a schema, not the extractor's lexical heuristics.
  if (value.markets.some((name) => typeof name !== 'string' || !normalizeVisibleText(name)
    || name.length > 200 || /[\u0000-\u001F\u007F]/u.test(name))) {
    throw new Error('Chinese market review baseline contains an invalid market name string');
  }
  const markets = value.markets.map(normalizeVisibleText);
  if (new Set(markets).size !== markets.length) {
    throw new Error('Chinese market review baseline contains duplicate names');
  }
  return markets;
}

export function compareMarketNameSets(reviewedNames, observedNames) {
  const reviewed = new Set(reviewedNames.map(normalizeVisibleText));
  const observed = new Set(observedNames.map(normalizeVisibleText));
  return {
    added: [...observed].filter((name) => !reviewed.has(name)).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    removed: [...reviewed].filter((name) => !observed.has(name)).sort((a, b) => a.localeCompare(b, 'zh-CN')),
  };
}

export function validateObservedMarketSet(reviewedNames, observedNames) {
  const reviewed = new Set(reviewedNames);
  const observed = new Set(observedNames);
  if (reviewed.size < MIN_PLAUSIBLE_MARKETS) throw new Error(`reviewed market baseline is unexpectedly small (${reviewed.size})`);
  if (observed.size < MIN_PLAUSIBLE_MARKETS || observed.size > MAX_PLAUSIBLE_MARKETS) {
    throw new Error(`observed Chinese market count is implausible (${observed.size})`);
  }
  const overlap = [...observed].filter((name) => reviewed.has(name)).length;
  const minimumOverlap = Math.min(20, Math.ceil(reviewed.size * 0.5));
  if (overlap < minimumOverlap) throw new Error(`observed Chinese market overlap is implausibly low (${overlap}/${reviewed.size})`);
  const removedRatio = [...reviewed].filter((name) => !observed.has(name)).length / reviewed.size;
  if (removedRatio > 0.45) throw new Error(`observed Chinese market list would remove ${(removedRatio * 100).toFixed(1)}% of reviewed names`);
}

export function monitorExitCode(result) {
  return result?.status === 'unchanged' ? 0 : 1;
}

function escapeWorkflowCommand(value) {
  return String(value).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A');
}

async function appendSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
}

async function fetchAppleHtml(fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(APPLE_ZH_ICLOUD_URL, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'icloud-price-monitor/1.0', 'cache-control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error('响应体过大');
    }
    if (!response.body) throw new Error('响应体为空');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('响应体过大');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const html = Buffer.concat(chunks, bytes).toString('utf8');
    if (html.length < 1000) throw new Error('响应内容异常偏小');
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAppleZhMarketMonitor({ fetchImpl = fetch, report = true } = {}) {
  try {
    const reviewedNames = parseReviewedMarketBaseline(JSON.parse(await readFile(REVIEWED_MARKETS_URL, 'utf8')));
    const observedNames = extractAppleZhMarketNames(await fetchAppleHtml(fetchImpl));
    validateObservedMarketSet(reviewedNames, observedNames);
    const diff = compareMarketNameSets(reviewedNames, observedNames);

    if (!diff.added.length && !diff.removed.length) {
      if (report) {
        console.log(`Apple 中文 iCloud+ 地区名单未变化（${observedNames.length} 个）。`);
        await appendSummary([
          '### Apple 中文页面 iCloud+ 地区名单监测',
          '',
          `地区名称集合未变化（${observedNames.length} 个）。`,
          '- 口径说明：这里统计 Apple 中文页面的地区名称集合；与英文价格页“中文名称同步状态”的待确认数量不是同一统计。'
        ]);
      }
      return { status: 'unchanged', reviewedNames, observedNames, ...diff };
    }

    const message = `当前 ${observedNames.length} 个；较已复核基线新增 ${diff.added.length}，移除 ${diff.removed.length}；仅提示人工复核，不自动修改中文名称。`;
    if (report) {
      console.log(`::error title=Apple 中文 iCloud+ 地区列表有变化::${escapeWorkflowCommand(message)}`);
      console.log(`页面新增地区：${diff.added.join('、') || '无'}`);
      console.log(`页面不再出现地区：${diff.removed.join('、') || '无'}`);
      await appendSummary([
        '### ⚠️ Apple 中文页面 iCloud+ 地区列表有变化',
        '',
        message,
        diff.added.length ? `- 页面新增：${diff.added.join('、')}` : '- 页面新增：无',
        diff.removed.length ? `- 页面不再出现：${diff.removed.join('、')}` : '- 页面不再出现：无',
        '- 即使总数量不变，只要成员发生替换，也会同时列出新增和移除项。',
        '- 口径说明：这里统计 Apple 中文页面的地区名称集合；与英文价格页“中文名称同步状态”的待确认数量不是同一统计。',
        '- 处理方式：人工核对同一 Apple 中文 iCloud+ 页面后，再更新地区名单基线；如能可靠对应英文市场，再更新 `scripts/country-names.zh.json`。',
      ]);
    }
    return { status: 'changed', reviewedNames, observedNames, ...diff };
  } catch (error) {
    const message = `本次中文地区监测不可用：${error instanceof Error ? error.message : String(error)}；不影响价格更新。`;
    if (report) {
      console.log(`::error title=Apple 中文地区监测不可用::${escapeWorkflowCommand(message)}`);
      await appendSummary(['### Apple 中文页面 iCloud+ 地区名单监测', '', message]);
    }
    return { status: 'unavailable', error };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const result = await runAppleZhMarketMonitor();
  process.exitCode = monitorExitCode(result);
}
