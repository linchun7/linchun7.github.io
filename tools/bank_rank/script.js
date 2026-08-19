const DATA_URL = './data/rankings.json';

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

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

async function loadDataset() {
  const manifest = await fetchJson(DATA_URL);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.years)) {
    throw new Error('榜单清单结构无效');
  }
  const [banks, relations, ...yearRecords] = await Promise.all([
    fetchJson(`./data/${manifest.banksFile}`),
    fetchJson(`./data/${manifest.relationsFile}`),
    ...manifest.years.map(block => fetchJson(`./data/${block.recordsFile}`))
  ]);
  return {
    ...manifest,
    banks,
    relations,
    years: manifest.years.map((block, index) => ({ ...block, records: yearRecords[index] }))
  };
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return numberFormatter.format(Number(value));
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

function updateSortHeaders() {
  document.querySelectorAll('#bankTable thead th').forEach(th => {
    const button = th.querySelector('[data-sort]');
    if (!button) return;
    const active = button.dataset.sort === sortState.field;
    th.setAttribute('aria-sort', active ? (sortState.direction === 'asc' ? 'ascending' : 'descending') : 'none');
    const indicator = th.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = active ? (sortState.direction === 'asc' ? '↑' : '↓') : '↕';
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
  const tbody = document.getElementById('bankList');
  tbody.replaceChildren();
  if (!records.length) {
    const tr = document.createElement('tr');
    const td = createCell('没有符合条件的银行', 'empty-message');
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
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
        createWrappedCell(bank?.type || '—', 'type-badge'),
        createCell(formatNumber(record.coreTier1Capital)),
        createCell(formatNumber(record.assets)),
        createCell(formatNumber(record.netProfit)),
        createCell(change.text, `change ${change.className}`)
      );
      tbody.appendChild(tr);
    });
  }

  const block = getYearBlock(selectedYear);
  const type = document.getElementById('typeSelect').value;
  const query = document.getElementById('bankSearch').value.trim();
  const filters = [type, query ? `搜索“${query}”` : ''].filter(Boolean).join(' · ');
  document.getElementById('workspaceTitle').textContent = `${selectedYear} 年中国银行业100强`;
  document.getElementById('resultSummary').textContent = `${records.length} 家银行 · ${block.dataYear} 年末数据${filters ? ` · ${filters}` : ''}`;
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

  const oldest = Math.min(...dataset.years.map(block => Number(block.rankingYear)));
  const latest = Math.max(...dataset.years.map(block => Number(block.rankingYear)));
  document.getElementById('brandSubtitle').textContent = `核心一级资本排名 · ${oldest}–${latest}`;
  document.getElementById('dataStatus').textContent = `最新数据 ${latest} 年`;

  yearSelect.addEventListener('change', () => {
    selectedYear = Number(yearSelect.value);
    sortState = { field: 'rank', direction: 'asc' };
    render();
  });
  typeSelect.addEventListener('change', render);
  document.getElementById('bankSearch').addEventListener('input', render);
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

function openHistory(bankId, trigger) {
  const bank = getBank(bankId);
  const history = historyByBankId.get(bankId) || [];
  if (!bank || !history.length) return;
  lastDialogTrigger = trigger;
  const dialog = document.getElementById('historyDialog');
  const body = document.getElementById('historyDialogBody');
  document.getElementById('historyDialogTitle').textContent = `${bank.name} · 历年排名`;
  document.getElementById('historyDialogMeta').textContent = `${bank.type} · 当前数据覆盖 ${Math.min(...history.map(i => i.rankingYear))}–${Math.max(...history.map(i => i.rankingYear))}`;
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
    if (relation.sourceUrl) {
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
  const table = document.createElement('table');
  table.className = 'history-table';
  table.innerHTML = '<thead><tr><th>年份</th><th>排名</th><th>较上年</th><th>核心一级资本</th><th>资产规模</th><th>净利润</th></tr></thead>';
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
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus();
    lastDialogTrigger = null;
  });
}

async function start() {
  try {
    dataset = await loadDataset();
    buildIndexes();
    initControls();
    bindDialog();
    render();
  } catch (error) {
    console.error(error);
    document.getElementById('dataStatus').textContent = '数据加载失败';
    const tbody = document.getElementById('bankList');
    tbody.replaceChildren();
    const tr = document.createElement('tr');
    const td = createCell('数据加载失败，请稍后重试。', 'error-message');
    td.colSpan = 7;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

start();
