import {
  canonicalTierDefinition,
  publicationDateKey,
  validatePayload,
  validatePriceHistoryConsistency
} from './data-contract.js?v=a3f395f0';
import { createIcons } from './vendor/lucide-subset.js?v=657f4f9d';
import { VALID_REGIONS } from './data-model.js?v=1df20253';

const REQUEST_TIMEOUT_MS = 8_000;
const CHART_SCRIPT_URL = './vendor/chart.umd.min.js?v=48444a82';
const ANALYTICS_ID = 'G-K2S9L4CHNP';
const SLOW_LOADING_MS = 1_500;
const DEFAULT_SORT_TIER = '200GB';
const DEFAULT_TIER_COLUMN_COUNT = 5;
const FIXED_PRICE_TABLE_COLUMN_COUNT = 2;
const PRICE_CACHE_KEY = 'icloud-price-comparison:validated-prices:v2';
const LEGACY_PRICE_CACHE_KEYS = ['icloud-price-comparison:validated-prices:v1'];
const MAX_PRICE_CACHE_CHARACTERS = 1024 * 1024;
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
const initialQuery = boundedSearchQuery(globalThis.__icloudInitialQuery ?? initialUrlState.get('q') ?? '');
delete globalThis.__icloudInitialQuery;
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
  chart: null,
  eventsBound: false,
  loading: false,
  historyStatus: 'idle',
  historyRequestId: 0,
  historyPromise: null,
  chartRequestId: 0,
  historyReturnFocus: null,
  historyReturnCountry: null,
  publishedDateReturnFocus: null,
  renderFrame: null,
  scrollFrame: null
};

const elements = {
  historyTierControl: document.querySelector('#historyTierControl'),
  mobileTierControl: document.querySelector('#mobileTierControl'),
  searchInput: document.querySelector('#searchInput'),
  regionSelect: document.querySelector('#regionSelect'),
  resultSummary: document.querySelector('#resultSummary'),
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
  chartWrap: document.querySelector('#chartWrap'),
  emptyHistory: document.querySelector('#emptyHistory'),
  chartCurrency: document.querySelector('#chartCurrency'),
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
let chartLibraryPromise = null;
let analyticsScheduled = false;
let initialPriceRequest = globalThis.__icloudInitialPriceRequest ?? null;
delete globalThis.__icloudInitialPriceRequest;

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

function createSanitizedStateUrl() {
  const url = new URL(location.href);
  const tier = canonicalUrlTier(url.searchParams.get('tier'));
  const sort = ['tier', 'country'].includes(url.searchParams.get('sort'))
    ? url.searchParams.get('sort')
    : null;
  const direction = ['asc', 'desc'].includes(url.searchParams.get('dir'))
    ? url.searchParams.get('dir')
    : null;
  const region = canonicalUrlRegion(url.searchParams.get('region'));

  url.search = '';
  if (tier !== null) url.searchParams.set('tier', tier);
  if (sort !== null) url.searchParams.set('sort', sort);
  if (direction !== null) url.searchParams.set('dir', direction);
  if (region !== null) url.searchParams.set('region', region);
  if (url.hash && url.hash !== '#priceWorkspace') url.hash = '';
  return url;
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
  document.querySelectorAll('button[data-sort], button[data-sort-tier], #publishedDateButton, #mobileTierControl button').forEach((button) => {
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
    let finishInitialRequest = null;
    try {
      let response;
      if (!forceRefresh && fileName === 'prices.json' && url === localUrl && initialPriceRequest) {
        const request = initialPriceRequest;
        initialPriceRequest = null;
        const result = await request;
        finishInitialRequest = result.finish ?? null;
        if (result.error) throw result.error;
        response = result.response;
      } else {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        response = await fetch(url, {
          cache: forceRefresh ? 'reload' : (fileName === 'prices.json' ? 'no-cache' : 'default'),
          redirect: 'error',
          signal: controller.signal
        });
      }
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const payload = validatePayload(fileName, await readBoundedJsonResponse(response, fileName));
      if (fileName === 'prices.json') validatePriceFreshness(payload);
      return payload;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
      finishInitialRequest?.();
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

function removeLegacyPriceCaches() {
  for (const key of LEGACY_PRICE_CACHE_KEYS) {
    try { localStorage.removeItem(key); } catch {}
  }
}

function readPriceCache() {
  try {
    const cached = localStorage.getItem(PRICE_CACHE_KEY);
    if (!cached) return null;
    if (cached.length > MAX_PRICE_CACHE_CHARACTERS) throw new Error('价格缓存超过允许大小');
    const data = validatePayload('prices.json', JSON.parse(cached));
    let freshness;
    try {
      freshness = validatePriceFreshness(data);
    } catch (error) {
      localStorage.removeItem(PRICE_CACHE_KEY);
      console.warn('CACHE_EXPIRED');
      return null;
    }
    return {
      data,
      freshness
    };
  } catch (error) {
    console.warn(`已忽略无效价格缓存：${error.message}`);
    try { localStorage.removeItem(PRICE_CACHE_KEY); } catch {}
    return null;
  }
}

function writePriceCache(payload) {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PRICE_CACHE_CHARACTERS) throw new Error('价格缓存超过允许大小');
    localStorage.setItem(PRICE_CACHE_KEY, serialized);
  } catch (error) {
    console.warn(`价格缓存写入失败：${error.message}`);
  }
}

function priceSnapshotsEqual(first, second) {
  if (first === second) return true;
  if (!first || !second
    || first.generatedAt !== second.generatedAt
    || first.source?.publishedDate !== second.source?.publishedDate
    || first.fx?.fetchedAt !== second.fx?.fetchedAt) return false;
  return JSON.stringify(first) === JSON.stringify(second);
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
      ? '当前人民币换算沿用上次成功汇率，参考最低价排名暂不展示。汇率刷新成功后自动恢复。'
      : (state.minimumCuesReason === 'price-expired'
        ? '价格数据已超过 7 天有效期，当前参考最低价不可用。'
        : (state.minimumCuesReason === 'future-data'
          ? '价格数据生成时间无效，当前参考最低价不可用。'
          : '当前价格数据已超过 36 小时，以下价格仅供历史参考。获取新数据后恢复参考最低价排名。'));
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
    const isActiveTier = state.sortKey === 'tier' && state.sortTier === tier.id && state.sortDirection === 'asc';
    item.type = 'button';
    item.className = 'minimum-card';
    item.classList.toggle('is-active-tier', isActiveTier);
    item.dataset.tier = tier.id;
    item.setAttribute('aria-pressed', String(isActiveTier));
    item.title = `查看 ${tier.label} 参考最低价地区`;

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
    action.textContent = '，在价格表中定位';
    item.append(tierLabel, country, price, action);
    item.addEventListener('click', () => focusMinimumCountry(tier.id, winners[0]?.marketId));
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
    button.textContent = tier.label.replace(' ', '');
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
  const row = elements.historyRows.closest('table')?.querySelector('thead tr');
  if (!row) return;
  row.querySelectorAll('[data-history-tier-placeholder]').forEach((header) => header.remove());
  row.querySelectorAll('th[data-history-tier-header]').forEach((header) => header.remove());
  for (const tier of state.data.tiers) {
    const header = document.createElement('th');
    header.dataset.historyTierHeader = 'true';
    header.dataset.tier = tier.id;
    header.classList.toggle('is-active-tier', tier.id === state.historyTier);
    header.scope = 'col';
    header.textContent = tier.label;
    row.append(header);
  }
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
      badge.textContent = '参考最低';
      badge.title = '按本次人民币参考汇率折算后的最低标价';
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

function renderTable() {
  const countries = sortedCountries();
  const fragment = document.createDocumentFragment();
  const tier = state.data.tiers.find(({ id }) => id === state.sortTier);
  const direction = state.sortDirection === 'asc' ? '从低到高' : '从高到低';
  elements.resultSummary.textContent = state.sortKey === 'country'
    ? `按国家和地区名称排序：${state.sortDirection === 'asc' ? '正序' : '倒序'}，共 ${countries.length} 个结果`
    : `按 ${tier.label} 人民币参考价排序：${direction}，共 ${countries.length} 个结果`;

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

      const displayedRank = state.sortKey === 'tier' ? country.plans[state.sortTier].cnyRank : index + 1;
      const rank = createCell(String(displayedRank), state.minimumCuesEnabled && displayedRank <= 3 && state.sortKey === 'tier' && state.sortDirection === 'asc' ? 'rank-top' : '');
      const nameCell = document.createElement('td');
      const historyButton = document.createElement('button');
      historyButton.type = 'button';
      historyButton.className = 'country-history-button';
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
      const historyAction = document.createElement('span');
      historyAction.className = 'visually-hidden';
      historyAction.textContent = '，查看价格历史';
      historyButton.append(historyAction);
      nameCell.append(historyButton);

      row.append(rank, nameCell, ...state.data.tiers.map(({ id }) => createPriceCell(country, id)));
      historyButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openHistory(country, historyButton);
      });
      row.addEventListener('click', (event) => {
        if (event.target.closest('button, a, input, select')) return;
        openHistory(country, historyButton);
      });
      fragment.append(row);
    });
  }

  elements.priceRows.replaceChildren(fragment);
  updateTierPresentation();
  alignActiveTierColumn();
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
  renderMinimumSummary();
  renderSortHeaders();
  renderTable();
}

function setTierSort(tier, { forceAscending = false } = {}) {
  if (!forceAscending && state.sortKey === 'tier' && state.sortTier === tier) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = 'tier';
    state.sortTier = tier;
    state.sortDirection = 'asc';
  }
  updateUrlState();
  renderMinimumSummary();
  renderMobileTierButtons();
  renderSortHeaders();
  renderTable();
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

function loadChartLibrary() {
  if (window.Chart) return Promise.resolve(window.Chart);
  if (chartLibraryPromise) return chartLibraryPromise;
  chartLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHART_SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.Chart) resolve(window.Chart);
      else reject(new Error('Chart.js loaded without exposing Chart'));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error('Chart.js request failed')), { once: true });
    document.head.append(script);
  }).catch((error) => {
    chartLibraryPromise = null;
    throw error;
  });
  return chartLibraryPromise;
}

async function renderChart(record) {
  destroyChart();
  const requestId = ++state.chartRequestId;
  const series = compactHistorySeries(record.events, state.historyTier);
  const currencies = new Set(series.map(({ currency }) => currency));
  const canChart = series.length > 1 && currencies.size === 1;
  elements.chartWrap.hidden = !canChart;
  elements.emptyHistory.hidden = canChart;

  if (!canChart) {
    const message = elements.emptyHistory.querySelector('p');
    message.textContent = currencies.size > 1
      ? '记录中包含币种变化，请通过下方表格查看原始价格。'
      : '当前只有初始记录，尚未检测到该容量的价格变化。';
    refreshIcons();
    return;
  }

  const currency = series[0].currency;
  elements.chartCurrency.textContent = currency;
  const context = document.querySelector('#historyChart');
  const tier = state.data.tiers.find(({ id }) => id === state.historyTier);
  const firstPrice = series[0].plans[state.historyTier];
  const lastPrice = series.at(-1).plans[state.historyTier];
  const trend = lastPrice === firstPrice ? '保持不变' : lastPrice > firstPrice ? '上涨' : '下降';
  context.setAttribute('aria-label', `${state.activeCountry?.nameZh || state.activeCountry?.country || ''} ${tier?.label || state.historyTier} 价格变化图，币种 ${currency}，从 ${numberFormatter.format(firstPrice)} 变为 ${numberFormatter.format(lastPrice)}，${trend}，共 ${series.length} 个记录点。详细数据见下方变更记录。`);
  try {
    const Chart = await loadChartLibrary();
    if (requestId !== state.chartRequestId || !elements.historyDialog.open) return;
    state.chart = new Chart(context, {
      type: 'line',
      data: {
        labels: series.map(({ observedAt }) => formatDate(observedAt)),
        datasets: [{
          data: series.map((event) => event.plans[state.historyTier]),
          borderColor: '#0668d7',
          backgroundColor: 'rgba(6, 104, 215, 0.1)',
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#0668d7',
          pointBorderWidth: 2,
          pointRadius: 4,
          borderWidth: 2,
          stepped: 'before',
          fill: true
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (item) => item.raw == null ? '暂无数据' : `${numberFormatter.format(item.raw)} ${currency}` } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#687078' } },
          y: { beginAtZero: false, grid: { color: '#e7e9eb' }, ticks: { color: '#687078', callback: (value) => numberFormatter.format(value) } }
        }
      }
    });
  } catch (error) {
    if (requestId !== state.chartRequestId) return;
    state.chart = null;
    elements.chartWrap.hidden = true;
    elements.emptyHistory.hidden = false;
    elements.emptyHistory.querySelector('p').textContent = '图表暂时不可用，请通过下方表格查看原始价格。';
    console.warn(`价格历史图表加载失败：${error.message}`);
    refreshIcons();
  }
}

function destroyChart() {
  state.chartRequestId += 1;
  if (!state.chart) return;
  try {
    state.chart.destroy?.();
  } catch (error) {
    console.warn(`价格历史图表清理失败：${error.message}`);
  } finally {
    state.chart = null;
  }
}

function renderHistoryRows(record) {
  renderHistoryHeaders();
  elements.historyRows.replaceChildren();
  [...record.events].reverse().forEach((event) => {
    const row = document.createElement('tr');
    row.append(createCell(formatDate(event.observedAt)), createCell(event.currency, 'currency-code'));
    for (const tier of state.data.tiers) {
      const price = event.plans[tier.id];
      const cell = createCell(Number.isFinite(price) ? numberFormatter.format(price) : '--');
      cell.dataset.historyTier = tier.id;
      cell.classList.toggle('is-active-tier', tier.id === state.historyTier);
      row.append(cell);
    }
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
  if (!cell.childElementCount) cell.textContent = '发布日期变更，未检测到国家或价格变化';
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
      ? '发布日期历史正在加载'
      : '历史数据暂不可用，仅显示当前发布日期';
    const cell = createCell(message, 'empty-cell');
    cell.colSpan = 2;
    row.append(cell);
    elements.publishedDateRows.append(row);
    return;
  }

  if (!entries.length) {
    const row = document.createElement('tr');
    const cell = createCell('暂无发布日期记录', 'empty-cell');
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
    ? ' · 历史数据正在加载，仅临时显示当前价格'
    : state.historyStatus === 'unavailable'
      ? ' · 历史数据暂不可用，仅显示当前价格'
      : '';
  elements.historySubtitle.textContent = `${country.country} · ${REGION_LABELS[country.region] || country.region} · 记录始于 ${formatDate(record.events[0].observedAt)}${historyState}`;
}

function renderHistoryContent() {
  const country = state.activeCountry;
  const record = getHistoryRecord(country);
  const plan = country.plans[state.historyTier];
  const cny = plan.cnyPrice;
  const tier = state.data.tiers.find(({ id }) => id === state.historyTier);
  const changedSeries = compactHistorySeries(record.events, state.historyTier);

  renderLocalPriceWithTrend(plan, country, changedSeries);
  elements.historyCnyPrice.textContent = formatConverted(cny, '¥');
  elements.historyEventCount.textContent = changedSeries.length > 1
    ? `${changedSeries.length - 1} 次 · 最近 ${formatDate(changedSeries.at(-1).observedAt)}`
    : '暂无变化';
  document.querySelector('#chartTitle').textContent = `${tier.label} 价格变化`;
  elements.chartCurrency.textContent = country.currency;
  renderChart(record);
  renderHistoryRows(record);
}

function openHistory(country, returnFocus = null) {
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
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('tier', canonicalUrlTier(state.sortTier) ?? DEFAULT_SORT_TIER);
  url.searchParams.set('sort', state.sortKey === 'country' ? 'country' : 'tier');
  url.searchParams.set('dir', state.sortDirection === 'desc' ? 'desc' : 'asc');
  const region = canonicalUrlRegion(state.region);
  if (region !== null) url.searchParams.set('region', region);
  if (url.hash && url.hash !== '#priceWorkspace') url.hash = '';
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

function focusMinimumCountry(tierId, marketId) {
  if (state.renderFrame) {
    cancelAnimationFrame(state.renderFrame);
    state.renderFrame = null;
  }
  state.query = '';
  state.region = 'all';
  elements.searchInput.value = '';
  elements.regionSelect.value = 'all';
  setTierSort(tierId, { forceAscending: true });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const row = marketId
      ? [...elements.priceRows.querySelectorAll('tr[data-market-id]')].find((item) => item.dataset.marketId === marketId)
      : null;
    if (!row) return;
    row.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
    row.querySelector('.country-history-button')?.focus({ preventScroll: true });
    row.classList.add('is-highlighted');
    setTimeout(() => row.classList.remove('is-highlighted'), 1800);
  }));
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
    elements.overviewTitle.textContent = freshness.reason === 'price-stale'
      ? '历史参考价格'
      : (freshness.reason === 'fx-stale' ? '人民币参考价格' : '各容量参考最低价');
  }
  if (elements.overviewNote) {
    elements.overviewNote.textContent = freshness.reason === 'price-stale'
      ? '价格数据已超过 36 小时，仍可查询、筛选与排序'
      : (freshness.reason === 'fx-stale'
        ? '人民币换算沿用上次成功汇率'
        : '按人民币参考汇率换算，便于横向比较。人民币金额显示保留两位小数，排序及参考排名按四舍五入前的内部换算结果计算。');
  }
  const dataUpdatedAt = formatBeijingDateTime(state.data.generatedAt);
  const fxUpdatedAt = formatBeijingDateTime(state.data.fx.fetchedAt);
  elements.updatedAt.textContent = `\u6570\u636e\u66f4\u65b0\u65f6\u95f4\uff1a${dataUpdatedAt}\uff08\u5317\u4eac\u65f6\u95f4\uff09`;
  elements.fxStatus.textContent = `\u66f4\u65b0\u65f6\u95f4\uff1a${fxUpdatedAt}\uff08\u5317\u4eac\u65f6\u95f4\uff09`;
  elements.dataStatus.classList.remove('is-error', 'is-stale');
  const freshnessWarning = freshness.reason === 'price-stale'
    ? '\u8d85\u8fc7 36 \u5c0f\u65f6'
    : (freshness.reason === 'fx-stale' ? '\u6c47\u7387\u6cbf\u7528\u4e0a\u6b21\u6210\u529f\u7ed3\u679c' : null);
  if (freshnessWarning) {
    elements.dataStatus.classList.add('is-stale');
    const warning = document.createElement('span');
    warning.className = 'freshness-warning';
    warning.textContent = freshnessWarning;
    elements.updatedAt.append(warning);
  }
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
  elements.marketCount.textContent = state.data.countries.length;
  elements.currencyCount.textContent = new Set(state.data.countries.map(({ currency }) => currency)).size;
  elements.tierCount.textContent = state.data.tiers.length;
  renderTierHeaders();
  renderMobileTierButtons();
  renderPublishedDateHistory();
  state.dataFreshness = freshness;
  renderCurrentPriceFreshness();
  scheduleFreshnessBoundary();
  if (elements.historyDialog.open || elements.publishedDateDialog.open) void ensureHistoryLoaded();
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
    destroyChart();
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
  elements.updatedAt.textContent = '价格数据无法加载，请检查网络后重试。';
  elements.resultSummary.textContent = '暂时无法读取价格数据';
  setLoadStatus('价格数据无法加载，请检查网络后重试。', { error: true });
  setFiltersDisabled(true);
  elements.fxStatus.textContent = '';
  if (elements.minimumSummary) {
    const unavailable = document.createElement('p');
    unavailable.className = 'minimum-unavailable';
    unavailable.textContent = '参考最低价暂不可用';
    elements.minimumSummary.replaceChildren(unavailable);
    elements.minimumSummary.setAttribute('aria-busy', 'false');
  }
  elements.priceRows.replaceChildren();
  const row = document.createElement('tr');
  const cell = createCell('请稍后刷新页面重试', 'empty-cell');
  cell.colSpan = (state.data?.tiers?.length || DEFAULT_TIER_COLUMN_COUNT) + FIXED_PRICE_TABLE_COLUMN_COUNT;
  row.append(cell);
  elements.priceRows.append(row);
}

function showUnusableDataError(reason) {
  const message = reason === 'future-data'
    ? '价格数据生成时间超过允许的未来偏差，无法作为当前比较数据使用。请重新加载。'
    : '价格数据已超过 7 天有效期，无法继续作为当前比较数据使用。请重新加载。';
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
  setLoadStatus(forceRefresh ? '\u6b63\u5728\u91cd\u65b0\u52a0\u8f7d\u4ef7\u683c\u6570\u636e\uff0c\u8bf7\u7a0d\u5019\u2026' : '\u6b63\u5728\u52a0\u8f7d\u4ef7\u683c\u6570\u636e\uff0c\u8bf7\u7a0d\u5019\u2026');
  setFiltersDisabled(true);
  elements.dataStatus.classList.remove('is-error');

  let fallbackData = state.data;
  if (!forceRefresh) {
    const cached = readPriceCache();
    if (cached) {
      fallbackData = cached.data;
      applyPriceData(cached.data, { origin: 'cache' });
      setLoadStatus(cached.freshness.status === 'degraded'
        ? '已显示过期本地缓存，正在检查网络更新…'
        : '已显示本地缓存，正在检查网络更新…');
    }
  }

  slowLoadingTimer = setTimeout(() => {
    const fallbackLabel = state.dataOrigin?.startsWith('cache') ? '本地缓存' : '当前数据';
    setLoadStatus(fallbackData ? `网络较慢，当前继续显示${fallbackLabel}…` : '\u7f51\u7edc\u8f83\u6162\uff0c\u4ecd\u5728\u52a0\u8f7d\u4ef7\u683c\u6570\u636e\u2026');
  }, SLOW_LOADING_MS);

  try {
    const networkData = await fetchJson('prices.json', { forceRefresh });
    if (!priceSnapshotsEqual(state.data, networkData)) {
      writePriceCache(networkData);
      applyPriceData(networkData, { origin: 'network' });
    } else {
      state.dataOrigin = 'network';
      applyCurrentPriceFreshness();
      normalizeCurrentPriceFreshnessUi();
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
      warning.textContent = state.dataOrigin?.startsWith('cache')
        ? '正在显示本地缓存 · 网络刷新失败'
        : '网络刷新失败 · 继续显示当前数据';
      elements.updatedAt.append(warning);
      setLoadStatus(state.dataOrigin?.startsWith('cache')
        ? '网络刷新失败，当前显示本地缓存'
        : '网络刷新失败，继续显示当前数据', { error: true });
      setFiltersDisabled(false);
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
  setLoadStatus('正在重新加载价格数据，请稍候…');
  initialize({ forceRefresh: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refreshPriceFreshnessLifecycle();
});
window.addEventListener('pageshow', () => {
  void refreshPriceFreshnessLifecycle();
});

removeLegacyPriceCaches();
initialize();
