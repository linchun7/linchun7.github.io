import {
  canonicalTierDefinition,
  publicationDateKey,
  validatePayload,
  validatePriceHistoryConsistency
} from './data-contract.js?v=f8779a1b';
import { createIcons } from './vendor/lucide-subset.js?v=1afb95ee';
import { VALID_REGIONS } from './data-model.js?v=1df20253';

const REQUEST_TIMEOUT_MS = 8_000;
const ANALYTICS_ID = 'G-K2S9L4CHNP';
const SLOW_LOADING_MS = 1_500;
const DEFAULT_SORT_TIER = '200GB';
const DEFAULT_TIER_COLUMN_COUNT = 5;
const FIXED_PRICE_TABLE_COLUMN_COUNT = 2;
const PRICE_FRESH_MAX_AGE_MS = 36 * 60 * 60 * 1_000;
const PRICE_HARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PRICE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_RESPONSE_BYTES = Object.freeze({
  'prices.json': 1024 * 1024,
  'history.json': 8 * 1024 * 1024
});
const MAX_SEARCH_QUERY_CODE_POINTS = 160;
const REGION_LABELS = {
  Americas: '美洲',
  'Europe, Middle East & Africa': '欧洲、中东和非洲',
  'Asia Pacific': '亚太'
};
const URL_STATE_REGIONS = new Set(VALID_REGIONS);
const initialUrlState = new URLSearchParams(location.search);
const initialQuery = boundedSearchQuery(initialUrlState.get('q') ?? '');
const sanitizedInitialUrl = createSanitizedStateUrl();
if (sanitizedInitialUrl.href !== location.href) history.replaceState(null, '', sanitizedInitialUrl);
const initialSortKey = initialUrlState.get('sort') === 'country' ? 'country' : 'tier';
const initialSortDirection = initialUrlState.get('dir') === 'desc' ? 'desc' : 'asc';

const state = {
  data: null,
  history: null,
  sortTier: canonicalUrlTier(initialUrlState.get('tier')) ?? DEFAULT_SORT_TIER,
  query: initialQuery,
  region: canonicalUrlRegion(initialUrlState.get('region')) ?? 'all',
  sortKey: initialSortKey,
  sortDirection: initialSortDirection,
  activeCountry: null,
  historyTier: DEFAULT_SORT_TIER,
  minimumPrices: {},
  minimumCountries: {},
  dataOrigin: null,
  dataFreshness: null,
  minimumCuesEnabled: true,
  minimumCuesReason: null,
  eventsBound: false,
  loading: false,
  historyStatus: 'idle',
  historyRequestId: 0,
  historyPromise: null,
  historyReturnFocus: null,
  historyReturnCountry: null,
  publishedDateReturnFocus: null,
  renderFrame: null,
  scrollFrame: null,
  minimumHighlightTimer: null
};

const elements = {
  historyTierControl: document.querySelector('#historyTierControl'),
  mobileTierControl: document.querySelector('#mobileTierControl'),
  searchInput: document.querySelector('#searchInput'),
  regionSelect: document.querySelector('#regionSelect'),
  resultSummary: document.querySelector('#resultSummary'),
  rankingScopeNote: document.querySelector('#rankingScopeNote'),
  rankHeaderLabel: document.querySelector('#rankHeaderLabel'),
  loadStatus: document.querySelector('#loadStatus'),
  loadStatusText: document.querySelector('#loadStatusText'),
  retryButton: document.querySelector('#retryButton'),
  workspace: document.querySelector('.workspace'),
  workspaceToolbar: document.querySelector('.workspace-toolbar'),
  backToTableButton: document.querySelector('#backToTableButton'),
  minimumSummary: document.querySelector('#minimumSummary'),
  overviewTitle: document.querySelector('#overviewTitle'),
  overviewNote: document.querySelector('.overview-note'),
  fxStatus: document.querySelector('#fxStatus'),
  publishedDateButton: document.querySelector('#publishedDateButton'),
  applePublishedDate: document.querySelector('#applePublishedDate'),
  updatedAt: document.querySelector('#updatedAt'),
  marketCount: document.querySelector('#marketCount'),
  currencyCount: document.querySelector('#currencyCount'),
  tierCount: document.querySelector('#tierCount'),
  dataStatus: document.querySelector('.data-status'),
  priceRows: document.querySelector('#priceRows'),
  historyDialog: document.querySelector('#historyDialog'),
  historyTitle: document.querySelector('#historyTitle'),
  historySubtitle: document.querySelector('#historySubtitle'),
  historyLocalPrice: document.querySelector('#historyLocalPrice'),
  historyCnyPrice: document.querySelector('#historyCnyPrice'),
  historyEventCount: document.querySelector('#historyEventCount'),
  historyRows: document.querySelector('#historyRows'),
  publishedDateDialog: document.querySelector('#publishedDateDialog'),
  closePublishedDate: document.querySelector('#closePublishedDate'),
  publishedDateDialogCurrent: document.querySelector('#publishedDateDialogCurrent'),
  publishedDateRows: document.querySelector('#publishedDateRows')
};

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
let slowLoadingTimer = null;
let freshnessBoundaryTimer = null;
let freshnessRefreshPromise = null;
let analyticsScheduled = false;
const staticSnapshotMeta = document.querySelector('meta[name="icloud-price-snapshot"]');
const staticSnapshotGeneratedAt = staticSnapshotMeta?.content ?? null;
const staticSnapshotFxStale = staticSnapshotMeta?.dataset.fxStale === 'true';
const hasStaticSnapshot = /^\d{4}-\d{2}-\d{2}T/.test(staticSnapshotGeneratedAt ?? '')
  && /^[a-f0-9]{64}$/.test(staticSnapshotMeta?.dataset.fingerprint ?? '');

function refreshIcons() {
  try {
    createIcons({ attrs: { 'stroke-width': 1.8 } });
  } catch (error) {
    console.warn(`图标加载失败：${error.message}`);
  }
}

function analyticsTag() {
  globalThis.dataLayer = globalThis.dataLayer || [];
  globalThis.dataLayer.push(arguments);
}

function boundedSearchQuery(value) {
  return [...String(value).slice(0, MAX_SEARCH_QUERY_CODE_POINTS * 2)]
    .slice(0, MAX_SEARCH_QUERY_CODE_POINTS)
    .join('');
}

function canonicalUrlTier(value) {
  if (typeof value !== 'string' || value.length > 32) return null;
  return canonicalTierDefinition(value)?.id === value ? value : null;
}

function canonicalUrlRegion(value) {
  return URL_STATE_REGIONS.has(value) ? value : null;
}

function serializePriceStateUrl(url, { sortTier, sortKey, sortDirection, region }) {
  const serialized = new URL(url);
  const tier = canonicalUrlTier(sortTier);
  const canonicalRegion = canonicalUrlRegion(region);

  serialized.search = '';
  if (tier !== null) serialized.searchParams.set('tier', tier);
  if (sortKey === 'country') serialized.searchParams.set('sort', 'country');
  if (sortDirection === 'desc') serialized.searchParams.set('dir', 'desc');
  if (canonicalRegion !== null) serialized.searchParams.set('region', canonicalRegion);
  if (serialized.hash && serialized.hash !== '#priceWorkspace') serialized.hash = '';
  return serialized;
}

function createSanitizedStateUrl() {
  const url = new URL(location.href);
  const serialized = serializePriceStateUrl(url, {
    sortTier: canonicalUrlTier(url.searchParams.get('tier')) ?? DEFAULT_SORT_TIER,
    sortKey: url.searchParams.get('sort') === 'country' ? 'country' : 'tier',
    sortDirection: url.searchParams.get('dir') === 'desc' ? 'desc' : 'asc',
    region: canonicalUrlRegion(url.searchParams.get('region')) ?? 'all'
  });
  return serialized;
}

function loadAnalytics() {
  if (document.querySelector('script[data-analytics-loader]')) return;
  const analyticsUrl = createSanitizedStateUrl();
  analyticsTag('js', new Date());
  analyticsTag('config', ANALYTICS_ID, {
    page_location: analyticsUrl.href,
    allow_google_signals: false,
    allow_ad_personalization_signals: false
  });
  const script = document.createElement('script');
  script.async = true;
  script.fetchPriority = 'low';
  script.dataset.analyticsLoader = 'true';
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(ANALYTICS_ID)}`;
  document.head.append(script);
}

function scheduleAnalytics() {
  if (analyticsScheduled) return;
  analyticsScheduled = true;
  const scheduleWhenIdle = () => {
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(loadAnalytics, { timeout: 3_000 });
    } else {
      globalThis.setTimeout(loadAnalytics, 1_500);
    }
  };
  if (document.readyState === 'complete') scheduleWhenIdle();
  else globalThis.addEventListener('load', scheduleWhenIdle, { once: true });
}

function setLoadStatus(message, { error = false, hidden = false } = {}) {
  if (!elements.loadStatus || !elements.loadStatusText) return;
  elements.loadStatusText.textContent = message;
  elements.loadStatus.classList.toggle('is-error', error);
  elements.loadStatus.hidden = hidden;
  if (elements.retryButton) elements.retryButton.hidden = !error;
  elements.workspace?.setAttribute('aria-busy', String(!hidden && !error));
}

function setFiltersDisabled(disabled) {
  elements.searchInput.disabled = disabled;
  elements.regionSelect.disabled = disabled;
  if (elements.backToTableButton) elements.backToTableButton.disabled = disabled;
  document.querySelectorAll('button[data-sort], button[data-sort-tier], #publishedDateButton, #mobileTierControl button, .country-history-button, .minimum-card').forEach((button) => {
    button.disabled = disabled;
  });
}

async function readBoundedJsonResponse(response, fileName) {
  const maximumBytes = MAX_RESPONSE_BYTES[fileName];
  if (!maximumBytes) throw new Error(`不支持的数据文件：${fileName}`);
  const declaredLength = response.headers.get('content-length');
  if (/^\d+$/.test(declaredLength ?? '') && Number(declaredLength) > maximumBytes) {
    throw new Error(`${fileName} 超过允许大小`);
  }

  const chunks = [];
  let receivedBytes = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${fileName} 超过允许大小`);
      }
      chunks.push(value);
    }
  } else {
    const value = new Uint8Array(await response.arrayBuffer());
    receivedBytes = value.byteLength;
    if (receivedBytes > maximumBytes) throw new Error(`${fileName} 超过允许大小`);
    chunks.push(value);
  }

  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${fileName} 不是有效的 UTF-8`);
  }
  return JSON.parse(text);
}

function formatDate(value) {
  if (!value) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC'
  })
    .format(new Date(`${value.slice(0, 10)}T00:00:00Z`));
}

function formatBeijingDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai'
  }).format(date);
}

function formatBeijingDate(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  const parts = new Intl.DateTimeFormat('en', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai'
  }).formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function formatPublishedDate(value) {
  if (!value) return '--';
  const text = String(value).trim().replace(/^published\s+date\s*:?\s*/i, '');
  const dateOnly = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  const date = dateOnly
    ? new Date(`${dateOnly[1]} ${dateOnly[2]}, ${dateOnly[3]} 00:00:00 UTC`)
    : new Date(text);
  if (Number.isNaN(date.getTime())) return text;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'UTC'
  }).format(date);
}

async function fetchJson(fileName, { forceRefresh = false } = {}) {
  const localUrl = `./data/${fileName}`;
  const urls = [localUrl];

  let lastError;
  for (const url of urls) {
    let timeout = null;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const response = await fetch(url, {
        cache: forceRefresh ? 'reload' : (fileName === 'prices.json' ? 'no-cache' : 'default'),
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = validatePayload(fileName, await readBoundedJsonResponse(response, fileName));
      if (fileName === 'prices.json') validatePriceFreshness(payload);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export function classifyPriceFreshness(data, nowMs = Date.now()) {
  const ageMs = nowMs - Date.parse(data?.generatedAt);
  if (!Number.isFinite(ageMs)) return { status: 'unusable', reason: 'price-expired', ageMs };
  if (ageMs < -MAX_PRICE_FUTURE_SKEW_MS) return { status: 'unusable', reason: 'future-data', ageMs };
  if (ageMs > PRICE_HARD_MAX_AGE_MS) return { status: 'unusable', reason: 'price-expired', ageMs };
  if (ageMs > PRICE_FRESH_MAX_AGE_MS) return { status: 'degraded', reason: 'price-stale', ageMs };
  if (data?.fx?.stale) return { status: 'degraded', reason: 'fx-stale', ageMs };
  return { status: 'fresh', reason: null, ageMs };
}

function validatePriceFreshness(data) {
  const freshness = classifyPriceFreshness(data);
  if (!Number.isFinite(freshness.ageMs)) throw new Error('价格数据生成时间无效');
  if (freshness.reason === 'future-data') throw new Error('价格数据生成时间超过允许的未来偏差');
  if (freshness.reason === 'price-expired') throw new Error('价格数据已超过七天有效期');
  return freshness;
}

function priceSnapshotsEqual(first, second) {
  if (first === second) return true;
  if (!first || !second
    || first.generatedAt !== second.generatedAt
    || first.source?.publishedDate !== second.source?.publishedDate
    || first.fx?.fetchedAt !== second.fx?.fetchedAt) return false;
  return JSON.stringify(first) === JSON.stringify(second);
}

function staticDomMatchesPayload(data) {
  if (!hasStaticSnapshot || data.generatedAt !== staticSnapshotGeneratedAt) return false;
  const tierIds = [...document.querySelectorAll('.price-table thead th[data-tier]')].map(({ dataset }) => dataset.tier);
  if (tierIds.length !== data.tiers.length || tierIds.some((id, index) => id !== data.tiers[index].id)) return false;
  const rows = [...elements.priceRows.querySelectorAll('tr[data-market-id]')];
  if (rows.length !== data.countries.length) return false;
  const countries = new Map(data.countries.map((country) => [country.marketId, country]));
  return rows.every((row) => {
    const country = countries.get(row.dataset.marketId);
    if (!country) return false;
    const cells = [...row.querySelectorAll('.price-cell')];
    return cells.length === data.tiers.length && cells.every((cell) => {
      const plan = country.plans[cell.dataset.tier];
      return plan && cell.querySelector('.price-amount')?.textContent === moneyFormatter.format(plan.cnyPrice)
        && cell.querySelector('.price-local')?.textContent === plan.formattedPrice;
    });
  });
}

function calculateMinimumPrices() {
  state.minimumPrices = {};
  state.minimumCountries = {};
  if (!state.minimumCuesEnabled) return;
  for (const { id } of state.data.tiers) {
    const minimumCountries = state.data.countries
      .filter((country) => country.plans[id].cnyRank === 1)
      .sort((first, second) => first.marketId.localeCompare(second.marketId, 'en'));
    state.minimumCountries[id] = minimumCountries;
    state.minimumPrices[id] = minimumCountries[0]?.plans[id].cnyPrice ?? null;
  }
}

function renderMinimumSummary() {
  if (!elements.minimumSummary) return;
  if (!state.minimumCuesEnabled) {
    const unavailable = document.createElement('p');
    unavailable.className = 'minimum-unavailable cache-stale-notice';
    unavailable.textContent = state.minimumCuesReason === 'fx-stale'
      ? '参考汇率暂未更新，人民币金额使用最近一次可用汇率。'
      : (state.minimumCuesReason === 'price-expired'
        ? '价格已经较久没有更新，暂不作为当前价格比较。'
        : (state.minimumCuesReason === 'future-data'
          ? '数据时间异常，暂不作为当前价格展示。'
          : '价格暂未更新，当前显示最近一次获取的 Apple 标价。'));
    elements.minimumSummary.replaceChildren(unavailable);
    elements.minimumSummary.setAttribute('aria-busy', 'false');
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const tier of state.data.tiers) {
    const winners = state.minimumCountries[tier.id] ?? [];
    const winnerNames = winners.map((winner) => winner.nameZh || winner.country);
    const countryName = winnerNames.length > 3
      ? `${winnerNames.slice(0, 3).join('、')}等 ${winnerNames.length} 个地区`
      : winnerNames.join('、') || '暂无地区';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'minimum-card';
    item.dataset.tier = tier.id;
    const marketId = winners[0]?.marketId;
    if (marketId) item.dataset.marketId = marketId;
    item.title = `查看 ${tier.label} 全球最低价地区`;

    const tierLabel = document.createElement('span');
    tierLabel.className = 'minimum-tier-label';
    tierLabel.textContent = tier.label;
    const country = document.createElement('strong');
    country.className = 'minimum-country';
    country.textContent = countryName;
    const price = document.createElement('small');
    price.className = 'minimum-price';
    price.textContent = formatConverted(state.minimumPrices[tier.id], '¥');
    const action = document.createElement('span');
    action.className = 'visually-hidden';
    action.textContent = '，按该容量从低到高排序并在价格表中定位';
    item.append(tierLabel, country, price, action);
    item.addEventListener('click', () => focusMinimumCountry(tier.id, marketId));
    fragment.append(item);
  }
  elements.minimumSummary.replaceChildren(fragment);
  elements.minimumSummary.setAttribute('aria-busy', 'false');
}

function formatConverted(value, symbol) {
  return value == null ? '暂无汇率' : `${symbol}${moneyFormatter.format(value)}`;
}

function createTierButtons(container, selectedTier, handler) {
  container.replaceChildren();
  container.style.setProperty('--tier-count', String(state.data.tiers.length));
  for (const tier of state.data.tiers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = tier.label;
    button.dataset.tier = tier.id;
    button.setAttribute('aria-pressed', String(tier.id === selectedTier));
    button.addEventListener('click', () => handler(tier.id));
    container.append(button);
  }
}

function populateFilters() {
  elements.regionSelect.querySelectorAll('option:not([value="all"])').forEach((option) => option.remove());
  const regions = [...new Set(state.data.countries.map(({ region }) => region))];
  if (state.region !== 'all' && !regions.includes(state.region)) state.region = 'all';

  for (const region of regions) {
    const option = document.createElement('option');
    option.value = region;
    option.textContent = REGION_LABELS[region] || region;
    elements.regionSelect.append(option);
  }
  elements.regionSelect.value = state.region;
  elements.searchInput.value = state.query;
}

function renderTierHeaders() {
  const row = document.querySelector('.price-table thead tr');
  if (!row) return;
  row.querySelectorAll('[data-tier-placeholder]').forEach((header) => header.remove());
  row.querySelectorAll('th[data-tier-header]').forEach((header) => header.remove());
  for (const tier of state.data.tiers) {
    const header = document.createElement('th');
    header.dataset.tierHeader = 'true';
    header.dataset.tier = tier.id;
    header.classList.toggle('is-active-tier', tier.id === state.sortTier);
    header.scope = 'col';
    header.setAttribute('aria-sort', 'none');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.sortTier = tier.id;
    button.textContent = `${tier.label} / 月 `;
    const icon = document.createElement('i');
    icon.dataset.lucide = 'arrow-up-down';
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    header.append(button);
    row.append(header);
    button.addEventListener('click', () => setTierSort(tier.id));
  }
}

function renderHistoryHeaders() {
  const header = elements.historyRows.closest('table')?.querySelector('#historyTierHeader');
  if (!header) return;
  header.textContent = state.data.tiers.find(({ id }) => id === state.historyTier)?.label ?? state.historyTier;
}

function filteredCountries() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  return state.data.countries.filter((country) => {
    const searchable = `${country.country} ${country.nameZh} ${country.currency} ${REGION_LABELS[country.region] || country.region}`.toLocaleLowerCase('zh-CN');
    return (!query || searchable.includes(query))
      && (state.region === 'all' || country.region === state.region);
  });
}

function sortValue(country) {
  if (state.sortKey === 'country') return country.nameZh || country.country;
  return country.plans[state.sortTier].cnyRank ?? Number.POSITIVE_INFINITY;
}

function sortedCountries() {
  return filteredCountries().sort((a, b) => {
    const first = sortValue(a);
    const second = sortValue(b);
    const comparison = typeof first === 'string' ? collator.compare(first, second) : first - second;
    if (comparison !== 0) return state.sortDirection === 'asc' ? comparison : -comparison;
    return a.marketId.localeCompare(b.marketId, 'en');
  });
}

function createCell(text, className) {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function createPriceCell(country, tierId) {
  const plan = country.plans[tierId];
  const cny = plan.cnyPrice;
  const cell = document.createElement('td');
  cell.className = 'price-cell';
  cell.dataset.tier = tierId;
  cell.classList.toggle('is-active-tier', state.sortTier === tierId);
  if (state.sortKey === 'tier' && state.sortTier === tierId) cell.classList.add('is-sorted');
  const isMinimum = state.minimumCuesEnabled
    && plan.cnyRank === 1;
  if (isMinimum) cell.classList.add('is-minimum');

  const converted = document.createElement('strong');
  converted.className = 'price-cny';
  if (cny == null) {
    converted.textContent = '--';
  } else {
    const symbol = document.createElement('span');
    symbol.className = 'price-symbol';
    symbol.textContent = '¥';
    const amount = document.createElement('span');
    amount.className = 'price-amount';
    amount.textContent = moneyFormatter.format(cny);
    if (isMinimum) {
      const badge = document.createElement('span');
      badge.className = 'minimum-badge';
      badge.textContent = '最低';
      badge.title = '按人民币换算后的全球最低标价';
      converted.append(badge);
    }
    converted.append(symbol, amount);
  }
  const local = document.createElement('span');
  local.className = 'price-local';
  local.textContent = plan.formattedPrice;
  cell.append(converted, local);
  return cell;
}

function alignActiveTierColumn() {
  if (state.sortKey !== 'tier' || matchMedia('(max-width: 1100px)').matches) return;
  requestAnimationFrame(() => {
    const scroller = document.querySelector('.table-scroll');
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    const activeHeader = document.querySelector(`button[data-sort-tier="${state.sortTier}"]`)?.closest('th');
    if (activeHeader) activeHeader.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });
}

function renderTable({ alignTierColumn = true } = {}) {
  const countries = sortedCountries();
  const fragment = document.createDocumentFragment();
  const tier = state.data.tiers.find(({ id }) => id === state.sortTier);
  const direction = state.sortDirection === 'asc' ? '从低到高' : '从高到低';
  const filtered = Boolean(state.query.trim() || state.region !== 'all');
  const countLabel = state.query.trim() ? `找到 ${countries.length} 个地区` : `${countries.length} 个地区`;
  const regionLabel = state.region === 'all' ? null : REGION_LABELS[state.region] || state.region;
  const sortLabel = state.sortKey === 'country'
    ? `按名称${state.sortDirection === 'asc' ? '排序' : '倒序'}`
    : `${tier.label} ${direction}`;
  elements.resultSummary.textContent = [regionLabel, countLabel, sortLabel].filter(Boolean).join(' · ');
  updateRankingPresentation({ filtered });

  if (!countries.length) {
    const row = document.createElement('tr');
    const cell = createCell('没有符合当前条件的结果', 'empty-cell');
    cell.colSpan = state.data.tiers.length + FIXED_PRICE_TABLE_COLUMN_COUNT;
    row.append(cell);
    fragment.append(row);
  } else {
    countries.forEach((country, index) => {
      const row = document.createElement('tr');
      row.dataset.marketId = country.marketId;

      const displayedRank = state.dataFreshness?.status === 'unusable'
        ? '—'
        : (state.sortKey === 'tier' ? country.plans[state.sortTier].cnyRank : index + 1);
      const rank = createCell(String(displayedRank), state.minimumCuesEnabled && displayedRank <= 3 && state.sortKey === 'tier' && state.sortDirection === 'asc' ? 'rank-top' : '');
      const nameCell = document.createElement('td');
      const historyButton = document.createElement('button');
      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
      historyButton.disabled = state.dataFreshness?.status === 'unusable';
      const displayName = country.nameZh || country.country;
      const secondaryName = country.nameZh && country.nameZh !== country.country
        ? `${country.country} · ${country.currency}`
        : '';
      const name = document.createElement('span');
      name.className = 'country-name';
      name.textContent = displayName;
      historyButton.append(name);
      if (secondaryName) {
        const nameEn = document.createElement('span');
        nameEn.className = 'country-name-en';
        nameEn.textContent = secondaryName;
        historyButton.append(nameEn);
      }
      const affordance = document.createElement('span');
      affordance.className = 'history-affordance';
      affordance.setAttribute('aria-hidden', 'true');
      affordance.textContent = '›';
      const historyAction = document.createElement('span');
      historyAction.className = 'visually-hidden';
      historyAction.textContent = '，查看价格历史';
      historyButton.append(affordance, historyAction);
      nameCell.append(historyButton);

      row.append(rank, nameCell, ...state.data.tiers.map(({ id }) => createPriceCell(country, id)));
      fragment.append(row);
    });
  }

  elements.priceRows.replaceChildren(fragment);
  bindRenderedPriceRows();
  updateTierPresentation();
  if (alignTierColumn) {
    alignActiveTierColumn();
  }
}

function bindRenderedPriceRows() {
  for (const row of elements.priceRows.querySelectorAll('tr[data-market-id]')) {
    if (row.dataset.interactive === 'true') continue;
    const country = state.data?.countries.find(({ marketId }) => marketId === row.dataset.marketId);
    const historyButton = row.querySelector('.country-history-button');
    if (!country || !historyButton || historyButton.disabled) continue;
    row.dataset.interactive = 'true';
    historyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openHistory(country, historyButton);
    });
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select')) return;
      openHistory(country, historyButton);
    });
  }
}

function updateRankingPresentation({ filtered = Boolean(state.query.trim() || state.region !== 'all') } = {}) {
  const unusable = state.dataFreshness?.status === 'unusable';
  const tierRanking = state.sortKey === 'tier';
  const notes = [];
  if (unusable) notes.push('排名暂不可用。');
  else if (state.dataFreshness?.reason === 'fx-stale') notes.push('排名基于最近一次可用汇率，仅供参考。');
  else if (state.dataFreshness?.reason === 'price-stale') notes.push('排名为最近一次获取价格时的全球参考排名。');
  if (!unusable && filtered && tierRanking) notes.push('筛选结果中的排名仍对应全部地区。');
  if (elements.rankingScopeNote) {
    elements.rankingScopeNote.textContent = notes.join(' ');
    elements.rankingScopeNote.hidden = notes.length === 0;
  }
  if (!elements.rankHeaderLabel) return;
  if (!tierRanking) {
    elements.rankHeaderLabel.replaceChildren();
    const visible = document.createElement('span');
    visible.setAttribute('aria-hidden', 'true');
    visible.textContent = '序号';
    const accessible = document.createElement('span');
    accessible.className = 'visually-hidden';
    accessible.textContent = '当前列表序号';
    elements.rankHeaderLabel.append(visible, accessible);
    return;
  }
  if (unusable) {
    elements.rankHeaderLabel.textContent = '排名暂不可用';
    return;
  }
  elements.rankHeaderLabel.replaceChildren();
  const visible = document.createElement('span');
  visible.setAttribute('aria-hidden', 'true');
  visible.textContent = '排名';
  const accessible = document.createElement('span');
  accessible.className = 'visually-hidden';
  accessible.textContent = '全球参考排名';
  elements.rankHeaderLabel.append(visible, accessible);
}

function bindStaticControls() {
  document.querySelectorAll('button[data-sort-tier]').forEach((button) => {
    if (button.dataset.interactive === 'true') return;
    button.dataset.interactive = 'true';
    button.addEventListener('click', () => setTierSort(button.dataset.sortTier));
  });
  document.querySelectorAll('.minimum-card[data-tier]').forEach((button) => {
    if (button.dataset.interactive === 'true') return;
    button.dataset.interactive = 'true';
    button.addEventListener('click', () => focusMinimumCountry(button.dataset.tier, button.dataset.marketId));
  });
  bindRenderedPriceRows();
}
function renderSortHeaders({ refresh = true } = {}) {
  document.querySelectorAll('button[data-sort], button[data-sort-tier]').forEach((button) => {
    const header = button.closest('th');
    const active = button.dataset.sort === 'country'
      ? state.sortKey === 'country'
      : state.sortKey === 'tier' && button.dataset.sortTier === state.sortTier;
    header.setAttribute('aria-sort', active ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    const icon = header.querySelector('i, svg');
    if (icon) {
      const replacement = document.createElement('i');
      replacement.dataset.lucide = active ? (state.sortDirection === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down';
      replacement.setAttribute('aria-hidden', 'true');
      icon.replaceWith(replacement);
    }
  });
  if (refresh) refreshIcons();
}

function setCountrySort() {
  if (state.sortKey === 'country') state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  else {
    state.sortKey = 'country';
    state.sortDirection = 'asc';
  }
  updateUrlState();
  renderSortHeaders();
  renderTable();
}

function setTierSort(tier, { forceAscending = false, alignTierColumn = true } = {}) {
  if (!forceAscending && state.sortKey === 'tier' && state.sortTier === tier) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = 'tier';
    state.sortTier = tier;
    state.sortDirection = 'asc';
  }
  updateUrlState();
  renderMobileTierButtons();
  renderSortHeaders();
  renderTable({ alignTierColumn });
}

function renderHistoryTierButtons() {
  createTierButtons(elements.historyTierControl, state.historyTier, (tier) => {
    state.historyTier = tier;
    renderHistoryTierButtons();
    renderHistoryContent();
  });
}

function compactHistorySeries(events, tier) {
  const availableEvents = events.filter((event) => Number.isFinite(event.plans[tier]));
  return availableEvents.filter((event, index) => (
    index === 0
    || event.currency !== availableEvents[index - 1].currency
    || event.plans[tier] !== availableEvents[index - 1].plans[tier]
  ));
}

function renderLocalPriceWithTrend(plan, country, changedSeries) {
  elements.historyLocalPrice.replaceChildren(document.createTextNode(`${plan.formattedPrice} / 月`));
  if (changedSeries.length < 2) return;

  const previous = changedSeries.at(-2);
  const trend = document.createElement('span');
  trend.className = 'price-trend';
  if (previous.currency !== country.currency) {
    trend.classList.add('is-neutral');
    trend.textContent = '（币种已变更）';
    trend.title = `上一次记录使用 ${previous.currency}`;
  } else {
    const previousPrice = previous.plans[state.historyTier];
    if (!Number.isFinite(previousPrice)) {
      trend.classList.add('is-neutral');
      trend.textContent = '（暂无上一期记录）';
      trend.title = '该容量是新发布的方案，暂无上一期价格可比较';
      elements.historyLocalPrice.append(trend);
      return;
    }
    const changePercent = ((plan.price - previousPrice) / previousPrice) * 100;
    const isIncrease = changePercent > 0;
    const absoluteChangePercent = Math.abs(changePercent);
    const percentLabel = absoluteChangePercent < 0.01
      ? '< 0.01'
      : percentFormatter.format(absoluteChangePercent);
    trend.classList.add(isIncrease ? 'is-up' : 'is-down');
    trend.textContent = `（${isIncrease ? '↑' : '↓'} ${percentLabel}%）`;
    trend.title = `与上一次当地月费相比${isIncrease ? '上涨' : '下降'} ${percentLabel}%`;
  }
  elements.historyLocalPrice.append(trend);
}

function renderHistoryRows(record) {
  renderHistoryHeaders();
  elements.historyRows.replaceChildren();
  [...record.events].reverse().forEach((event) => {
    const row = document.createElement('tr');
    row.append(createCell(formatDate(event.observedAt)), createCell(event.currency, 'currency-code'));
    const price = event.plans[state.historyTier];
    row.append(createCell(Number.isFinite(price) ? numberFormatter.format(price) : '--'));
    elements.historyRows.append(row);
  });
}

function getHistoryRecord(country) {
  const record = state.history?.markets?.[country.marketId];
  if (record?.events?.length) return record;
  return {
    nameZh: country.nameZh,
    region: country.region,
    events: [{
      observedAt: formatBeijingDate(state.data.generatedAt),
      currency: country.currency,
      plans: Object.fromEntries(state.data.tiers.map(({ id }) => [id, country.plans[id].price]))
    }]
  };
}

function refreshOpenHistoryViews() {
  renderPublishedDateHistory();
  if (state.activeCountry && elements.historyDialog.open) {
    renderHistorySubtitle(state.activeCountry, getHistoryRecord(state.activeCountry));
    renderHistoryContent();
  }
}

function ensureHistoryLoaded() {
  if (state.historyStatus === 'ready') return Promise.resolve(state.history);
  if (state.historyStatus === 'loading' && state.historyPromise) return state.historyPromise;
  const requestId = state.historyRequestId + 1;
  state.historyRequestId = requestId;
  state.historyStatus = 'loading';
  refreshOpenHistoryViews();
  const request = fetchJson('history.json')
    .then(async (historyData) => {
      if (requestId !== state.historyRequestId) return null;
      try {
        validatePriceHistoryConsistency(state.data, historyData);
      } catch {
        historyData = await fetchJson('history.json', { forceRefresh: true });
        if (requestId !== state.historyRequestId) return null;
        validatePriceHistoryConsistency(state.data, historyData);
      }
      state.history = historyData;
      state.historyStatus = 'ready';
      refreshOpenHistoryViews();
      return historyData;
    })
    .catch((error) => {
      if (requestId !== state.historyRequestId) return null;
      state.history = null;
      state.historyStatus = 'unavailable';
      console.warn(`价格历史加载失败，使用当前价格作为临时记录：${error.message}`);
      refreshOpenHistoryViews();
      return null;
    })
    .finally(() => {
      if (requestId === state.historyRequestId) state.historyPromise = null;
    });
  state.historyPromise = request;
  return request;
}

function getPublishedDateHistory() {
  const entries = state.history?.sourcePublishedDates;
  const historyEntries = Array.isArray(entries) ? [...entries] : [];
  if (!state.data?.source?.publishedDate) return historyEntries;
  const currentEntry = {
    publishedDate: state.data.source.publishedDate,
    observedAt: state.data.run?.observedAtBeijing ?? formatBeijingDate(state.data.generatedAt)
  };
  if (!historyEntries.length) return [currentEntry];
  const currentKey = publicationDateKey(currentEntry.publishedDate);
  const latestHistoryKey = publicationDateKey(historyEntries.at(-1).publishedDate);
  return latestHistoryKey === currentKey ? historyEntries : [...historyEntries, currentEntry];
}

function countryDisplayName(entry) {
  const current = state.data?.countries?.find(({ country }) => country === entry.country);
  return current?.nameZh || entry.nameZh || entry.country;
}

function changedCountryDetails(entry) {
  const details = [];
  if (entry.fromCurrency !== entry.toCurrency) details.push(`币种 ${entry.fromCurrency}→${entry.toCurrency}`);
  if (entry.fromRegion !== entry.toRegion) {
    const fromRegion = REGION_LABELS[entry.fromRegion] || entry.fromRegion;
    const toRegion = REGION_LABELS[entry.toRegion] || entry.toRegion;
    details.push(`分区 ${fromRegion}→${toRegion}`);
  }
  for (const tierChange of entry.tiers || []) {
    const tier = state.data.tiers.find(({ id }) => id === tierChange.id);
    const from = Number.isFinite(tierChange.from) ? `${numberFormatter.format(tierChange.from)} ${entry.fromCurrency}` : '无';
    const to = Number.isFinite(tierChange.to) ? `${numberFormatter.format(tierChange.to)} ${entry.toCurrency}` : '无';
    details.push(`${tier?.label || tierChange.id} ${from}→${to}`);
  }
  return details.join('；');
}

function createPublishedDateChangesCell(changes, isInitial = false) {
  const cell = document.createElement('td');
  cell.className = 'published-change-cell';
  if (isInitial || !changes) {
    cell.textContent = '首次记录';
    return cell;
  }

  const appendGroup = (label, content) => {
    const group = document.createElement('div');
    group.className = 'published-change-group';
    const heading = document.createElement('strong');
    heading.className = 'published-change-heading';
    heading.textContent = `${label}：`;
    group.append(heading, document.createTextNode(content));
    cell.append(group);
  };

  if (changes.addedTiers?.length) {
    appendGroup('新增容量', changes.addedTiers.map(({ label, id }) => label || id).join('、'));
  }
  if (changes.removedTiers?.length) {
    appendGroup('移除容量', changes.removedTiers.map(({ label, id }) => label || id).join('、'));
  }
  if (changes.addedCountries?.length) {
    appendGroup('新增地区', changes.addedCountries.map(countryDisplayName).join('、'));
  }
  if (changes.removedCountries?.length) {
    appendGroup('移除地区', changes.removedCountries.map(countryDisplayName).join('、'));
  }
  if (changes.changedCountries?.length) {
    const group = document.createElement('div');
    group.className = 'published-change-group published-change-country-group';
    const heading = document.createElement('strong');
    heading.className = 'published-change-heading';
    heading.textContent = '地区内容变化：';
    group.append(heading);
    for (const entry of changes.changedCountries) {
      const line = document.createElement('div');
      line.className = 'published-change-country';
      const country = document.createElement('strong');
      country.textContent = countryDisplayName(entry);
      line.append(document.createTextNode('• '), country, document.createTextNode(`（${changedCountryDetails(entry)}）`));
      group.append(line);
    }
    cell.append(group);
  }
  if (!cell.childElementCount) cell.textContent = '页面发布日期发生变化，未检测到价格、地区或容量变化';
  return cell;
}

function renderPublishedDateHistory() {
  if (!state.data || !elements.applePublishedDate) return;
  const entries = getPublishedDateHistory();
  const latest = state.data.source.publishedDate;
  const displayedDate = formatPublishedDate(latest);
  elements.applePublishedDate.textContent = displayedDate;
  elements.publishedDateDialogCurrent.textContent = displayedDate;
  elements.publishedDateRows.replaceChildren();

  if (state.historyStatus !== 'ready') {
    const row = document.createElement('tr');
    const message = state.historyStatus === 'loading'
      ? '发布日期记录正在读取'
      : '暂时无法读取发布日期记录';
    const cell = createCell(message, 'empty-cell');
    cell.colSpan = 2;
    row.append(cell);
    elements.publishedDateRows.append(row);
    return;
  }

  if (!entries.length) {
    const row = document.createElement('tr');
    const cell = createCell('暂无页面发布日期记录', 'empty-cell');
    cell.colSpan = 2;
    row.append(cell);
    elements.publishedDateRows.append(row);
    return;
  }

  [...entries].reverse().forEach((entry) => {
    const row = document.createElement('tr');
    row.append(
      createCell(formatPublishedDate(entry.publishedDate)),
      createPublishedDateChangesCell(entry.changes, entry.kind === 'initial')
    );
    elements.publishedDateRows.append(row);
  });
}

function openPublishedDateHistory() {
  state.publishedDateReturnFocus = elements.publishedDateButton;
  void ensureHistoryLoaded();
  renderPublishedDateHistory();
  elements.publishedDateDialog.showModal();
  refreshIcons();
}

function renderHistorySubtitle(country, record) {
  const historyState = state.historyStatus === 'loading'
    ? ' · 正在读取历史记录'
    : state.historyStatus === 'unavailable'
      ? ' · 暂时无法读取历史记录，先显示当前价格'
      : '';
  elements.historySubtitle.textContent = `${country.country} · ${REGION_LABELS[country.region] || country.region} · 记录自 ${formatDate(record.events[0].observedAt)}${historyState}`;
}

function renderHistoryContent() {
  const country = state.activeCountry;
  const record = getHistoryRecord(country);
  const plan = country.plans[state.historyTier];
  const cny = plan.cnyPrice;
  const changedSeries = compactHistorySeries(record.events, state.historyTier);

  renderLocalPriceWithTrend(plan, country, changedSeries);
  elements.historyCnyPrice.textContent = formatConverted(cny, '¥');
  elements.historyEventCount.textContent = `${Math.max(changedSeries.length - 1, 0)} 次`;
  renderHistoryRows(record);
}

function openHistory(country, returnFocus = null) {
  if (state.dataFreshness?.status === 'unusable') return;
  void ensureHistoryLoaded();
  const record = getHistoryRecord(country);
  state.activeCountry = country;
  state.historyReturnFocus = returnFocus;
  state.historyReturnCountry = country.marketId;
  state.historyTier = state.sortTier;
  elements.historyTitle.textContent = country.nameZh || country.country;
  renderHistorySubtitle(country, record);
  renderHistoryTierButtons();
  renderHistoryContent();
  elements.historyDialog.showModal();
  refreshIcons();
}

function syncActiveHistoryCountry() {
  const activeMarketId = state.activeCountry?.marketId;
  if (!activeMarketId) return;
  const currentCountry = state.data.countries.find(({ marketId }) => marketId === activeMarketId);
  if (!currentCountry) {
    state.activeCountry = null;
    if (elements.historyDialog.open) elements.historyDialog.close();
    return;
  }

  state.activeCountry = currentCountry;
  if (!elements.historyDialog.open) return;
  elements.historyTitle.textContent = currentCountry.nameZh || currentCountry.country;
  const record = getHistoryRecord(currentCountry);
  renderHistorySubtitle(currentCountry, record);
  renderHistoryTierButtons();
  renderHistoryContent();
}


function updateUrlState() {
  const url = serializePriceStateUrl(location.href, {
    sortTier: state.sortTier,
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
    region: state.region
  });
  history.replaceState(null, '', url);
}

function renderMobileTierButtons() {
  if (!elements.mobileTierControl || !state.data) return;
  createTierButtons(elements.mobileTierControl, state.sortTier, (tier) => {
    setTierSort(tier, { forceAscending: true });
  });
}

function updateTierPresentation() {
  document.querySelectorAll('.price-table [data-tier]').forEach((element) => {
    element.classList.toggle('is-active-tier', element.dataset.tier === state.sortTier);
  });
}

function scheduleQueryRender(value) {
  const query = boundedSearchQuery(value);
  state.query = query;
  elements.searchInput.value = query;
  updateUrlState();
  if (state.renderFrame) cancelAnimationFrame(state.renderFrame);
  state.renderFrame = requestAnimationFrame(() => {
    state.renderFrame = null;
    renderTable();
  });
}

function clearMinimumHighlight() {
  if (state.minimumHighlightTimer !== null) {
    clearTimeout(state.minimumHighlightTimer);
    state.minimumHighlightTimer = null;
  }

  elements.priceRows
    .querySelectorAll('tr.is-highlighted')
    .forEach((row) => {
      row.classList.remove('is-highlighted');
    });
}

function focusMinimumCountry(tierId, marketId) {
  if (!state.data || !tierId || !marketId) return;

  const tierExists = state.data.tiers.some(
    ({ id }) => id === tierId
  );

  const marketExists = state.data.countries.some(
    (country) => country.marketId === marketId
  );

  if (!tierExists || !marketExists) return;

  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = null;
  }

  state.query = '';
  state.region = 'all';

  elements.searchInput.value = '';
  elements.regionSelect.value = 'all';

  setTierSort(tierId, {
    forceAscending: true,
    alignTierColumn: false
  });

  revealMinimumTarget(tierId, marketId);
}

function revealMinimumTarget(tierId, marketId) {
  if (!marketId) return false;

  const row = [
    ...elements.priceRows.querySelectorAll(
      'tr[data-market-id]'
    )
  ].find(
    (item) => item.dataset.marketId === marketId
  );

  if (!row) return false;

  const targetCell = row.querySelector(
    `.price-cell[data-tier="${tierId}"]`
  );

  if (!targetCell) return false;

  clearMinimumHighlight();

  row.classList.add('is-highlighted');

  row.scrollIntoView({
    behavior: 'auto',
    block: 'center',
    inline: 'nearest'
  });

  const historyButton =
    row.querySelector('.country-history-button');

  historyButton?.focus({
    preventScroll: true
  });

  state.minimumHighlightTimer = setTimeout(() => {
    row.classList.remove('is-highlighted');

    if (state.minimumHighlightTimer !== null) {
      state.minimumHighlightTimer = null;
    }
  }, 1800);

  return true;
}

function setBackToTableVisible(visible) {
  if (!elements.backToTableButton) return;
  elements.backToTableButton.classList.toggle('is-visible', visible);
  elements.backToTableButton.setAttribute('aria-hidden', String(!visible));
  elements.backToTableButton.tabIndex = visible ? 0 : -1;
}

function updateBackToTableButton() {
  if (!elements.workspaceToolbar || !elements.workspace || !state.data) {
    setBackToTableVisible(false);
    return;
  }
  const toolbarRect = elements.workspaceToolbar.getBoundingClientRect();
  const workspaceRect = elements.workspace.getBoundingClientRect();
  const buttonHasFocus = document.activeElement === elements.backToTableButton;
  setBackToTableVisible(buttonHasFocus || (toolbarRect.bottom < 8 && workspaceRect.bottom > 120));
}

function scheduleBackToTableUpdate() {
  if (state.scrollFrame) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = null;
    updateBackToTableButton();
  });
}

function clearFreshnessBoundary() {
  clearTimeout(freshnessBoundaryTimer);
  freshnessBoundaryTimer = null;
}

function scheduleFreshnessBoundary() {
  clearFreshnessBoundary();
  if (!state.data || state.dataFreshness?.status === 'unusable') return;
  const generatedAtMs = Date.parse(state.data.generatedAt);
  const nowMs = Date.now();
  const boundaries = [
    generatedAtMs + PRICE_FRESH_MAX_AGE_MS + 1,
    generatedAtMs + PRICE_HARD_MAX_AGE_MS + 1
  ];
  const nextBoundary = boundaries.find((boundary) => boundary > nowMs);
  if (!nextBoundary) return;
  freshnessBoundaryTimer = setTimeout(() => {
    freshnessBoundaryTimer = null;
    void refreshPriceFreshnessLifecycle();
  }, nextBoundary - nowMs);
}

function normalizeCurrentPriceFreshnessUi() {
  const freshness = state.dataFreshness;
  state.minimumCuesReason = freshness.reason;
  state.minimumCuesEnabled = freshness.status === 'fresh';
  if (elements.overviewTitle) {
    elements.overviewTitle.textContent = '各容量全球最低价';
  }
  if (elements.overviewNote) {
    elements.overviewNote.textContent = freshness.reason === 'price-stale'
      ? '价格暂未更新，当前显示最近一次获取的 Apple 标价。'
      : (freshness.reason === 'fx-stale'
        ? '参考汇率暂未更新，人民币金额使用最近一次可用汇率。'
        : '按人民币换算，方便比较不同地区价格。');
  }
  const dataUpdatedAt = formatBeijingDateTime(state.data.generatedAt);
  const fxUpdatedAt = formatBeijingDateTime(state.data.fx.fetchedAt);
  elements.updatedAt.textContent = `更新于 ${dataUpdatedAt}`;
  elements.updatedAt.title = '北京时间';
  elements.fxStatus.textContent = `汇率更新：${fxUpdatedAt}`;
  elements.dataStatus.classList.remove('is-error', 'is-stale');
  const freshnessWarning = freshness.reason === 'price-stale'
    ? '价格暂未更新'
    : (freshness.reason === 'fx-stale' ? '参考汇率暂未更新' : null);
  if (freshnessWarning) {
    elements.dataStatus.classList.add('is-stale');
    const warning = document.createElement('span');
    warning.className = 'freshness-warning';
    warning.textContent = freshnessWarning;
    elements.updatedAt.append(warning);
  }
  updateRankingPresentation();
}

function renderCurrentPriceFreshness() {
  normalizeCurrentPriceFreshnessUi();
  calculateMinimumPrices();
  renderSortHeaders({ refresh: false });
  renderMinimumSummary();
  renderTable();
  updateUrlState();
  scheduleBackToTableUpdate();
  refreshIcons();
}

function applyCurrentPriceFreshness() {
  const previousFreshness = state.dataFreshness;
  const freshness = classifyPriceFreshness(state.data);
  state.dataFreshness = freshness;
  if (freshness.status === 'unusable') {
    clearFreshnessBoundary();
    return freshness;
  }
  if (previousFreshness?.status !== freshness.status || previousFreshness?.reason !== freshness.reason) {
    renderCurrentPriceFreshness();
  }
  scheduleFreshnessBoundary();
  return freshness;
}

function resetHistoryForPriceSnapshot() {
  state.historyRequestId += 1;
  state.history = null;
  state.historyStatus = 'idle';
  state.historyPromise = null;
}

function applyPriceData(data, { origin = 'network' } = {}) {
  const freshness = classifyPriceFreshness(data);
  if (freshness.status === 'unusable') throw new Error(`价格数据不可用：${freshness.reason}`);
  const snapshotChanged = !priceSnapshotsEqual(state.data, data);
  if (snapshotChanged) resetHistoryForPriceSnapshot();
  clearFreshnessBoundary();
  state.data = data;
  state.dataOrigin = origin;
  if (!state.data.tiers.some(({ id }) => id === state.sortTier)) {
    state.sortTier = state.data.tiers.find(({ id }) => id === DEFAULT_SORT_TIER)?.id || state.data.tiers[0].id;
  }
  state.historyTier = state.sortTier;
  syncActiveHistoryCountry();
  populateFilters();
  bindEvents();
  setFiltersDisabled(false);
  elements.marketCount.textContent = `${state.data.countries.length} 个地区`;
  elements.currencyCount.textContent = `${new Set(state.data.countries.map(({ currency }) => currency)).size} 种`;
  elements.tierCount.textContent = `${state.data.tiers.length} 档`;
  renderTierHeaders();
  renderMobileTierButtons();
  renderPublishedDateHistory();
  state.dataFreshness = freshness;
  renderCurrentPriceFreshness();
  scheduleFreshnessBoundary();
  if (elements.historyDialog.open || elements.publishedDateDialog.open) void ensureHistoryLoaded();
}

function hydrateStaticPriceData(data) {
  const freshness = classifyPriceFreshness(data);
  if (freshness.status === 'unusable') throw new Error(`价格数据不可用：${freshness.reason}`);
  state.data = data;
  state.dataOrigin = 'static-network';
  state.dataFreshness = freshness;
  if (!state.data.tiers.some(({ id }) => id === state.sortTier)) {
    state.sortTier = state.data.tiers.find(({ id }) => id === DEFAULT_SORT_TIER)?.id || state.data.tiers[0].id;
  }
  state.historyTier = state.sortTier;
  populateFilters();
  bindEvents();
  bindStaticControls();
  calculateMinimumPrices();
  renderMobileTierButtons();
  renderPublishedDateHistory();
  setFiltersDisabled(false);
  bindRenderedPriceRows();
  const preferredTier = state.data.tiers.find(({ id }) => id === DEFAULT_SORT_TIER)?.id || state.data.tiers[0].id;
  if (freshness.status !== 'fresh' || state.query || state.region !== 'all' || state.sortKey !== 'tier' || state.sortTier !== preferredTier || state.sortDirection !== 'asc') {
    renderCurrentPriceFreshness();
  } else {
    normalizeCurrentPriceFreshnessUi();
    renderSortHeaders({ refresh: false });
    updateTierPresentation();
    refreshIcons();
  }
  scheduleFreshnessBoundary();
}

const DIALOG_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

function trapDialogFocus(dialog, event) {
  if (event.key !== 'Tab' || !dialog.open) return;
  const focusable = [...dialog.querySelectorAll(DIALOG_FOCUSABLE_SELECTOR)].filter((element) => {
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable.at(-1);
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;
  elements.searchInput.addEventListener('input', (event) => scheduleQueryRender(event.target.value));
  elements.regionSelect.addEventListener('change', (event) => {
    state.region = event.target.value;
    updateUrlState();
    renderTable();
  });
  document.querySelector('button[data-sort="country"]').addEventListener('click', setCountrySort);
  elements.backToTableButton?.addEventListener('click', () => {
    elements.workspaceToolbar.scrollIntoView({
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
    elements.workspace.focus({ preventScroll: true });
  });
  document.querySelector('#closeHistory').addEventListener('click', () => elements.historyDialog.close());
  elements.historyDialog.addEventListener('click', (event) => {
    if (event.target === elements.historyDialog) elements.historyDialog.close();
  });
  elements.historyDialog.addEventListener('keydown', (event) => trapDialogFocus(elements.historyDialog, event));
  elements.publishedDateButton.addEventListener('click', openPublishedDateHistory);
  elements.closePublishedDate.addEventListener('click', () => elements.publishedDateDialog.close());
  elements.publishedDateDialog.addEventListener('click', (event) => {
    if (event.target === elements.publishedDateDialog) elements.publishedDateDialog.close();
  });
  elements.publishedDateDialog.addEventListener('keydown', (event) => trapDialogFocus(elements.publishedDateDialog, event));
  elements.historyDialog.addEventListener('close', () => {
    const returnFocus = state.historyReturnFocus;
    const returnCountry = state.historyReturnCountry;
    state.historyReturnFocus = null;
    state.historyReturnCountry = null;
    requestAnimationFrame(() => {
      const currentButton = returnCountry
        ? [...elements.priceRows.querySelectorAll('tr[data-market-id]')].find((row) => row.dataset.marketId === returnCountry)?.querySelector('.country-history-button')
        : null;
      if (returnFocus?.isConnected) returnFocus.focus();
      else if (currentButton) currentButton.focus();
      else elements.workspace.focus();
    });
  });
  elements.publishedDateDialog.addEventListener('close', () => {
    const returnFocus = state.publishedDateReturnFocus;
    state.publishedDateReturnFocus = null;
    if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
  });
  addEventListener('scroll', scheduleBackToTableUpdate, { passive: true });
  addEventListener('resize', () => {
    scheduleBackToTableUpdate();
    updateTierPresentation();
  }, { passive: true });
}

function showLoadError(error) {
  console.error(error);
  elements.dataStatus.classList.add('is-error');
  elements.updatedAt.textContent = '价格数据暂时无法读取，请稍后重试。';
  elements.resultSummary.textContent = '暂时无法读取价格';
  setLoadStatus('价格数据暂时无法读取，请稍后重试。', { error: true });
  setFiltersDisabled(true);
  elements.fxStatus.textContent = '';
  if (elements.minimumSummary) {
    const unavailable = document.createElement('p');
    unavailable.className = 'minimum-unavailable';
    unavailable.textContent = '全球最低价暂不可用';
    elements.minimumSummary.replaceChildren(unavailable);
    elements.minimumSummary.setAttribute('aria-busy', 'false');
  }
  elements.priceRows.replaceChildren();
  const row = document.createElement('tr');
  const cell = createCell('请稍后重试', 'empty-cell');
  cell.colSpan = (state.data?.tiers?.length || DEFAULT_TIER_COLUMN_COUNT) + FIXED_PRICE_TABLE_COLUMN_COUNT;
  row.append(cell);
  elements.priceRows.append(row);
}

function showUnusableDataError(reason) {
  const message = reason === 'future-data'
    ? '数据时间异常，暂不作为当前价格展示。请稍后重试。'
    : '价格已经较久没有更新，暂不作为当前价格比较。请稍后重试。';
  elements.dataStatus.classList.add('is-error');
  if (elements.historyDialog.open) elements.historyDialog.close();
  elements.updatedAt.textContent = message;
  setLoadStatus(message, { error: true });
  state.minimumCuesEnabled = false;
  state.minimumCuesReason = reason;
  calculateMinimumPrices();
  renderMinimumSummary();
  renderTable();
  setFiltersDisabled(true);
}

async function refreshPriceFreshnessLifecycle() {
  if (!state.data) return;
  const freshness = applyCurrentPriceFreshness();
  if (freshness.status !== 'unusable') return;
  showUnusableDataError(freshness.reason);
  if (!freshnessRefreshPromise) {
    freshnessRefreshPromise = initialize({ forceRefresh: true })
      .finally(() => { freshnessRefreshPromise = null; });
  }
  await freshnessRefreshPromise;
}

async function initialize({ forceRefresh = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  clearTimeout(slowLoadingTimer);
  setLoadStatus('正在检查最新价格…');
  if (!state.data) setFiltersDisabled(true);
  elements.dataStatus.classList.remove('is-error');

  const fallbackData = state.data;

  slowLoadingTimer = setTimeout(() => {
    setLoadStatus(hasStaticSnapshot || fallbackData
      ? '正在检查更新，当前价格仍可查看'
      : '网络连接较慢，请稍候…');
  }, SLOW_LOADING_MS);

  try {
    const networkData = await fetchJson('prices.json', { forceRefresh });
    if (!state.data && staticDomMatchesPayload(networkData)) {
      hydrateStaticPriceData(networkData);
    } else if (!state.data && hasStaticSnapshot && Date.parse(networkData.generatedAt) < Date.parse(staticSnapshotGeneratedAt)) {
      throw new Error('网络价格数据早于当前静态页面');
    } else if (!priceSnapshotsEqual(state.data, networkData)) {
      applyPriceData(networkData, { origin: 'network' });
    } else {
      state.dataOrigin = 'network';
      applyCurrentPriceFreshness();
      normalizeCurrentPriceFreshnessUi();
      setFiltersDisabled(false);
    }
    setLoadStatus('', { hidden: true });
  } catch (error) {
    if (fallbackData) {
      const fallbackFreshness = classifyPriceFreshness(fallbackData);
      if (fallbackFreshness.status === 'unusable') {
        state.dataFreshness = fallbackFreshness;
        showUnusableDataError(fallbackFreshness.reason);
        return;
      }
      console.warn(`网络价格刷新失败，继续显示现有数据：${error.message}`);
      if (state.data !== fallbackData) applyPriceData(fallbackData, { origin: state.dataOrigin ?? 'network' });
      elements.dataStatus.classList.add('is-stale');
      const warning = document.createElement('span');
      warning.className = 'freshness-warning cache-warning';
      warning.textContent = '暂时无法获取更新';
      elements.updatedAt.append(warning);
      setLoadStatus('暂时无法获取更新，当前显示最近一次可用价格', { error: true });
      setFiltersDisabled(false);
    } else if (hasStaticSnapshot) {
      console.warn(`网络价格刷新失败，继续显示静态价格：${error.message}`);
      const staticFreshness = classifyPriceFreshness({ generatedAt: staticSnapshotGeneratedAt, fx: { stale: staticSnapshotFxStale } });
      if (staticFreshness.status === 'unusable') {
        const message = staticFreshness.reason === 'future-data'
          ? '数据时间异常，暂不作为当前价格展示。请稍后重试。'
          : '价格已经较久没有更新，暂不作为当前价格比较。请稍后重试。';
        elements.dataStatus.classList.add('is-error');
        elements.updatedAt.textContent = message;
        document.querySelectorAll('.minimum-badge').forEach((badge) => badge.remove());
        document.querySelectorAll('.is-minimum, .rank-top').forEach((element) => element.classList.remove('is-minimum', 'rank-top'));
        document.querySelectorAll('.price-table tbody tr[data-market-id] > td:first-child').forEach((cell) => { cell.textContent = '—'; });
        if (elements.rankHeaderLabel) elements.rankHeaderLabel.textContent = '排名暂不可用';
        if (elements.rankingScopeNote) {
          elements.rankingScopeNote.textContent = '排名暂不可用。';
          elements.rankingScopeNote.hidden = false;
        }
        setLoadStatus(message, { error: true });
        return;
      }
      if (staticFreshness.reason === 'fx-stale') {
        document.querySelectorAll('.minimum-badge').forEach((badge) => badge.remove());
        document.querySelectorAll('.is-minimum, .rank-top').forEach((element) => element.classList.remove('is-minimum', 'rank-top'));
        if (elements.rankingScopeNote) {
          elements.rankingScopeNote.textContent = '排名基于最近一次可用汇率，仅供参考。';
          elements.rankingScopeNote.hidden = false;
        }
      }
      elements.dataStatus.classList.add('is-stale');
      const warning = document.createElement('span');
      warning.className = 'freshness-warning cache-warning';
      warning.textContent = '暂时无法获取更新';
      elements.updatedAt.append(warning);
      setLoadStatus('暂时无法获取更新，当前显示最近一次可用价格', { error: true });
    } else {
      showLoadError(error);
    }
  } finally {
    clearTimeout(slowLoadingTimer);
    slowLoadingTimer = null;
    state.loading = false;
    scheduleAnalytics();
  }
}
elements.retryButton?.addEventListener('click', () => {
  elements.retryButton.hidden = true;
  setLoadStatus('正在检查最新价格…');
  initialize({ forceRefresh: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshPriceFreshnessLifecycle();
});
window.addEventListener('pageshow', () => {
  void refreshPriceFreshnessLifecycle();
});

initialize();
