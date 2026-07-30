const REMOTE_DATA_ROOT = 'https://raw.githubusercontent.com/linchun7/linchun7.github.io/main/tools/icloud_price_comparison/data';
const HOSTED_NAMES = new Set(['linchun7.github.io', 'linchun.com.cn', 'www.linchun.com.cn']);
const REQUEST_TIMEOUT_MS = 8_000;
const TIER_IDS = ['50GB', '200GB', '2TB', '6TB', '12TB'];
const REGION_LABELS = {
  Americas: '美洲',
  'Europe, Middle East & Africa': '欧洲、中东和非洲',
  'Asia Pacific': '亚太'
};

const state = {
  data: null,
  history: null,
  sortTier: new URLSearchParams(location.search).get('tier') || '200GB',
  query: '',
  region: 'all',
  sortKey: 'tier',
  sortDirection: 'asc',
  activeCountry: null,
  historyTier: '200GB',
  chart: null
};

const elements = {
  historyTierControl: document.querySelector('#historyTierControl'),
  searchInput: document.querySelector('#searchInput'),
  regionSelect: document.querySelector('#regionSelect'),
  resultSummary: document.querySelector('#resultSummary'),
  fxStatus: document.querySelector('#fxStatus'),
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
  historyRows: document.querySelector('#historyRows')
};

const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
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

function validatePayload(fileName, payload) {
  if (fileName === 'history.json') {
    if (payload?.schemaVersion !== 1 || !payload.countries || typeof payload.countries !== 'object' || Array.isArray(payload.countries)) {
      throw new Error('价格历史数据结构无效');
    }
    for (const record of Object.values(payload.countries)) {
      if (!Array.isArray(record?.events) || !record.events.length) throw new Error('价格历史记录不完整');
      for (const event of record.events) {
        const validEvent = /^\d{4}-\d{2}-\d{2}$/.test(event?.observedAt)
          && typeof event.currency === 'string'
          && TIER_IDS.every((tierId) => Number.isFinite(event.plans?.[tierId]) && event.plans[tierId] > 0);
        if (!validEvent) throw new Error('价格历史事件无效');
      }
    }
    return payload;
  }

  if (payload?.schemaVersion !== 1
    || !Array.isArray(payload.tiers)
    || !Array.isArray(payload.countries)
    || Number.isNaN(Date.parse(payload.generatedAt))
    || !Number.isFinite(payload.fx?.rates?.CNY)
    || payload.fx.rates.CNY <= 0) {
    throw new Error('价格数据结构无效');
  }
  const tierIds = payload.tiers.map(({ id }) => id);
  if (tierIds.length !== TIER_IDS.length
    || tierIds.some((tierId, index) => tierId !== TIER_IDS[index])
    || !payload.countries.length) {
    throw new Error('价格容量或地区数据不完整');
  }
  for (const country of payload.countries) {
    if (!country.country || !country.currency || !country.plans) throw new Error('地区价格数据不完整');
    const currencyRate = payload.fx.rates[country.currency];
    if (!Number.isFinite(currencyRate) || currencyRate <= 0) throw new Error(`${country.currency} 汇率无效`);
    for (const tierId of tierIds) {
      const plan = country.plans[tierId];
      if (!plan || !Number.isFinite(plan.price) || plan.price <= 0 || !plan.formattedPrice) {
        throw new Error(`${country.country} 的 ${tierId} 价格无效`);
      }
    }
  }
  return payload;
}

async function fetchJson(fileName) {
  const cacheKey = Date.now();
  const localUrl = `./data/${fileName}?v=${cacheKey}`;
  const urls = HOSTED_NAMES.has(location.hostname)
    ? [localUrl, `${REMOTE_DATA_ROOT}/${fileName}?v=${cacheKey}`]
    : [localUrl];

  let lastError;
  for (const url of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
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

function formatConverted(value, symbol) {
  return value == null ? '暂无汇率' : `${symbol}${moneyFormatter.format(value)}`;
}

function createTierButtons(container, selectedTier, handler) {
  container.replaceChildren();
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
  const regions = [...new Set(state.data.countries.map(({ region }) => region))];

  for (const region of regions) {
    const option = document.createElement('option');
    option.value = region;
    option.textContent = REGION_LABELS[region] || region;
    elements.regionSelect.append(option);
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
    ? '按国家和地区名称排序'
    : `${tier.label} · 人民币价格${direction}`;

  if (!countries.length) {
    const row = document.createElement('tr');
    const cell = createCell('没有符合当前条件的结果', 'empty-cell');
    cell.colSpan = 7;
    row.append(cell);
    elements.priceRows.append(row);
    return;
  }

  countries.forEach((country, index) => {
    const row = document.createElement('tr');
    row.dataset.country = country.country;
    row.tabIndex = 0;
    row.setAttribute('aria-label', `查看 ${country.nameZh || country.country} 价格历史`);

    const rank = createCell(String(index + 1), index < 3 && state.sortKey === 'tier' && state.sortDirection === 'asc' ? 'rank-top' : '');
    const nameCell = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'country-name';
    name.textContent = country.nameZh || country.country;
    nameCell.append(name);
    if (country.nameZh && country.nameZh !== country.country) {
      const nameEn = document.createElement('span');
      nameEn.className = 'country-name-en';
      nameEn.textContent = `${country.country} · ${country.currency}`;
      nameCell.append(nameEn);
    }

    row.append(
      rank,
      nameCell,
      ...state.data.tiers.map(({ id }) => createPriceCell(country, id))
    );
    row.addEventListener('click', () => openHistory(country));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openHistory(country);
      }
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
    return event.currency !== previous.currency || event.plans[tier] !== previous.plans[tier];
  });
}

function renderChart(record) {
  state.chart?.destroy();
  state.chart = null;
  const series = compactHistorySeries(record.events, state.historyTier);
  const currencies = new Set(series.map(({ currency }) => currency));
  const canChart = series.length > 1 && currencies.size === 1 && window.Chart;
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
  state.chart = new window.Chart(context, {
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
        tooltip: { callbacks: { label: (item) => `${numberFormatter.format(item.raw)} ${currency}` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#687078' } },
        y: { beginAtZero: false, grid: { color: '#e7e9eb' }, ticks: { color: '#687078', callback: (value) => numberFormatter.format(value) } }
      }
    }
  });
}

function renderHistoryRows(record) {
  elements.historyRows.replaceChildren();
  [...record.events].reverse().forEach((event) => {
    const row = document.createElement('tr');
    row.append(createCell(formatDate(event.observedAt)), createCell(event.currency, 'currency-code'));
    for (const tier of state.data.tiers) row.append(createCell(numberFormatter.format(event.plans[tier.id])));
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
      observedAt: state.data.generatedAt.slice(0, 10),
      currency: country.currency,
      plans: Object.fromEntries(state.data.tiers.map(({ id }) => [id, country.plans[id].price]))
    }]
  };
}

function renderHistoryContent() {
  const country = state.activeCountry;
  const record = getHistoryRecord(country);
  const plan = country.plans[state.historyTier];
  const cny = convertPrice(plan.price, country.currency, 'CNY');
  const tier = state.data.tiers.find(({ id }) => id === state.historyTier);
  const changedSeries = compactHistorySeries(record.events, state.historyTier);

  elements.historyLocalPrice.textContent = `${plan.formattedPrice} / 月`;
  elements.historyCnyPrice.textContent = formatConverted(cny, '¥');
  elements.historyEventCount.textContent = changedSeries.length > 1 ? `${changedSeries.length - 1} 次变化` : '暂无变化';
  document.querySelector('#chartTitle').textContent = `${tier.label} 价格变化`;
  elements.chartCurrency.textContent = country.currency;
  renderChart(record);
  renderHistoryRows(record);
}

function openHistory(country) {
  const record = getHistoryRecord(country);
  state.activeCountry = country;
  state.historyTier = state.sortTier;
  elements.historyTitle.textContent = country.nameZh || country.country;
  elements.historySubtitle.textContent = `${country.country} · ${REGION_LABELS[country.region] || country.region} · 记录始于 ${formatDate(record.events[0].observedAt)}`;
  renderHistoryTierButtons();
  renderHistoryContent();
  elements.historyDialog.showModal();
  refreshIcons();
}

function bindEvents() {
  elements.searchInput.addEventListener('input', (event) => { state.query = event.target.value; renderTable(); });
  elements.regionSelect.addEventListener('change', (event) => { state.region = event.target.value; renderTable(); });
  document.querySelector('button[data-sort="country"]').addEventListener('click', setCountrySort);
  document.querySelectorAll('button[data-sort-tier]').forEach((button) => button.addEventListener('click', () => setTierSort(button.dataset.sortTier)));
  document.querySelector('#closeHistory').addEventListener('click', () => elements.historyDialog.close());
  elements.historyDialog.addEventListener('click', (event) => {
    if (event.target === elements.historyDialog) elements.historyDialog.close();
  });
  elements.historyDialog.addEventListener('close', () => {
    state.chart?.destroy();
    state.chart = null;
  });
}

function showLoadError(error) {
  console.error(error);
  elements.dataStatus.classList.add('is-error');
  elements.updatedAt.textContent = '数据加载失败，请稍后重试';
  elements.resultSummary.textContent = '暂时无法读取价格数据';
  elements.fxStatus.textContent = '';
  elements.priceRows.replaceChildren();
  const row = document.createElement('tr');
  const cell = createCell('请稍后刷新页面重试', 'empty-cell');
  cell.colSpan = 7;
  row.append(cell);
  elements.priceRows.append(row);
}

async function initialize() {
  try {
    state.history = { schemaVersion: 1, countries: {} };
    fetchJson('history.json')
      .then((historyData) => { state.history = historyData; })
      .catch((error) => { console.warn(`价格历史加载失败，使用当前价格作为临时记录：${error.message}`); });
    state.data = await fetchJson('prices.json');
    if (!state.data.tiers.some(({ id }) => id === state.sortTier)) state.sortTier = '200GB';
    state.historyTier = state.sortTier;
    populateFilters();
    bindEvents();
    elements.marketCount.textContent = state.data.countries.length;
    elements.currencyCount.textContent = new Set(state.data.countries.map(({ currency }) => currency)).size;
    elements.tierCount.textContent = state.data.tiers.length;
    elements.updatedAt.textContent = `更新 ${formatDate(state.data.generatedAt)}`;
    elements.fxStatus.textContent = formatDate(state.data.fx.fetchedAt);
    const priceAgeHours = (Date.now() - new Date(state.data.generatedAt).getTime()) / 3_600_000;
    if (state.data.fx.stale || priceAgeHours > 36) {
      elements.dataStatus.classList.add('is-stale');
      elements.updatedAt.textContent = priceAgeHours > 36
        ? `价格停留在 ${formatDate(state.data.generatedAt)}`
        : `价格 ${formatDate(state.data.generatedAt)} · 汇率缓存`;
    }
    renderSortHeaders();
    renderTable();
    refreshIcons();
  } catch (error) {
    showLoadError(error);
  }
}

initialize();
