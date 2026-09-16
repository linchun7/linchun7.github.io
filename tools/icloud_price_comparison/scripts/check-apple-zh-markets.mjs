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
  if (/[：:$€£¥₩₽₹₱₦₸]|\b(?:GB|TB|PB)\b/iu.test(name) || /\d/u.test(name)) return false;
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

function addCandidate(target, value, options) {
  const name = marketNameFromLabel(value, options);
  if (name) target.add(name);
}

function rootForExtraction($) {
  return $('main').first().length
    ? $('main').first()
    : $('[role="main"]').first().length
      ? $('[role="main"]').first()
      : $('article').first().length
        ? $('article').first()
        : $('body');
}

// Legacy Apple form: market headings encode the market name and currency in the
// heading itself. This path deliberately ignores Apple CSS classes and heading level.
function extractHeadingCandidates($, root, target) {
  root.find('h2,h3,h4,h5,h6,dt').each((_, element) => {
    addCandidate(target, $(element).text(), { allowPlain: false });
  });
}

// Current English-style form: a table whose first column is market/country and
// whose remaining columns are storage tiers. Header wording and column count may vary.
function extractTableCandidates($, root, target) {
  root.find('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    let headerIndex = -1;
    for (let index = 0; index < rows.length; index += 1) {
      const cells = $(rows[index]).find('th,td').toArray();
      if (cells.length < 2) continue;
      const first = normalizeVisibleText($(cells[0]).text());
      const rowText = cells.map((cell) => normalizeVisibleText($(cell).text())).join(' ');
      if (MARKET_HEADER_RE.test(first) || countCapacityMarkers(rowText) >= 2) {
        headerIndex = index;
        break;
      }
    }
    if (headerIndex < 0) return;
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = $(row).find('th,td').toArray();
      if (!cells.length) continue;
      addCandidate(target, $(cells[0]).text(), { allowPlain: true });
    }
  });
}

function directNodeText($, node) {
  if (node.type === 'text') return normalizeVisibleText(node.data);
  return normalizeVisibleText($(node).text());
}

// Generic future form: only inspect small local containers. A short candidate label
// is accepted only when the same local container also has multiple storage-capacity
// markers. This intentionally avoids article-wide adjacency scans, footnotes, and
// feature-card text while remaining independent of CSS names or exact wrappers.
function extractLocalGroupCandidates($, root, target) {
  root.find('section,article,div,li,dd').each((_, element) => {
    const nodes = (element.childNodes ?? []).filter((node) => directNodeText($, node));
    if (nodes.length < 2 || nodes.length > 24) return;
    const totalText = normalizeVisibleText($(element).text());
    if (!totalText || totalText.length > 1200 || countCapacityMarkers(totalText) < 2) return;

    for (let index = 0; index < Math.min(nodes.length - 1, 4); index += 1) {
      const label = directNodeText($, nodes[index]);
      const candidate = marketNameFromLabel(label, { allowPlain: true });
      if (!candidate) continue;
      const following = nodes.slice(index + 1).map((node) => directNodeText($, node)).join(' ');
      if (countCapacityMarkers(following) >= 2) target.add(candidate);
      break;
    }
  });
}

export function extractAppleZhMarketNames(html) {
  const $ = cheerio.load(String(html ?? ''));
  const root = rootForExtraction($);
  const markets = new Set();
  extractHeadingCandidates($, root, markets);
  extractTableCandidates($, root, markets);
  extractLocalGroupCandidates($, root, markets);
  return [...markets].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function parseReviewedMarketBaseline(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Chinese market review baseline must be an object');
  }
  if (value.source !== APPLE_ZH_ICLOUD_URL || !Array.isArray(value.markets)) {
    throw new Error('Chinese market review baseline has an unsupported structure');
  }
  const markets = value.markets.map(normalizeVisibleText);
  if (markets.some((name) => !looksLikeMarketName(name))) {
    throw new Error('Chinese market review baseline contains an invalid market name');
  }
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
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('response is too large');
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('response is too large');
    if (html.length < 1000) throw new Error('response is unexpectedly small');
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

export async function runAppleZhMarketMonitor({ fetchImpl = fetch } = {}) {
  try {
    const reviewedNames = parseReviewedMarketBaseline(JSON.parse(await readFile(REVIEWED_MARKETS_URL, 'utf8')));
    const observedNames = extractAppleZhMarketNames(await fetchAppleHtml(fetchImpl));
    validateObservedMarketSet(reviewedNames, observedNames);
    const diff = compareMarketNameSets(reviewedNames, observedNames);

    if (!diff.added.length && !diff.removed.length) {
      console.log(`Apple Chinese iCloud+ market list unchanged (${observedNames.length} markets).`);
      await appendSummary(['### Apple 中文 iCloud+ 地区监测', '', `地区名称集合未变化（${observedNames.length} 个）。`]);
      return { status: 'unchanged', reviewedNames, observedNames, ...diff };
    }

    const message = `新增 ${diff.added.length}，移除 ${diff.removed.length}；仅提示人工复核，不自动修改中文名称。`;
    console.log(`::warning title=Apple 中文 iCloud+ 地区列表有变化::${escapeWorkflowCommand(message)}`);
    console.log(`Apple Chinese market additions: ${diff.added.join('、') || '无'}`);
    console.log(`Apple Chinese market removals: ${diff.removed.join('、') || '无'}`);
    await appendSummary([
      '### ⚠️ Apple 中文 iCloud+ 地区列表有变化',
      '',
      message,
      diff.added.length ? `- 页面新增：${diff.added.join('、')}` : '- 页面新增：无',
      diff.removed.length ? `- 页面不再出现：${diff.removed.join('、')}` : '- 页面不再出现：无',
      '- 处理方式：人工核对同一 Apple 中文 iCloud+ 页面后，再更新地区名单基线；如能可靠对应英文市场，再更新 `scripts/country-names.zh.json`。',
    ]);
    return { status: 'changed', reviewedNames, observedNames, ...diff };
  } catch (error) {
    const message = `本次中文地区监测不可用：${error instanceof Error ? error.message : String(error)}；不影响价格更新。`;
    console.log(`::notice title=Apple 中文地区监测不可用::${escapeWorkflowCommand(message)}`);
    await appendSummary(['### Apple 中文 iCloud+ 地区监测', '', message]);
    return { status: 'unavailable', error };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await runAppleZhMarketMonitor();
