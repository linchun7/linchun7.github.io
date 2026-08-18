const GRADE_ORDER = Object.freeze({
    'A++++': 1,
    'A+++': 2,
    'A++': 3,
    'A+': 4,
    'A': 5
});

const SORT_FIELD_MAP = Object.freeze({
    '专科声誉': 'specialtyReputation',
    '科研学术': 'researchAcademic',
    '综合得分': 'overallScore'
});

let rankingDataset = null;
let hospitalById = new Map();
let hospitalRecords = [];
let hospitalHistoryMap = new Map();
let hospitalSearchMap = new Map();
let expandedRowKey = null;

const sortConfig = {
    column: null,
    direction: 'asc'
};

function isEmptyValue(value) {
    return value === '' || value === null || value === undefined;
}

function isNumericRank(record) {
    return !isEmptyValue(record.rank) && Number.isFinite(Number(record.rank));
}

function isGradeRank(record) {
    return Object.prototype.hasOwnProperty.call(GRADE_ORDER, record.grade);
}

function formatRank(record) {
    if (isNumericRank(record)) return `第${Number(record.rank)}名`;
    if (isGradeRank(record)) return record.grade;
    return '-';
}

function formatNumber(value) {
    if (isEmptyValue(value)) return '-';
    if (typeof value === 'number') return value.toFixed(3).replace(/\.?0+$/, '');
    return String(value);
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

function getHospital(recordOrId) {
    const id = typeof recordOrId === 'string' ? recordOrId : recordOrId.hospitalId;
    return hospitalById.get(id);
}

async function loadRankingData() {
    const response = await fetch('./data/rankings.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`数据加载失败：HTTP ${response.status}`);

    const data = await response.json();
    if (data?.schemaVersion !== 1 || !Array.isArray(data.hospitals) || !Array.isArray(data.years)) {
        throw new Error('榜单 JSON 结构无效');
    }

    rankingDataset = data;
    hospitalById = new Map(data.hospitals.map(hospital => [hospital.id, hospital]));
    if (hospitalById.size !== data.hospitals.length) throw new Error('医院实体 ID 存在重复');

    hospitalRecords = data.years.flatMap(yearBlock => {
        if (!Array.isArray(yearBlock.records)) throw new Error(`${yearBlock.year} 年记录无效`);
        return yearBlock.records.map((record, sourceOrder) => {
            if (!hospitalById.has(record.hospitalId)) {
                throw new Error(`${yearBlock.year} 年存在未知医院实体：${record.hospitalId}`);
            }
            return {
                year: Number(yearBlock.year),
                rankingMode: yearBlock.rankingMode,
                hospitalId: record.hospitalId,
                sourceName: record.sourceName || hospitalById.get(record.hospitalId).name,
                rank: record.rank,
                grade: record.grade,
                specialtyReputation: record.specialtyReputation,
                researchAcademic: record.researchAcademic,
                overallScore: record.overallScore,
                sourceOrder
            };
        });
    });
}

function buildIndexes() {
    hospitalHistoryMap = new Map();
    hospitalSearchMap = new Map();

    hospitalRecords.forEach(record => {
        if (!hospitalHistoryMap.has(record.hospitalId)) hospitalHistoryMap.set(record.hospitalId, []);
        hospitalHistoryMap.get(record.hospitalId).push(record);
    });

    hospitalHistoryMap.forEach((history, hospitalId) => {
        history.sort((a, b) => b.year - a.year);
        const hospital = getHospital(hospitalId);
        const values = new Set([
            hospital?.name,
            ...(hospital?.aliases || []),
            ...history.map(record => record.sourceName)
        ].filter(Boolean).map(value => String(value).toLowerCase()));
        hospitalSearchMap.set(hospitalId, [...values]);
    });
}

function getNearestPreviousNumericRank(hospitalId, beforeYear) {
    const history = hospitalHistoryMap.get(hospitalId) || [];
    const record = history.find(item => item.year < Number(beforeYear) && isNumericRank(item));
    return record ? Number(record.rank) : null;
}

function compareNullableNumeric(a, b, isAsc) {
    const aEmpty = isEmptyValue(a);
    const bEmpty = isEmptyValue(b);
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const diff = Number(a) - Number(b);
    return isAsc ? diff : -diff;
}

function compareRankWithinYear(a, b, isAsc = true) {
    if (isNumericRank(a) && isNumericRank(b)) {
        const diff = Number(a.rank) - Number(b.rank);
        return isAsc ? diff : -diff;
    }

    if (isGradeRank(a) && isGradeRank(b)) {
        const gradeDiff = GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade];
        if (gradeDiff !== 0) return isAsc ? gradeDiff : -gradeDiff;

        const aHistoryRank = getNearestPreviousNumericRank(a.hospitalId, a.year);
        const bHistoryRank = getNearestPreviousNumericRank(b.hospitalId, b.year);
        if (aHistoryRank !== null && bHistoryRank !== null && aHistoryRank !== bHistoryRank) {
            const diff = aHistoryRank - bHistoryRank;
            return isAsc ? diff : -diff;
        }
        if (aHistoryRank !== null && bHistoryRank === null) return -1;
        if (aHistoryRank === null && bHistoryRank !== null) return 1;
        return a.sourceOrder - b.sourceOrder;
    }

    if (isNumericRank(a) !== isNumericRank(b)) return isNumericRank(a) ? -1 : 1;
    if (isGradeRank(a) !== isGradeRank(b)) return isGradeRank(a) ? -1 : 1;
    return a.sourceOrder - b.sourceOrder;
}

function getSortText(record, column) {
    const hospital = getHospital(record);
    if (column === '医院名称') return hospital?.name || '';
    if (column === '省份') return hospital?.province || '';
    if (column === '城市') return hospital?.city || '';
    return '';
}

function sortFilteredData(records) {
    if (!sortConfig.column) {
        records.sort((a, b) => {
            const yearDiff = b.year - a.year;
            return yearDiff || compareRankWithinYear(a, b, true);
        });
        return;
    }

    const { column, direction } = sortConfig;
    const isAsc = direction === 'asc';

    records.sort((a, b) => {
        if (column === '排名') {
            const yearDiff = b.year - a.year;
            return yearDiff || compareRankWithinYear(a, b, isAsc);
        }

        if (column === '年份') {
            const yearDiff = a.year - b.year;
            if (yearDiff) return isAsc ? yearDiff : -yearDiff;
            return compareRankWithinYear(a, b, true);
        }

        const numericField = SORT_FIELD_MAP[column];
        if (numericField) {
            const diff = compareNullableNumeric(a[numericField], b[numericField], isAsc);
            if (diff) return diff;
        } else {
            const diff = getSortText(a, column).localeCompare(getSortText(b, column), 'zh-CN');
            if (diff) return isAsc ? diff : -diff;
        }

        const yearDiff = b.year - a.year;
        return yearDiff || compareRankWithinYear(a, b, true);
    });
}

function initYearSelect() {
    const yearSelect = document.getElementById('yearSelect');
    const years = rankingDataset.years.map(block => Number(block.year)).sort((a, b) => b - a);
    years.forEach(year => yearSelect.add(new Option(`${year}年`, String(year))));

    const latestYear = years[0];
    const oldestYear = years[years.length - 1];
    const latestBlock = rankingDataset.years.find(block => Number(block.year) === latestYear);

    document.getElementById('yearRange').textContent = `${oldestYear}–${latestYear}`;
    document.getElementById('latestYear').textContent = `${latestYear}年`;
    document.getElementById('latestCount').textContent = `${latestBlock?.records?.length || 0}家`;
    document.getElementById('dataStatus').textContent = `数据截至 ${latestYear} 年 · 已结构化核验`;
}

function currentYearRecords() {
    const year = document.getElementById('yearSelect').value;
    return year ? hospitalRecords.filter(record => String(record.year) === year) : hospitalRecords;
}

function initProvinceSelect() {
    const provinceSelect = document.getElementById('provinceSelect');
    const previousValue = provinceSelect.value;
    const provinces = [...new Set(
        currentYearRecords().map(record => getHospital(record)?.province).filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    provinceSelect.replaceChildren(new Option('全部省份', ''));
    provinces.forEach(province => provinceSelect.add(new Option(province, province)));
    provinceSelect.value = provinces.includes(previousValue) ? previousValue : '';
}

function updateCitySelect(province) {
    const citySelect = document.getElementById('citySelect');
    const previousValue = citySelect.value;
    citySelect.replaceChildren(new Option('全部城市', ''));
    if (!province) return;

    const cities = [...new Set(
        currentYearRecords()
            .filter(record => getHospital(record)?.province === province)
            .map(record => getHospital(record)?.city)
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    cities.forEach(city => citySelect.add(new Option(city, city)));
    citySelect.value = cities.includes(previousValue) ? previousValue : '';
}

function matchesSearch(hospitalId, keywords) {
    const values = hospitalSearchMap.get(hospitalId) || [];
    return keywords.every(keyword => values.some(value => value.includes(keyword)));
}

function getFilteredData() {
    const year = document.getElementById('yearSelect').value;
    const province = document.getElementById('provinceSelect').value;
    const city = document.getElementById('citySelect').value;
    const searchKeyword = document.getElementById('hospitalSearch').value.trim().toLowerCase();
    let records = [...hospitalRecords];

    if (searchKeyword) {
        const keywords = searchKeyword.split(/\s+/).filter(Boolean);
        records = records.filter(record => matchesSearch(record.hospitalId, keywords));
    }
    if (year) records = records.filter(record => String(record.year) === year);
    if (province) records = records.filter(record => getHospital(record)?.province === province);
    if (city) records = records.filter(record => getHospital(record)?.city === city);

    sortFilteredData(records);
    return records;
}

function createTextCell(value, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    const text = isEmptyValue(value) ? '-' : String(value);
    cell.textContent = text;
    if (text === '-') cell.classList.add('empty-value');
    return cell;
}

function createRankCell(record) {
    const cell = document.createElement('td');
    if (isGradeRank(record)) {
        const badge = document.createElement('span');
        badge.className = 'grade-badge';
        badge.textContent = record.grade;
        badge.title = '官方等级制结果；同等级内不代表具体名次';
        cell.appendChild(badge);
    } else {
        const value = document.createElement('span');
        value.className = 'rank-value';
        value.textContent = isNumericRank(record) ? String(Number(record.rank)) : '-';
        cell.appendChild(value);
    }
    return cell;
}

function createHospitalCell(record, rowKey) {
    const hospital = getHospital(record);
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hospital-history-button';
    button.dataset.rowKey = rowKey;
    button.dataset.hospitalId = record.hospitalId;
    button.setAttribute('aria-expanded', String(expandedRowKey === rowKey));

    const name = document.createElement('span');
    name.className = 'hospital-name';
    name.textContent = hospital?.name || record.sourceName;

    const aliases = hospital?.aliases || [];
    if (aliases.length) button.title = `历史名称/别名：${aliases.join('、')}`;
    else button.title = '查看历年排名变化';

    const affordance = document.createElement('span');
    affordance.className = 'history-affordance';
    affordance.setAttribute('aria-hidden', 'true');
    affordance.textContent = '›';

    button.append(name, affordance);
    cell.appendChild(button);
    return cell;
}

function createLocationCell(record, type) {
    const hospital = getHospital(record);
    const value = type === 'province' ? hospital?.province : hospital?.city;
    const cell = document.createElement('td');
    if (!value) {
        cell.textContent = '-';
        cell.className = 'empty-value';
        return cell;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'location-button';
    button.dataset.locationType = type;
    button.dataset.location = value;
    button.dataset.year = String(record.year);
    button.textContent = value;
    button.setAttribute('aria-label', `查看 ${record.year} 年 ${value} 上榜医院数量`);
    cell.appendChild(button);
    return cell;
}

function getRankChange(current, previous) {
    if (!previous) return { text: '首次记录', className: 'is-neutral' };

    if (isNumericRank(current) && isNumericRank(previous)) {
        const improvement = Number(previous.rank) - Number(current.rank);
        if (improvement > 0) return { text: `↑ 上升 ${improvement} 位`, className: 'is-up' };
        if (improvement < 0) return { text: `↓ 下降 ${Math.abs(improvement)} 位`, className: 'is-down' };
        return { text: '— 持平', className: 'is-neutral' };
    }
    if (isGradeRank(current) && isGradeRank(previous)) {
        const diff = GRADE_ORDER[current.grade] - GRADE_ORDER[previous.grade];
        if (diff < 0) return { text: '↑ 等级提升', className: 'is-up' };
        if (diff > 0) return { text: '↓ 等级下降', className: 'is-down' };
        return { text: '— 等级持平', className: 'is-neutral' };
    }
    if (isGradeRank(current) && isNumericRank(previous)) return { text: '改为等级制', className: 'is-system' };
    if (isNumericRank(current) && isGradeRank(previous)) return { text: '恢复数字排名', className: 'is-system' };
    return { text: '制度变化', className: 'is-system' };
}

function createHistoryRow(hospitalId, rowKey) {
    const hospital = getHospital(hospitalId);
    const history = hospitalHistoryMap.get(hospitalId) || [];
    const row = document.createElement('tr');
    row.className = 'rank-history-row';
    row.dataset.historyFor = rowKey;

    const cell = document.createElement('td');
    cell.colSpan = 8;
    const panel = document.createElement('div');
    panel.className = 'rank-history-panel';

    const header = document.createElement('div');
    header.className = 'rank-history-header';
    const title = document.createElement('strong');
    title.textContent = `${hospital?.name || '医院'} · 历年排名变化`;
    const note = document.createElement('span');
    note.textContent = '等级制年份不换算为具体名次；历史名称保留源站原文';
    header.append(title, note);

    const list = document.createElement('ol');
    list.className = 'rank-history-list';
    history.forEach((record, index) => {
        const item = document.createElement('li');
        item.className = 'rank-history-item';

        const year = document.createElement('span');
        year.className = 'history-year';
        year.textContent = `${record.year}年`;

        const rank = document.createElement('span');
        rank.className = 'history-rank';
        rank.textContent = formatRank(record);

        const change = getRankChange(record, history[index + 1]);
        const changeText = document.createElement('span');
        changeText.className = `history-change ${change.className}`;
        changeText.textContent = change.text;

        item.append(year, rank, changeText);
        if (hospital && record.sourceName && record.sourceName !== hospital.name) {
            const sourceName = document.createElement('span');
            sourceName.className = 'history-source-name';
            sourceName.textContent = `当年榜单：${record.sourceName}`;
            item.appendChild(sourceName);
        }
        list.appendChild(item);
    });

    panel.append(header, list);
    cell.appendChild(panel);
    row.appendChild(cell);
    return row;
}

function updateResultSummary(records) {
    const selectedYear = document.getElementById('yearSelect').value;
    const uniqueHospitals = new Set(records.map(record => record.hospitalId)).size;
    document.getElementById('resultSummary').textContent = selectedYear
        ? `${selectedYear} 年 · ${records.length} 条记录`
        : `${records.length} 条历年记录 · ${uniqueHospitals} 家医院`;
}

function displayHospitals() {
    const hospitalList = document.getElementById('hospitalList');
    hospitalList.replaceChildren();
    const records = getFilteredData();
    updateResultSummary(records);

    if (!records.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 8;
        cell.className = 'empty-message';
        cell.textContent = '没有找到符合条件的医院数据';
        row.appendChild(cell);
        hospitalList.appendChild(row);
        return;
    }

    const fragment = document.createDocumentFragment();
    records.forEach(record => {
        const rowKey = `${record.year}::${record.hospitalId}`;
        const row = document.createElement('tr');
        row.className = 'data-row';
        row.dataset.rowKey = rowKey;
        if (expandedRowKey === rowKey) row.classList.add('is-expanded');

        row.append(
            createTextCell(record.year),
            createRankCell(record),
            createHospitalCell(record, rowKey),
            createTextCell(formatNumber(record.specialtyReputation)),
            createTextCell(formatNumber(record.researchAcademic)),
            createTextCell(formatNumber(record.overallScore)),
            createLocationCell(record, 'province'),
            createLocationCell(record, 'city')
        );
        fragment.appendChild(row);
        if (expandedRowKey === rowKey) fragment.appendChild(createHistoryRow(record.hospitalId, rowKey));
    });
    hospitalList.appendChild(fragment);
}

function updateSortIndicators() {
    document.querySelectorAll('#hospitalTable thead th').forEach(th => th.setAttribute('aria-sort', 'none'));
    if (!sortConfig.column) return;
    const button = document.querySelector(`#hospitalTable thead button[data-sort="${sortConfig.column}"]`);
    if (button) button.closest('th').setAttribute('aria-sort', sortConfig.direction === 'asc' ? 'ascending' : 'descending');
}

function handleSort(event) {
    const button = event.target.closest('button[data-sort]');
    if (!button) return;
    const column = button.dataset.sort;
    if (sortConfig.column === column) sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
    else {
        sortConfig.column = column;
        sortConfig.direction = 'asc';
    }
    expandedRowKey = null;
    updateSortIndicators();
    displayHospitals();
}

function showLocationStats(button) {
    const tooltip = document.getElementById('statsTooltip');
    const { locationType, location, year } = button.dataset;
    const count = hospitalRecords.filter(record => {
        if (String(record.year) !== year) return false;
        const hospital = getHospital(record);
        return (locationType === 'province' ? hospital?.province : hospital?.city) === location;
    }).length;
    tooltip.textContent = `${year} 年 ${location} 有 ${count} 家上榜医院`;
    tooltip.hidden = false;

    const rect = button.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 12);
    const top = Math.min(rect.bottom + 6, window.innerHeight - tooltip.offsetHeight - 12);
    tooltip.style.left = `${Math.max(12, left)}px`;
    tooltip.style.top = `${Math.max(12, top)}px`;
}

function hideLocationStats() {
    document.getElementById('statsTooltip').hidden = true;
}

function bindEvents() {
    document.getElementById('hospitalTable').querySelector('thead').addEventListener('click', handleSort);
    document.getElementById('yearSelect').addEventListener('change', () => {
        initProvinceSelect();
        document.getElementById('citySelect').value = '';
        updateCitySelect(document.getElementById('provinceSelect').value);
        expandedRowKey = null;
        displayHospitals();
    });
    document.getElementById('provinceSelect').addEventListener('change', event => {
        updateCitySelect(event.target.value);
        expandedRowKey = null;
        displayHospitals();
    });
    document.getElementById('citySelect').addEventListener('change', () => {
        expandedRowKey = null;
        displayHospitals();
    });
    document.getElementById('hospitalSearch').addEventListener('input', debounce(() => {
        expandedRowKey = null;
        displayHospitals();
    }, 220));

    const hospitalList = document.getElementById('hospitalList');
    hospitalList.addEventListener('click', event => {
        const historyButton = event.target.closest('.hospital-history-button');
        if (historyButton) {
            const rowKey = historyButton.dataset.rowKey;
            expandedRowKey = expandedRowKey === rowKey ? null : rowKey;
            displayHospitals();
            if (expandedRowKey) {
                const expanded = [...document.querySelectorAll('#hospitalList tr.data-row')].find(row => row.dataset.rowKey === rowKey);
                expanded?.querySelector('.hospital-history-button')?.focus({ preventScroll: true });
            }
            return;
        }
        const locationButton = event.target.closest('.location-button');
        if (locationButton) showLocationStats(locationButton);
    });
    hospitalList.addEventListener('mouseover', event => {
        const button = event.target.closest('.location-button');
        if (button) showLocationStats(button);
    });
    hospitalList.addEventListener('mouseout', event => {
        if (event.target.closest('.location-button')) hideLocationStats();
    });
    hospitalList.addEventListener('focusin', event => {
        const button = event.target.closest('.location-button');
        if (button) showLocationStats(button);
    });
    hospitalList.addEventListener('focusout', event => {
        if (event.target.closest('.location-button')) hideLocationStats();
    });
}

function showInitError(error) {
    console.error('初始化失败:', error);
    const hospitalList = document.getElementById('hospitalList');
    hospitalList.replaceChildren();
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 8;
    cell.className = 'error-message';
    cell.textContent = '榜单数据加载失败，请刷新页面重试';
    row.appendChild(cell);
    hospitalList.appendChild(row);
    document.getElementById('resultSummary').textContent = '加载失败';
    document.getElementById('dataStatus').textContent = '数据加载失败';
}

async function init() {
    try {
        await loadRankingData();
        buildIndexes();
        initYearSelect();
        initProvinceSelect();
        updateCitySelect('');
        bindEvents();
        updateSortIndicators();
        displayHospitals();
        document.getElementById('copyrightYear').textContent = String(new Date().getFullYear());
    } catch (error) {
        showInitError(error);
    }
}

document.addEventListener('DOMContentLoaded', init);
