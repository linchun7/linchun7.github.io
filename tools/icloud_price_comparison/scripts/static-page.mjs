import { createHash } from 'node:crypto';
import { validatePricePayload } from '../data-contract.js';

export const STATIC_FRAGMENT_NAMES = Object.freeze([
  'META',
  'STATUS',
  'WORKSPACE_META',
  'OVERVIEW',
  'MINIMUMS',
  'TABLE_HEAD',
  'TABLE_BODY',
  'APPLE_META',
  'FX_META'
]);

const DEFAULT_TIER_ID = '200GB';

export function preferredDefaultTier(payload) {
  return payload.tiers.find(({ id }) => id === DEFAULT_TIER_ID) ?? payload.tiers[0];
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function publicPayloadFingerprint(payload) {
  return createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function beijingDateTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '--';
  const date = new Date(timestamp + 8 * 60 * 60 * 1_000);
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function appleDate(value) {
  const match = String(value).match(/^([A-Za-z]+) (\d{1,2}), (\d{4})$/);
  if (!match) return escapeHtml(value);
  const timestamp = Date.parse(`${match[1]} ${match[2]}, ${match[3]} UTC`);
  if (!Number.isFinite(timestamp)) return escapeHtml(value);
  const date = new Date(timestamp);
  return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
}

function displayName(country) {
  return country.nameZh || country.country;
}

function renderMinimumCard(tier, countries) {
  const winners = countries
    .filter((country) => country.plans[tier.id].cnyRank === 1)
    .sort((first, second) => first.marketId.localeCompare(second.marketId, 'en'));
  const winnerNames = winners.map(displayName);
  const names = winnerNames.length > 3
    ? `${winnerNames.slice(0, 3).join('、')}等 ${winnerNames.length} 个地区`
    : winnerNames.join('、');
  const price = winners[0]?.plans[tier.id].cnyPrice;
  return [
    `          <button class="minimum-card" type="button" data-tier="${escapeHtml(tier.id)}" data-market-id="${escapeHtml(winners[0]?.marketId ?? '')}" disabled>`,
    `            <span class="minimum-tier-label">${escapeHtml(tier.label)}</span>`,
    `            <strong class="minimum-country">${escapeHtml(names || '暂无地区')}</strong>`,
    `            <small class="minimum-price">¥${formatNumber(price)}</small>`,
    '            <span class="visually-hidden">，按该容量从低到高排序并在价格表中定位</span>',
    '          </button>'
  ].join('\n');
}

function renderPriceCell(country, tier, { defaultTierId, minimumCuesEnabled }) {
  const plan = country.plans[tier.id];
  const classes = ['price-cell'];
  if (tier.id === defaultTierId) classes.push('is-active-tier', 'is-sorted');
  if (minimumCuesEnabled && plan.cnyRank === 1) classes.push('is-minimum');
  return [
    `            <td class="${classes.join(' ')}" data-tier="${escapeHtml(tier.id)}">`,
    '              <strong class="price-cny">',
    ...(minimumCuesEnabled && plan.cnyRank === 1 ? ['                <span class="minimum-badge">最低</span>'] : []),
    `                <span class="price-symbol">¥</span><span class="price-amount">${formatNumber(plan.cnyPrice)}</span>`,
    '              </strong>',
    `              <span class="price-local">${escapeHtml(plan.formattedPrice)}</span>`,
    '            </td>'
  ].join('\n');
}

function renderCountryRow(country, tiers, options) {
  const rank = country.plans[options.defaultTierId]?.cnyRank ?? '--';
  const tierRanks = tiers.map((tier) => country.plans[tier.id].cnyRank).join(',');
  const secondary = country.nameZh && country.nameZh !== country.country
    ? `              <span class="country-name-en">${escapeHtml(country.country)} · ${escapeHtml(country.currency)}</span>\n`
    : `              <span class="country-name-en">${escapeHtml(country.currency)}</span>\n`;
  return [
    `          <tr data-market-id="${escapeHtml(country.marketId)}" data-cny-ranks="${tierRanks}">`,
    `            <td${options.minimumCuesEnabled && rank <= 3 ? ' class="rank-top"' : ''}>${rank}</td>`,
    '            <td>',
    `              <button class="country-history-button" type="button" data-mobile-rank="${escapeHtml(rank)}" disabled>`,
    `              <span class="country-name">${escapeHtml(displayName(country))}</span>`,
    secondary.trimEnd(),
    '              <span class="history-affordance" aria-hidden="true">›</span>',
    '              <span class="visually-hidden">，查看价格历史</span>',
    '              </button>',
    '            </td>',
    ...tiers.map((tier) => renderPriceCell(country, tier, options)),
    '          </tr>'
  ].join('\n');
}

export function renderStaticFragments(payload) {
  validatePricePayload(payload);
  const fingerprint = publicPayloadFingerprint(payload);
  const defaultTier = preferredDefaultTier(payload);
  const fxStale = payload.fx.stale === true;
  const countries = [...payload.countries].sort((first, second) => (
    first.plans[defaultTier.id].cnyRank - second.plans[defaultTier.id].cnyRank
    || first.marketId.localeCompare(second.marketId, 'en')
  ));
  const currencyCount = new Set(payload.countries.map(({ currency }) => currency)).size;
  return {
    META: `  <meta name="icloud-price-snapshot" content="${escapeHtml(payload.generatedAt)}" data-fingerprint="${fingerprint}" data-fx-stale="${fxStale}">`,
    STATUS: `        <span id="updatedAt" title="北京时间">更新于 ${beijingDateTime(payload.generatedAt)}</span>`,
    WORKSPACE_META: [
      `          <p id="resultSummary" aria-live="polite">${payload.countries.length} 个地区 · ${escapeHtml(defaultTier.label)} 从低到高</p>`,
      `          <p id="rankingScopeNote" class="ranking-scope-note"${fxStale ? '' : ' hidden'}>${fxStale ? '排名基于最近一次可用汇率，仅供参考。' : '排名仍为全部地区中的全球参考排名'}</p>`
    ].join('\n'),
    OVERVIEW: [
      '      <dl class="overview-stats overview-stat-list" aria-label="价格覆盖概览">',
      `        <div><dt>覆盖</dt><dd id="marketCount">${payload.countries.length} 个地区</dd></div>`,
      `        <div><dt>币种</dt><dd id="currencyCount">${currencyCount} 种</dd></div>`,
      `        <div><dt>容量</dt><dd id="tierCount">${payload.tiers.length} 档</dd></div>`,
      '      </dl>'
    ].join('\n'),
    MINIMUMS: fxStale
      ? '        <p class="minimum-unavailable cache-stale-notice">参考汇率暂未更新，人民币金额使用最近一次可用汇率。</p>'
      : payload.tiers.map((tier) => renderMinimumCard(tier, payload.countries)).join('\n'),
    TABLE_HEAD: payload.tiers.map((tier) => [
      `              <th data-tier-header="true" data-tier="${escapeHtml(tier.id)}" class="${tier.id === defaultTier.id ? 'is-active-tier' : ''}" scope="col" aria-sort="${tier.id === defaultTier.id ? 'ascending' : 'none'}">`,
      `                <button type="button" data-sort-tier="${escapeHtml(tier.id)}" disabled>${escapeHtml(tier.label)} / 月 <i data-lucide="${tier.id === defaultTier.id ? 'arrow-up' : 'arrow-up-down'}" aria-hidden="true"></i></button>`,
      '              </th>'
    ].join('\n')).join('\n'),
    TABLE_BODY: countries.map((country) => renderCountryRow(country, payload.tiers, {
      defaultTierId: defaultTier.id,
      minimumCuesEnabled: !fxStale
    })).join('\n'),
    APPLE_META: `            <span>页面发布日期：<strong id="applePublishedDate">${appleDate(payload.source.publishedDate)}</strong></span>`,
    FX_META: `            <span id="fxStatus">汇率更新：${beijingDateTime(payload.fx.fetchedAt)}</span>`
  };
}

export function markerStart(name) {
  return `<!-- ICLOUD_STATIC_${name}:START -->`;
}

export function markerEnd(name) {
  return `<!-- ICLOUD_STATIC_${name}:END -->`;
}

export function extractStaticFragments(html) {
  const fragments = {};
  for (const name of STATIC_FRAGMENT_NAMES) {
    const start = markerStart(name);
    const end = markerEnd(name);
    const first = html.indexOf(start);
    const last = html.indexOf(end);
    if (first < 0 || last < 0 || first !== html.lastIndexOf(start) || last !== html.lastIndexOf(end) || last < first) {
      throw new Error(`STATIC_RENDER_MARKER_INVALID:${name}`);
    }
    fragments[name] = html.slice(first + start.length, last).replace(/^\r?\n|\r?\n$/g, '');
  }
  return fragments;
}

export function replaceStaticFragments(html, fragments) {
  extractStaticFragments(html);
  let rendered = html;
  for (const name of STATIC_FRAGMENT_NAMES) {
    const start = markerStart(name);
    const end = markerEnd(name);
    const before = rendered.slice(0, rendered.indexOf(start) + start.length);
    const after = rendered.slice(rendered.indexOf(end));
    rendered = `${before}\n${fragments[name]}\n${after}`;
  }
  return rendered;
}

export function staticPageShell(html) {
  extractStaticFragments(html);
  let shell = html;
  for (const name of STATIC_FRAGMENT_NAMES) {
    const start = markerStart(name);
    const end = markerEnd(name);
    shell = `${shell.slice(0, shell.indexOf(start) + start.length)}\n${shell.slice(shell.indexOf(end))}`;
  }
  return shell;
}

export function assertStaticPageMatches(html, payload) {
  const actual = extractStaticFragments(html);
  const expected = renderStaticFragments(payload);
  for (const name of STATIC_FRAGMENT_NAMES) {
    if (actual[name] !== expected[name]) throw new Error(`STATIC_RENDER_MISMATCH:${name}`);
  }
  return true;
}
