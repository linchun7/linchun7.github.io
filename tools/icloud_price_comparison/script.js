import { publicationDateKey, validatePayload, validatePriceHistoryConsistency } from './data-contract.js';
import { createIcons } from './vendor/lucide-subset.js';

const REMOTE_DATA_ROOT = 'https://raw.githubusercontent.com/linchun7/linchun7.github.io/main/tools/icloud_price_comparison/data';
const HOSTED_NAMES = new Set(['linchun7.github.io', 'linchun.com.cn', 'www.linchun.com.cn']);
const REQUEST_TIMEOUT_MS = 8_000;
const CHART_SCRIPT_URL = './vendor/chart.umd.min.js';
const SLOW_LOADING_MS = 1_500;
const DEFAULT_SORT_TIER = '200GB';
const DEFAULT_TIER_COLUMN_COUNT = 5;
const FIXED_PRICE_TABLE_COLUMN_COUNT = 2;
const REGION_LABELS = {
  Americas: '美洲',
  'Europe, Middle East & Africa': '欧洲、中东和非洲',
  'Asia Pacific': '亚太'
};

const state = {
  data: null,
  history: null,
  sortTier: new URLSearchParams(location.search).get('tier') || DEFAULT_SORT_TIER,
  query: '',
  region: 'all',
  sortKey: 'tier',
  sortDirection: 'asc',
  activeCountry: null,
  historyTier: DEFAULT_SORT_TIER,
  minimumPrices: {},
  minimumCountries: {},
  chart: null,
  eventsBound: false,
  loading: false,
  historyStatus: 'idle',
  historyRequestId: 0,
  historyPromise: null,
  chartRequestId: 0,
  historyReturnFocus: null,
  publishedDateReturnFocus: null
};

const elements = {
  historyTierControl: document.querySelector('#historyTierControl'),
  searchInput: document.querySelector('#searchInput'),
  regionSelect: document.querySelector('#regionSelect'),
  resultSummary: document.querySelector('#resultSummary'),
  loadStatus: document.querySelector('#loadStatus'),
  loadStatusText: document.querySelector('#loadStatusText'),
  retryButton: document.querySelector('#retryButton'),
  workspace: document.querySelector('.workspace'),
  minimumSummary: document.querySelector('#minimumSummary'),
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
let chartLibraryPromise = null;

function refreshIcons() {
  try {
    createIcons({ attrs: { 'stroke-width': 1.8 } });
  } catch (error) {
    console.warn(`图标加载失败：${error.message}`);
  }
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
  document.querySelectorAll('button[data-sort], #publishedDateButton').forEach((button) => {
    button.disabled = disabled;
  });
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

async function fetchJson(fileName) {
  const localUrl = `./data/${fileName}`;
  const urls = HOSTED_NAMES.has(location.hostname)
    ? [localUrl, `${REMOTE_DATA_ROOT}/${fileName}`]
    : [localUrl];

  let lastError;
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: controller.signal });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return validatePayload(fileName, await response.json());
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

function convertPrice(price, currency, targetCurrency) {
  const rates = state.data.fx.rates;
  const sourceRate = rates[currency];
  const targetRate = rates[targetCurrency];
  if (!sourceRate || !targetRate) return null;
  return (price / sourceRate) * targetRate;
}

function calculateMinimumPrices() {
  state.minimumPrices = {};
  state.minimumCountries = {};
  for (const { id } of state.data.tiers) {
    const candidates = state.data.countries
      .map((country) => ({
        country,
        value: convertPrice(country.plans[id].price, country.currency, 'CNY')
      }))
      .filter(({ value }) => value != null)
      .sort((first, second) => first.value - second.value
        || collator.compare(first.country.nameZh || first.country.country, second.country.nameZh || second.country.country));
    const winner = candidates[0];
    state.minimumPrices[id] = winner?.value ?? null;
    state.minimumCountries[id] = winner?.country ?? null;
  }
}

function renderMinimumSummary() {
  if (!elements.minimumSummary) return;
  elements.minimumSummary.replaceChildren();
  for (const tier of state.data.tiers) {
    const item = document.createElement('div');
    item.title = `${tier.label}人民币参考价最低地区`;

    const tierLabel = document.createElement('dt');
    tierLabel.className = 'minimum-tier-label';
    tierLabel.textContent = tier.label;
    const countryName = state.minimumCountries[tier.id]?.nameZh
      || state.minimumCountries[tier.id]?.country;
    const country = document.createElement('span');
    country.className = 'minimum-country';
    country.textContent = countryName || '暂无地区';
    const price = document.createElement('dd');
    price.className = 'minimum-price';
    price.textContent = formatConverted(state.minimumPrices[tier.id], '¥');
    item.append(tierLabel, country, price);
    elements.minimumSummary.append(item);
  }
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
}

function renderTierHeaders() {
  const row = document.querySelector('.price-table thead tr');
  if (!row) return;
  document.querySelector('#tierHeaderPlaceholder')?.remove();
  row.querySelectorAll('th[data-tier-header]').forEach((header) => header.remove());
  for (const tier of state.data.tiers) {
    const header = document.createElement('th');
    header.dataset.tierHeader = 'true';
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
  refreshIcons();
}

function renderHistoryHeaders() {
  const row = elements.historyRows.closest('table')?.querySelector('thead tr');
  if (!row) return;
  document.querySelector('#historyTierHeaderPlaceholder')?.remove();
  row.querySelectorAll('th[data-history-tier-header]').forEach((header) => header.remove());
  for (const tier of state.data.tiers) {
    const header = document.createElement('th');
    header.dataset.historyTierHeader = 'true';
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
  const localPrice = country.plans[state.sortTier].price;
  return convertPrice(localPrice, country.currency, 'CNY') ?? Number.POSITIVE_INFINITY;
}

function sortedCountries() {
  return filteredCountries().sort((a, b) => {
    const first = sortValue(a);
    const second = sortValue(b);
    const comparison = typeof first === 'string' ? collator.compare(first, second) : first - second;
    return state.sortDirection === 'asc' ? comparison : -comparison;
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
  const cny = convertPrice(plan.price, country.currency, 'CNY');
  const cell = document.createElement('td');
  cell.className = 'price-cell';
  cell.dataset.tier = tierId;
  if (state.sortKey === 'tier' && state.sortTier === tierId) cell.classList.add('is-sorted');
  const isMinimum = cny != null
    && state.minimumPrices[tierId] != null
    && Math.abs(cny - state.minimumPrices[tierId]) < 0.000001;
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
    amount.textContent = moneyFormatter.format(cny);
    if (isMinimum) {
      const badge = document.createElement('span');
      badge.className = 'minimum-badge';
      badge.textContent = '最低';
      badge.title = '该容量人民币换算价最低';
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
  if (state.sortKey !== 'tier') return;
  requestAnimationFrame(() => {
    const scroller = document.querySelector('.table-scroll');
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    const activeHeader = document.querySelector(`button[data-sort-tier="${state.sortTier}"]`)?.closest('th');
    const countryHeader = document.querySelector('.price-table th:nth-child(2)');
    if (activeHeader && countryHeader) {
      scroller.scrollLeft = Math.max(0, activeHeader.offsetLeft - countryHeader.offsetWidth);
    }
  });
}

function renderTable() {
  const countries = sortedCountries();
  elements.priceRows.replaceChildren();
  const tier = state.data.tiers.find(({ id }) => id === state.sortTier);
  const direction = state.sortDirection === 'asc' ? '从低到高' : '从高到低';
  elements.resultSummary.textContent = state.sortKey === 'country'
    ? `按国家和地区名称排序：${state.sortDirection === 'asc' ? '正序' : '倒序'}`
    : `按 ${tier.label} 人民币参考价排序：${direction}`;

  if (!countries.length) {
    const row = document.createElement('tr');
    const cell = createCell('没有符合当前条件的结果', 'empty-cell');
    cell.colSpan = state.data.tiers.length + 2;
    row.append(cell);
    elements.priceRows.append(row);
    return;
  }

  countries.forEach((country, index) => {
    const row = document.createElement('tr');
    row.dataset.country = country.country;

    const rank = createCell(String(index + 1), index < 3 && state.sortKey === 'tier' && state.sortDirection === 'asc' ? 'rank-top' : '');
    const nameCell = document.createElement('td');
    const historyButton = document.createElement('button');
    historyButton.type = 'button';
    historyButton.className = 'country-history-button';
    historyButton.setAttribute('aria-label', `查看 ${country.nameZh || country.country} 价格历史`);
    const name = document.createElement('span');
    name.className = 'country-name';
    name.textContent = country.nameZh || country.country;
    historyButton.append(name);
    if (country.nameZh && country.nameZh !== country.country) {
      const nameEn = document.createElement('span');
      nameEn.className = 'country-name-en';
      nameEn.textContent = `${country.country} · ${country.currency}`;
      historyButton.append(nameEn);
    }
    nameCell.append(historyButton);

    row.append(
      rank,
      nameCell,
      ...state.data.tiers.map(({ id }) => createPriceCell(country, id))
    );
    historyButton.addEventListener('click', (event) => {
      event.stopPropagation();
      openHistory(country, historyButton);
    });
    row.addEventListener('click', (event) => {
      if (event.target.closest('button, a, input, select')) return;
      openHistory(country, historyButton);
    });
    elements.priceRows.append(row);
  });
  alignActiveTierColumn();
}

function renderSortHeaders() {
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
  refreshIcons();
}

function setCountrySort() {
  if (state.sortKey === 'country') state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  else {
    state.sortKey = 'country';
    state.sortDirection = 'asc';
  }
  renderSortHeaders();
  renderTable();
}

function setTierSort(tier) {
  if (state.sortKey === 'tier' && state.sortTier === tier) {
    state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = 'tier';
    state.sortTier = tier;
    state.sortDirection = 'asc';
  }
  const url = new URL(location.href);
  url.searchParams.set('tier', tier);
  history.replaceState(null, '', url);
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
  return events.filter((event, index) => {
    if (index === 0) return true;
    const previous = events[index - 1];
    const price = Number.isFinite(event.plans[tier]) ? event.plans[tier] : null;
    const previousPrice = Number.isFinite(previous.plans[tier]) ? previous.plans[tier] : null;
    return event.currency !== previous.currency || price !== previousPrice;
  });
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
    trend.classList.add(isIncrease ? 'is-up' : 'is-down');
    trend.textContent = `（${isIncrease ? '↑' : '↓'} ${percentFormatter.format(Math.abs(changePercent))}%）`;
    trend.title = `与上一次当地月费相比${isIncrease ? '上涨' : '下降'} ${percentFormatter.format(Math.abs(changePercent))}%`;
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
        animation: { duration: 250 },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (item) => item.raw == null ? '????' : `${numberFormatter.format(item.raw)} ${currency}` } }
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
      row.append(createCell(Number.isFinite(price) ? numberFormatter.format(price) : '--'));
    }
    elements.historyRows.append(row);
  });
}

function getHistoryRecord(country) {
  const record = state.history?.countries?.[country.country];
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
    .then((historyData) => {
      if (requestId !== state.historyRequestId) return null;
      validatePriceHistoryConsistency(state.data, historyData);
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
  elements.applePublishedDate.textContent = formatPublishedDate(latest);
  elements.publishedDateDialogCurrent.textContent = formatPublishedDate(latest);
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
  const cny = convertPrice(plan.price, country.currency, 'CNY');
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
  state.historyTier = state.sortTier;
  elements.historyTitle.textContent = country.nameZh || country.country;
  renderHistorySubtitle(country, record);
  renderHistoryTierButtons();
  renderHistoryContent();
  elements.historyDialog.showModal();
  refreshIcons();
}

function syncActiveHistoryCountry() {
  const activeCountryId = state.activeCountry?.country;
  if (!activeCountryId) return;
  const currentCountry = state.data.countries.find(({ country }) => country === activeCountryId);
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

function bindEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;
  elements.searchInput.addEventListener('input', (event) => { state.query = event.target.value; renderTable(); });
  elements.regionSelect.addEventListener('change', (event) => { state.region = event.target.value; renderTable(); });
  document.querySelector('button[data-sort="country"]').addEventListener('click', setCountrySort);
  document.querySelectorAll('button[data-sort-tier]').forEach((button) => button.addEventListener('click', () => setTierSort(button.dataset.sortTier)));
  document.querySelector('#closeHistory').addEventListener('click', () => elements.historyDialog.close());
  elements.historyDialog.addEventListener('click', (event) => {
    if (event.target === elements.historyDialog) elements.historyDialog.close();
  });
  elements.publishedDateButton.addEventListener('click', openPublishedDateHistory);
  elements.closePublishedDate.addEventListener('click', () => elements.publishedDateDialog.close());
  elements.publishedDateDialog.addEventListener('click', (event) => {
    if (event.target === elements.publishedDateDialog) elements.publishedDateDialog.close();
  });
  elements.historyDialog.addEventListener('close', () => {
    destroyChart();
    const returnFocus = state.historyReturnFocus;
    state.historyReturnFocus = null;
    if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
  });
  elements.publishedDateDialog.addEventListener('close', () => {
    const returnFocus = state.publishedDateReturnFocus;
    state.publishedDateReturnFocus = null;
    if (returnFocus?.isConnected) requestAnimationFrame(() => returnFocus.focus());
  });
}

function showLoadError(error) {
  console.error(error);
  elements.dataStatus.classList.add('is-error');
  elements.updatedAt.textContent = '数据加载失败，请稍后重试';
  elements.resultSummary.textContent = '暂时无法读取价格数据';
  setLoadStatus('价格数据加载失败，请检查网络后重试', { error: true });
  setFiltersDisabled(true);
  elements.fxStatus.textContent = '';
  elements.priceRows.replaceChildren();
  const row = document.createElement('tr');
  const cell = createCell('请稍后刷新页面重试', 'empty-cell');
  cell.colSpan = (state.data?.tiers?.length || DEFAULT_TIER_COLUMN_COUNT) + FIXED_PRICE_TABLE_COLUMN_COUNT;
  row.append(cell);
  elements.priceRows.append(row);
}

async function initialize() {
  if (state.loading) return;
  state.loading = true;
  state.historyRequestId += 1;
  state.history = null;
  state.historyStatus = 'idle';
  state.historyPromise = null;
  clearTimeout(slowLoadingTimer);
  setLoadStatus('正在加载价格数据，请稍候…');
  setFiltersDisabled(true);
  slowLoadingTimer = setTimeout(() => {
    setLoadStatus('网络较慢，仍在加载价格数据…');
  }, SLOW_LOADING_MS);
  elements.dataStatus.classList.remove('is-error', 'is-stale');
  try {
    state.data = await fetchJson('prices.json');
    if (!state.data.tiers.some(({ id }) => id === state.sortTier)) {
      state.sortTier = state.data.tiers.find(({ id }) => id === DEFAULT_SORT_TIER)?.id || state.data.tiers[0].id;
    }
    state.historyTier = state.sortTier;
    syncActiveHistoryCountry();
    if (elements.historyDialog.open || elements.publishedDateDialog.open) void ensureHistoryLoaded();
    calculateMinimumPrices();
    populateFilters();
    bindEvents();
    setFiltersDisabled(false);
    elements.marketCount.textContent = state.data.countries.length;
    elements.currencyCount.textContent = new Set(state.data.countries.map(({ currency }) => currency)).size;
    elements.tierCount.textContent = state.data.tiers.length;
    renderTierHeaders();
    renderPublishedDateHistory();
    const dataUpdatedAt = formatBeijingDateTime(state.data.generatedAt);
    const fxUpdatedAt = formatBeijingDateTime(state.data.fx.fetchedAt);
    elements.updatedAt.textContent = `数据更新时间：${dataUpdatedAt}（北京时间）`;
    elements.fxStatus.textContent = `更新时间：${fxUpdatedAt}（北京时间）`;
    const priceAgeHours = (Date.now() - new Date(state.data.generatedAt).getTime()) / 3_600_000;
    const freshnessWarnings = [];
    if (priceAgeHours < 0) freshnessWarnings.push('数据生成时间在未来');
    if (priceAgeHours > 36) freshnessWarnings.push('超过 36 小时');
    if (state.data.fx.stale) freshnessWarnings.push('汇率沿用上次成功结果');
    if (freshnessWarnings.length) {
      elements.dataStatus.classList.add('is-stale');
      const warning = document.createElement('span');
      warning.className = 'freshness-warning';
      warning.textContent = freshnessWarnings.join(' · ');
      elements.updatedAt.append(warning);
    }
    renderSortHeaders();
    renderMinimumSummary();
    renderTable();
    setLoadStatus('', { hidden: true });
    refreshIcons();
  } catch (error) {
    showLoadError(error);
  } finally {
    clearTimeout(slowLoadingTimer);
    slowLoadingTimer = null;
    state.loading = false;
  }
}

elements.retryButton?.addEventListener('click', () => {
  elements.retryButton.hidden = true;
  setLoadStatus('正在重新加载价格数据，请稍候…');
  initialize();
});

initialize();
