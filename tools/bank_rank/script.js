const DATA_URL = './data/rankings.json';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SORT_ICON_PATHS = Object.freeze({
  'arrow-down': ['M12 5v14', 'm19 12-7 7-7-7'],
  'arrow-up': ['m5 12 7-7 7 7', 'M12 19V5'],
  'arrow-up-down': ['m21 16-4 4-4-4', 'M17 20V4', 'm3 8 4-4 4 4', 'M7 4v16']
});

let dataset = null;
let bankById = new Map();
let historyByBankId = new Map();
let searchValuesByBankId = new Map();
let selectedYear = 0;
let sortState = { field: 'rank', direction: 'asc' };
let lastDialogTrigger = null;

const numberFormatter = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

function requireData(condition, message) {
  if (!condition) throw new Error(`榜单数据无效：${message}`);
}

function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isText(value) { return typeof value === 'string' && value.trim().length > 0; }
function isHttpsSource(value) {
  if (typeof value !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateManifest(manifest) {
  requireData(isObject(manifest) && manifest.schemaVersion === 1, '清单版本');
  requireData(manifest.banksFile === 'banks.json' && manifest.relationsFile === 'relations.json', '实体文件路径');
  requireData(Array.isArray(manifest.years) && manifest.years.length > 0, '年度清单为空');
  const supported = ['大型商业银行', '全国性股份制商业银行', '城市商业银行', '农村商业银行', '民营银行', '外资法人银行'];
  requireData(Array.isArray(manifest.bankTypes) && manifest.bankTypes.length === supported.length
    && new Set(manifest.bankTypes).size === supported.length && manifest.bankTypes.every(type => supported.includes(type)), '银行类型');
  const years = new Set();
  let previousYear = 0;
  manifest.years.forEach(block => {
    requireData(isObject(block), '年度结构');
    const year = block.rankingYear;
    requireData(Number.isInteger(year) && year >= 1000 && year <= 9999 && year > previousYear, '年度重复或顺序错误');
    requireData(block.dataYear === year - 1, '榜单年度与财务年度');
    requireData(block.recordsFile === `years/${year}.json`, '年度文件路径');
    requireData(isHttpsSource(block.officialUrl) && isHttpsSource(block.transcriptionUrl), '年度来源链接');
    requireData(block.publishedAt === undefined || isIsoDate(block.publishedAt), '发布日期');
    years.add(year);
    previousYear = year;
  });
  const scope = manifest.scope;
  requireData(isObject(scope) && scope.minRankingYear === Math.min(...years)
    && scope.maxRankingYear === Math.max(...years), '年份范围');
  const pending = scope.historicalBackfillPending;
  requireData(Array.isArray(pending) && new Set(pending).size === pending.length
    && pending.every(year => Number.isInteger(year) && year >= scope.minRankingYear
      && year <= scope.maxRankingYear && !years.has(year)), '缺失年份声明');
  requireData(years.size + pending.length === scope.maxRankingYear - scope.minRankingYear + 1, '未声明的缺失年份');
}

function validateLoadedDataset(data) {
  requireData(Array.isArray(data.banks) && data.banks.length > 0, '银行实体为空');
  requireData(Array.isArray(data.relations), '机构沿革结构');
  const banks = new Map();
  const names = new Map();
  data.banks.forEach(bank => {
    requireData(isObject(bank) && typeof bank.id === 'string' && /^b_[a-z0-9]+$/.test(bank.id), '银行ID');
    requireData(!banks.has(bank.id) && isText(bank.name) && data.bankTypes.includes(bank.type), '银行实体重复或类型错误');
    requireData(bank.aliases === undefined || Array.isArray(bank.aliases), '银行别名');
    [bank.name, ...(bank.aliases || [])].forEach(name => {
      requireData(isText(name) && (!names.has(name) || names.get(name) === bank.id), '名称对应多个银行实体');
      names.set(name, bank.id);
    });
    banks.set(bank.id, bank);
  });
  data.years.forEach(block => {
    requireData(Array.isArray(block.records) && block.records.length === 100, `${block.rankingYear} 年不足或超过100条`);
    const seen = new Set();
    let previous = null;
    block.records.forEach((record, index) => {
      requireData(isObject(record) && banks.has(record.bankId) && !seen.has(record.bankId), '年度银行重复或未登记');
      requireData(isText(record.sourceName) && names.get(record.sourceName) === record.bankId, '原始名称与实体不符');
      requireData(Number.isInteger(record.rank) && record.rank >= 1 && record.rank <= 100, '排名');
      requireData(Number.isFinite(record.coreTier1Capital) && record.coreTier1Capital > 0
        && Number.isFinite(record.assets) && record.assets > 0 && Number.isFinite(record.netProfit), '财务数值');
      const expectedRank = previous && previous.coreTier1Capital === record.coreTier1Capital ? previous.rank : index + 1;
      requireData(record.rank === expectedRank && (!previous || record.coreTier1Capital <= previous.coreTier1Capital), '资本排序或并列排名');
      seen.add(record.bankId);
      previous = record;
    });
  });
  const seenRelations = new Set();
  data.relations.forEach(relation => {
    requireData(isObject(relation) && banks.has(relation.bankId), '沿革实体未登记');
    requireData(['renamed', 'formed_from'].includes(relation.type) && isIsoDate(relation.date), '沿革类型或日期');
    requireData(isHttpsSource(relation.sourceUrl), '沿革来源链接');
    requireData(isText(relation.fromName) && names.get(relation.toName) === relation.bankId
      && relation.fromName !== relation.toName, '沿革名称');
    requireData(relation.type !== 'renamed' || names.get(relation.fromName) === relation.bankId, '更名关联到不同实体');
    requireData(relation.note === undefined || typeof relation.note === 'string', '沿革说明');
    const key = JSON.stringify([relation.bankId, relation.type, relation.date, relation.fromName, relation.toName]);
    requireData(!seenRelations.has(key), '沿革事件重复');
    seenRelations.add(key);
  });
  return data;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { cache: 'no-cache', signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function loadDataset() {
  const manifest = await fetchJson(DATA_URL);
  validateManifest(manifest);
  const [banks, relations, ...yearRecords] = await Promise.all([
    fetchJson(`./data/${manifest.banksFile}`),
    fetchJson(`./data/${manifest.relationsFile}`),
    ...manifest.years.map(block => fetchJson(`./data/${block.recordsFile}`))
  ]);
  return validateLoadedDataset({
    ...manifest,
    banks,
    relations,
    years: manifest.years.map((block, index) => ({ ...block, records: yearRecords[index] }))
  });
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

function getBank(bankId) { return bankById.get(bankId); }
function getYearBlock(year) {
  return dataset.years.find(block => Number(block.rankingYear) === Number(year));
}

function buildIndexes() {
  bankById = new Map(dataset.banks.map(bank => [bank.id, bank]));
  historyByBankId = new Map();
  searchValuesByBankId = new Map();
  dataset.years.forEach(block => {
    block.records.forEach(record => {
      const item = { ...record, rankingYear: block.rankingYear, dataYear: block.dataYear };
      if (!historyByBankId.has(record.bankId)) historyByBankId.set(record.bankId, []);
      historyByBankId.get(record.bankId).push(item);
    });
  });
  historyByBankId.forEach((history, bankId) => {
    history.sort((a, b) => b.rankingYear - a.rankingYear);
    const bank = getBank(bankId);
    const values = new Set([
      bank?.name,
      ...(bank?.aliases || []),
      ...history.map(item => item.sourceName)
    ].filter(Boolean).map(value => String(value).toLowerCase()));
    searchValuesByBankId.set(bankId, [...values]);
  });
}

function previousRecord(bankId, year) {
  const targetYear = Number(year) - 1;
  return (historyByBankId.get(bankId) || []).find(record => Number(record.rankingYear) === targetYear) || null;
}

function rankChange(record) {
  const history = historyByBankId.get(record.bankId) || [];
  const previous = previousRecord(record.bankId, record.rankingYear);
  if (!previous) {
    if (record.rankingYear > dataset.scope.minRankingYear && !getYearBlock(record.rankingYear - 1)) {
      return { text: '上年未收录', className: 'new' };
    }
    const hasEarlierRecord = history.some(item => Number(item.rankingYear) < Number(record.rankingYear));
    return { text: hasEarlierRecord ? '上年未上榜' : '首次记录', className: 'new' };
  }
  const delta = Number(previous.rank) - Number(record.rank);
  if (delta > 0) return { text: `↑ ${delta} 位`, className: 'up' };
  if (delta < 0) return { text: `↓ ${Math.abs(delta)} 位`, className: 'down' };
  return { text: '— 持平', className: 'same' };
}

function matchesSearch(bankId, query) {
  const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!keywords.length) return true;
  const values = searchValuesByBankId.get(bankId) || [];
  return keywords.every(keyword => values.some(value => value.includes(keyword)));
}

function displayName(record) {
  return record.sourceName || getBank(record.bankId)?.name || '';
}

function sortRecords(records) {
  const multiplier = sortState.direction === 'asc' ? 1 : -1;
  const field = sortState.field;
  records.sort((a, b) => {
    if (field === 'name') {
      return (displayName(a).localeCompare(displayName(b), 'zh-CN') * multiplier) || a.rank - b.rank;
    }
    if (field === 'type') {
      return ((getBank(a.bankId)?.type || '').localeCompare(getBank(b.bankId)?.type || '', 'zh-CN') * multiplier) || a.rank - b.rank;
    }
    return ((Number(a[field]) - Number(b[field])) * multiplier) || a.rank - b.rank;
  });
}

function filteredRecords() {
  const block = getYearBlock(selectedYear);
  if (!block) return [];
  const type = document.getElementById('typeSelect').value;
  const query = document.getElementById('bankSearch').value;
  const records = block.records
    .filter(record => !type || getBank(record.bankId)?.type === type)
    .filter(record => matchesSearch(record.bankId, query))
    .map(record => ({ ...record, rankingYear: block.rankingYear, dataYear: block.dataYear }));
  sortRecords(records);
  return records;
}

function createSortIcon(iconName) {
  const paths = SORT_ICON_PATHS[iconName];
  if (!paths) throw new Error(`未知排序图标：${iconName}`);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `lucide lucide-${iconName}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.dataset.sortIcon = '';
  paths.forEach(pathData => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  });
  return svg;
}

function replaceSortIcon(button, iconName) {
  if (!button) return;
  const current = button.querySelector('[data-sort-icon]');
  if (current?.classList.contains(`lucide-${iconName}`)) return;
  const replacement = createSortIcon(iconName);
  if (current) current.replaceWith(replacement);
  else button.appendChild(replacement);
}

function updateSortHeaders() {
  document.querySelectorAll('#bankTable thead th').forEach(th => {
    const button = th.querySelector('[data-sort]');
    if (!button) return;
    const active = button.dataset.sort === sortState.field;
    th.setAttribute('aria-sort', active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    replaceSortIcon(button, active ? (sortState.direction === 'asc' ? 'arrow-up' : 'arrow-down') : 'arrow-up-down');
  });
}

function createCell(text, className = '') {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  return td;
}

function createWrappedCell(text, className) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  td.appendChild(span);
  return td;
}

function createBankCell(record) {
  const bank = getBank(record.bankId);
  const td = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'bank-history-button';
  button.dataset.bankId = record.bankId;
  button.setAttribute('aria-haspopup', 'dialog');
  const shownName = displayName(record);
  button.title = bank?.name && bank.name !== shownName
    ? `现名：${bank.name}；查看历年排名与更名信息`
    : (bank?.aliases?.length ? `查看历年排名与历史名称：${bank.aliases.join('、')}` : '查看历年排名');
  const name = document.createElement('span');
  name.className = 'bank-name';
  name.textContent = shownName;
  const affordance = document.createElement('span');
  affordance.className = 'history-affordance';
  affordance.setAttribute('aria-hidden', 'true');
  affordance.textContent = '›';
  button.append(name, affordance);
  td.appendChild(button);
  return td;
}

function render() {
  const records = filteredRecords();
  const rows = document.createDocumentFragment();
  if (!records.length) {
    const tr = document.createElement('tr');
    const td = createCell('没有符合条件的银行', 'empty-message');
    td.colSpan = 7;
    tr.appendChild(td);
    rows.appendChild(tr);
  } else {
    records.forEach(record => {
      const bank = getBank(record.bankId);
      const change = rankChange(record);
      const tr = document.createElement('tr');
      tr.className = 'data-row';
      tr.dataset.bankId = record.bankId;
      tr.append(
        createWrappedCell(String(record.rank), 'rank-value'),
        createBankCell(record),
        createWrappedCell(bank.type, 'type-badge'),
        createCell(formatNumber(record.coreTier1Capital)),
        createCell(formatNumber(record.assets)),
        createCell(formatNumber(record.netProfit)),
        createCell(change.text, `change ${change.className}`)
      );
      rows.appendChild(tr);
    });
  }

  const block = getYearBlock(selectedYear);
  const type = document.getElementById('typeSelect').value;
  const query = document.getElementById('bankSearch').value.trim();
  const filters = [type ? `类型：${type}` : '', query ? `搜索：${query}` : ''].filter(Boolean).join(' · ');
  // Build the entire table off-DOM before replacing the last complete view.
  document.getElementById('bankList').replaceChildren(rows);
  document.getElementById('workspaceTitle').textContent = `${selectedYear} 年中国银行业100强榜单`;
  document.getElementById('resultSummary').textContent = `${records.length} 家银行 · 榜单基于 ${block.dataYear} 年末财务数据${filters ? ` · ${filters}` : ''}`;
  updateSortHeaders();
}

function initControls() {
  const yearSelect = document.getElementById('yearSelect');
  yearSelect.replaceChildren();
  [...dataset.years].sort((a, b) => b.rankingYear - a.rankingYear).forEach(block => {
    yearSelect.add(new Option(`${block.rankingYear}年`, String(block.rankingYear)));
  });
  selectedYear = Math.max(...dataset.years.map(block => Number(block.rankingYear)));
  yearSelect.value = String(selectedYear);

  const typeSelect = document.getElementById('typeSelect');
  typeSelect.replaceChildren(new Option('全部类型', ''));
  dataset.bankTypes.forEach(type => typeSelect.add(new Option(type, type)));

  const latest = Math.max(...dataset.years.map(block => Number(block.rankingYear)));
  document.getElementById('dataStatus').textContent = `最新榜单 ${latest} 年`;

  const bankSearch = document.getElementById('bankSearch');

  yearSelect.addEventListener('change', () => {
    selectedYear = Number(yearSelect.value);
    sortState = { field: 'rank', direction: 'asc' };
    render();
  });
  typeSelect.addEventListener('change', render);
  bankSearch.addEventListener('input', render);
  document.querySelectorAll('#bankTable [data-sort]').forEach(button => {
    button.addEventListener('click', () => {
      const field = button.dataset.sort;
      if (sortState.field === field) sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
      else {
        sortState.field = field;
        sortState.direction = ['rank', 'name', 'type'].includes(field) ? 'asc' : 'desc';
      }
      render();
    });
  });
}

function relationText(relation) {
  if (relation.type === 'renamed') return `${relation.date}：${relation.fromName}更名为${relation.toName}。${relation.note || ''}`;
  if (relation.type === 'formed_from') return `${relation.date}：${relation.toName}由${relation.fromName}以新设合并方式组建。${relation.note || ''}`;
  return relation.note || '';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatYearRanges(history) {
  const years = [...new Set(history.map(item => Number(item.rankingYear)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!years.length) return '—';
  const ranges = [];
  let start = years[0];
  let previous = years[0];
  for (const year of years.slice(1)) {
    if (year === previous + 1) {
      previous = year;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}–${previous}`);
    start = previous = year;
  }
  ranges.push(start === previous ? String(start) : `${start}–${previous}`);
  return ranges.join('、');
}

function openHistory(bankId, trigger) {
  const bank = getBank(bankId);
  const history = historyByBankId.get(bankId) || [];
  if (!bank || !history.length) return;
  lastDialogTrigger = trigger;
  const dialog = document.getElementById('historyDialog');
  const body = document.getElementById('historyDialogBody');
  document.getElementById('historyDialogTitle').textContent = `${bank.name} · 历年排名`;
  document.getElementById('historyDialogMeta').textContent = `${bank.type} · 上榜记录：${formatYearRanges(history)}`;
  body.replaceChildren();

  if (bank.aliases?.length) {
    const aliases = document.createElement('p');
    aliases.className = 'history-aliases';
    aliases.innerHTML = `<strong>历史名称 / 榜单名称：</strong>${bank.aliases.map(value => escapeHtml(value)).join('、')}`;
    body.appendChild(aliases);
  }
  (dataset.relations || []).filter(item => item.bankId === bankId).forEach(relation => {
    const p = document.createElement('p');
    p.className = 'history-event';
    p.append(document.createTextNode(relationText(relation)));
    if (isHttpsSource(relation.sourceUrl)) {
      p.append(' ');
      const link = document.createElement('a');
      link.href = relation.sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = '查看来源';
      p.appendChild(link);
    }
    body.appendChild(p);
  });

  const scroll = document.createElement('div');
  scroll.style.overflowX = 'auto';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '历年排名表，可左右滚动');
  const table = document.createElement('table');
  table.className = 'history-table';
  table.innerHTML = '<caption>年份为榜单年，财务数据对应上一年末；单位：亿元</caption><thead><tr><th scope="col">年份</th><th scope="col">排名</th><th scope="col">较上年</th><th scope="col">核心一级资本</th><th scope="col">资产规模</th><th scope="col">净利润</th></tr></thead>';
  const tbody = document.createElement('tbody');
  history.forEach(record => {
    const tr = document.createElement('tr');
    const change = rankChange(record);
    [String(record.rankingYear), String(record.rank), change.text, formatNumber(record.coreTier1Capital), formatNumber(record.assets), formatNumber(record.netProfit)]
      .forEach(text => tr.appendChild(createCell(text)));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  scroll.appendChild(table);
  body.appendChild(scroll);
  const sourceNames = [...new Set(history.map(item => item.sourceName).filter(Boolean))];
  if (sourceNames.some(name => name !== bank.name)) {
    const p = document.createElement('p');
    p.className = 'history-source-name';
    p.textContent = `历年榜单原始名称：${sourceNames.join('、')}`;
    body.appendChild(p);
  }
  dialog.showModal();
}

function bindDialog() {
  document.getElementById('bankList').addEventListener('click', event => {
    const button = event.target.closest('.bank-history-button');
    if (button) openHistory(button.dataset.bankId, button);
  });
  const dialog = document.getElementById('historyDialog');
  document.getElementById('dialogClose').addEventListener('click', () => dialog.close());
  // Keep plain Tab navigation within the modal across browser engines.
  // Escape and browser-level keyboard shortcuts retain their native behavior.
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const targets = [...dialog.querySelectorAll('button, a[href], [tabindex]')]
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const first = targets[0];
    const last = targets.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  let backdropPress = false;
  const isBackdrop = event => {
    const box = dialog.getBoundingClientRect();
    return event.target === dialog && (event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom);
  };
  dialog.addEventListener('pointerdown', event => { backdropPress = event.button === 0 && isBackdrop(event); });
  dialog.addEventListener('pointercancel', () => { backdropPress = false; });
  dialog.addEventListener('click', event => {
    if (backdropPress && isBackdrop(event)) dialog.close();
    backdropPress = false;
  });
  dialog.addEventListener('close', () => {
    if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus();
    lastDialogTrigger = null;
  });
}

async function start() {
  const tbody = document.getElementById('bankList');
  const yearSelect = document.getElementById('yearSelect');
  const initialRows = [...tbody.childNodes].map(node => node.cloneNode(true));
  const initialYearOptions = [...yearSelect.options].map(option => option.cloneNode(true));
  const initialYear = yearSelect.value;
  const initialTitle = document.getElementById('workspaceTitle').textContent;
  try {
    dataset = await loadDataset();
    buildIndexes();
    initControls();
    bindDialog();
    render();
    document.querySelectorAll('#yearSelect, #typeSelect, #bankSearch, #bankTable [data-sort]').forEach(control => {
      control.disabled = false;
    });
  } catch (error) {
    console.error(error);
    dataset = null;
    // Restore a coherent static view even if initialization failed after rendering.
    tbody.replaceChildren(...initialRows);
    yearSelect.replaceChildren(...initialYearOptions);
    yearSelect.value = initialYear;
    document.getElementById('typeSelect').replaceChildren(new Option('全部类型', ''));
    document.getElementById('bankSearch').value = '';
    document.getElementById('workspaceTitle').textContent = initialTitle;
    const staticRows = tbody.querySelectorAll('tr.data-row[data-static-prerendered="true"]');
    document.getElementById('dataStatus').textContent = '数据加载失败 · 静态预览';
    document.getElementById('resultSummary').textContent = staticRows.length
      ? `${staticRows.length} 家静态预览 · 动态数据加载失败`
      : '动态数据加载失败';
    document.querySelectorAll('#yearSelect, #typeSelect, #bankSearch, #bankTable [data-sort], .bank-history-button').forEach(control => {
      control.disabled = true;
    });
    if (!staticRows.length) {
      const tr = document.createElement('tr');
      const td = createCell('数据加载失败，请稍后重试。', 'error-message');
      td.colSpan = 7;
      tr.appendChild(td);
      tbody.replaceChildren(tr);
    }
  }
}

start();