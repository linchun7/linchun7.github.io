import * as cheerio from 'cheerio';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const APPLE_ZH_ICLOUD_URL = 'https://support.apple.com/zh-cn/108047';
const REVIEWED_NAMES_URL = new URL('./country-names.zh.json', import.meta.url);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MIN_PLAUSIBLE_MARKETS = 20;
const MAX_PLAUSIBLE_MARKETS = 400;

const CAPACITY_RE = /(?:^|[^\d])(?:50|200)\s*GB\b|(?:^|[^\d])(?:2|6|12)\s*TB\b/giu;
const MARKET_HEADER_RE = /^(?:国家(?:或地区)?|国家\s*\/\s*地区|地区|市场|country(?:\s*\/\s*region)?|region|market)(?:\s*\([^)]*\))?$/iu;
const NON_MARKET_RE = /(?:icloud|homekit|储存空间|存储空间|价格|定价|方案|月费|国家或地区|国家\/地区|付款方式|发布日期|有帮助|北美洲|南美洲|拉丁美洲|加勒比地区|欧洲、中东和非洲|欧洲|中东|非洲|亚太地区)/iu;
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
  if (MARKET_HEADER_RE.test(name)) return false;
  if (/[：:$€£¥₩₽₹₱₦₸]|\b(?:GB|TB)\b/iu.test(name)) return false;
  if (/\d/u.test(name)) return false;
  return /[\p{L}\p{Script=Han}]/u.test(name);
}

export function marketNameFromLabel(value, { allowPlain = false } = {}) {
  let text = stripFootnotes(value);
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

function extractHeadingCandidates($, root, target) {
  root.find('h2,h3,h4,h5,h6,dt').each((_, element) => {
    addCandidate(target, $(element).text(), { allowPlain: false });
  });
}

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

function firstShortChildText($, element) {
  for (const node of element.childNodes ?? []) {
    const raw = node.type === 'text' ? node.data : $(node).text();
    const text = normalizeVisibleText(raw);
    if (!text || text.length > 100 || countCapacityMarkers(text) > 0) continue;
    return text;
  }
  return '';
}

function extractContextCandidates($, root, target) {
  root.find('section,article,div,li,dd,p').each((_, element) => {
    const text = normalizeVisibleText($(element).text());
    if (!text || text.length > 1500 || countCapacityMarkers(text) < 2) return;

    const leadingLabel = text.match(/^(.{1,100}?[（(][^（）()]{1,80}[）)])/u)?.[1];
    if (leadingLabel) addCandidate(target, leadingLabel, { allowPlain: false });

    const childText = firstShortChildText($, element);
    if (childText) addCandidate(target, childText, { allowPlain: true });
  });
}

function collectTextNodes(rootNode) {
  const values = [];
  const visit = (node) => {
    if (node.type === 'text') {
      const text = normalizeVisibleText(node.data);
      if (text) values.push(text);
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(rootNode);
  return values;
}

function extractTextAdjacencyCandidates(root, target) {
  const rootNode = root[0];
  if (!rootNode) return;
  const tokens = collectTextNodes(rootNode);
  for (let index = 0; index < tokens.length; index += 1) {
    const candidate = marketNameFromLabel(tokens[index], { allowPlain: true });
    if (!candidate) continue;
    const nearby = tokens.slice(index + 1, index + 10).join(' ');
    if (countCapacityMarkers(nearby) >= 2) target.add(candidate);
  }
}

export function extractAppleZhMarketNames(html) {
  const $ = cheerio.load(String(html ?? ''));
  const root = rootForExtraction($);
  const markets = new Set();
  extractHeadingCandidates($, root, markets);
  extractTableCandidates($, root, markets);
  extractContextCandidates($, root, markets);
  extractTextAdjacencyCandidates(root, markets);
  return [...markets].sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

export function reviewedMarketNamesFromMapping(mapping) {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) {
    throw new Error('Chinese market-name authority must be an object');
  }
  const names = Object.values(mapping)
    .filter((value) => typeof value === 'string' && value.trim())
    .map(normalizeVisibleText);
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh-CN'));
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
    const mapping = JSON.parse(await readFile(REVIEWED_NAMES_URL, 'utf8'));
    const reviewedNames = reviewedMarketNamesFromMapping(mapping);
    const html = await fetchAppleHtml(fetchImpl);
    const observedNames = extractAppleZhMarketNames(html);
    validateObservedMarketSet(reviewedNames, observedNames);
    const diff = compareMarketNameSets(reviewedNames, observedNames);

    if (!diff.added.length && !diff.removed.length) {
      console.log(`Apple Chinese iCloud+ market list unchanged (${observedNames.length} markets).`);
      await appendSummary([
        '### Apple 中文 iCloud+ 地区监测',
        '',
        `地区名称集合未变化（${observedNames.length} 个）。`,
      ]);
      return { status: 'unchanged', reviewedNames, observedNames, ...diff };
    }

    const message = `新增 ${diff.added.length}，移除 ${diff.removed.length}；仅提示人工复核，不自动修改中文名称。`;
    console.log(`::warning title=Apple 中文 iCloud+ 地区列表有变化::${escapeWorkflowCommand(message)}`);
    await appendSummary([
      '### ⚠️ Apple 中文 iCloud+ 地区列表有变化',
      '',
      `${message}`,
      diff.added.length ? `- 页面新增：${diff.added.join('、')}` : '- 页面新增：无',
      diff.removed.length ? `- 页面不再出现：${diff.removed.join('、')}` : '- 页面不再出现：无',
      '- 处理方式：人工核对同一 Apple 中文 iCloud+ 页面后，再更新 `scripts/country-names.zh.json`。',
    ]);
    return { status: 'changed', reviewedNames, observedNames, ...diff };
  } catch (error) {
    const message = `本次中文地区监测不可用：${error instanceof Error ? error.message : String(error)}；不影响价格更新。`;
    console.log(`::notice title=Apple 中文地区监测不可用::${escapeWorkflowCommand(message)}`);
    await appendSummary([
      '### Apple 中文 iCloud+ 地区监测',
      '',
      `${message}`,
    ]);
    return { status: 'unavailable', error };
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) await runAppleZhMarketMonitor();
