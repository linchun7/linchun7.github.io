const GRADE_ORDER = Object.freeze({
    'A++++': 1,
    'A+++': 2,
    'A++': 3,
    'A+': 4,
    'A': 5
});

let hospitalAliasMap = new Map();
let yearlyAliasMap = new Map();
let hospitalHistoryMap = new Map();
let sourceOrderMap = new WeakMap();
let expandedRowKey = null;

const sortConfig = {
    column: null,
    direction: 'asc'
};

function isEmptyValue(value) {
    return value === '' || value === null || value === undefined;
}

function isNumericRank(value) {
    if (isEmptyValue(value)) return false;
    const numeric = Number(value);
    return Number.isFinite(numeric);
}

function isGradeRank(value) {
    return Object.prototype.hasOwnProperty.call(GRADE_ORDER, value);
}

function formatRank(value) {
    if (isNumericRank(value)) return `第${Number(value)}名`;
    return String(value || '-');
}

function formatNumber(value) {
    if (isEmptyValue(value)) return '-';
    if (typeof value === 'number') {
        return value.toFixed(2).replace(/\.?0+$/, '');
    }
    return String(value);
}

function debounce(func, wait) {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };
}

function buildIndexes() {
    hospitalAliasMap = new Map();
    yearlyAliasMap = new Map();
    hospitalHistoryMap = new Map();
    sourceOrderMap = new WeakMap();

    hospitalData.forEach((hospital, index) => {
        sourceOrderMap.set(hospital, index);

        if (!hospitalHistoryMap.has(hospital.医院名称)) {
            hospitalHistoryMap.set(hospital.医院名称, []);
        }
        hospitalHistoryMap.get(hospital.医院名称).push(hospital);

        if (!hospitalAliasMap.has(hospital.医院名称)) {
            hospitalAliasMap.set(hospital.医院名称, new Set());
        }

        const aliases = hospital.曾用名称
            ? hospital.曾用名称.split('、').map(name => name.trim()).filter(Boolean)
            : [];
        const aliasSet = hospitalAliasMap.get(hospital.医院名称);
        aliases.forEach(alias => aliasSet.add(alias));

        if (!yearlyAliasMap.has(hospital.年份)) {
            yearlyAliasMap.set(hospital.年份, new Map());
        }
        if (aliases.length) {
            yearlyAliasMap.get(hospital.年份).set(hospital.医院名称, aliases);
        }
    });

    hospitalHistoryMap.forEach(history => {
        history.sort((a, b) => Number(b.年份) - Number(a.年份));
    });
}

function getAliases(hospital) {
    const yearMap = yearlyAliasMap.get(hospital.年份);
    const yearlyAliases = yearMap?.get(hospital.医院名称) || [];
    if (yearlyAliases.length) return yearlyAliases;
    return [...(hospitalAliasMap.get(hospital.医院名称) || [])];
}

function getNearestPreviousNumericRank(hospitalName, beforeYear) {
    const history = hospitalHistoryMap.get(hospitalName) || [];
    const record = history.find(item => Number(item.年份) < Number(beforeYear) && isNumericRank(item.排名));
    return record ? Number(record.排名) : null;
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
    const aNumeric = isNumericRank(a.排名);
    const bNumeric = isNumericRank(b.排名);
    const aGrade = isGradeRank(a.排名);
    const bGrade = isGradeRank(b.排名);

    if (aNumeric && bNumeric) {
        const diff = Number(a.排名) - Number(b.排名);
        return isAsc ? diff : -diff;
    }

    if (aGrade && bGrade) {
        const gradeDiff = GRADE_ORDER[a.排名] - GRADE_ORDER[b.排名];
        if (gradeDiff !== 0) return isAsc ? gradeDiff : -gradeDiff;

        const aHistoryRank = getNearestPreviousNumericRank(a.医院名称, a.年份);
        const bHistoryRank = getNearestPreviousNumericRank(b.医院名称, b.年份);
        if (aHistoryRank !== null && bHistoryRank !== null && aHistoryRank !== bHistoryRank) {
            const historyDiff = aHistoryRank - bHistoryRank;
            return isAsc ? historyDiff : -historyDiff;
        }
        if (aHistoryRank !== null && bHistoryRank === null) return -1;
        if (aHistoryRank === null && bHistoryRank !== null) return 1;

        return (sourceOrderMap.get(a) || 0) - (sourceOrderMap.get(b) || 0);
    }

    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (aGrade !== bGrade) return aGrade ? -1 : 1;
    return String(a.排名).localeCompare(String(b.排名), 'zh-CN');
}

function sortFilteredData(filteredData) {
    if (!sortConfig.column) {
        filteredData.sort((a, b) => {
            const yearDiff = Number(b.年份) - Number(a.年份);
            if (yearDiff !== 0) return yearDiff;
            return compareRankWithinYear(a, b, true);
        });
        return;
    }

    const { column, direction } = sortConfig;
    const isAsc = direction === 'asc';

    filteredData.sort((a, b) => {
        if (column === '排名') {
            const yearDiff = Number(b.年份) - Number(a.年份);
            if (yearDiff !== 0) return yearDiff;
            return compareRankWithinYear(a, b, isAsc);
        }

        if (column === '年份') {
            const diff = Number(a.年份) - Number(b.年份);
            if (diff !== 0) return isAsc ? diff : -diff;
            return compareRankWithinYear(a, b, true);
        }

        if (['专科声誉', '科研学术', '综合得分'].includes(column)) {
            const diff = compareNullableNumeric(a[column], b[column], isAsc);
            if (diff !== 0) return diff;
        } else {
            const diff = String(a[column] || '').localeCompare(String(b[column] || ''), 'zh-CN');
            if (diff !== 0) return isAsc ? diff : -diff;
        }

        const yearDiff = Number(b.年份) - Number(a.年份);
        if (yearDiff !== 0) return yearDiff;
        return compareRankWithinYear(a, b, true);
    });
}

function initYearSelect() {
    const yearSelect = document.getElementById('yearSelect');
    const years = [...new Set(hospitalData.map(item => Number(item.年份)).filter(Boolean))].sort((a, b) => b - a);

    years.forEach(year => {
        const option = document.createElement('option');
        option.value = String(year);
        option.textContent = `${year}年`;
        yearSelect.appendChild(option);
    });

    const latestYear = years[0];
    const oldestYear = years[years.length - 1];
    const latestCount = hospitalData.filter(item => Number(item.年份) === latestYear).length;

    document.getElementById('yearRange').textContent = `${oldestYear}–${latestYear}`;
    document.getElementById('latestYear').textContent = `${latestYear}年`;
    document.getElementById('latestCount').textContent = `${latestCount}家`;
    document.getElementById('dataStatus').textContent = `数据截至 ${latestYear} 年`;
}

function initProvinceSelect() {
    const provinceSelect = document.getElementById('provinceSelect');
    const selectedYear = document.getElementById('yearSelect').value;
    const previousValue = provinceSelect.value;

    const filteredData = selectedYear
        ? hospitalData.filter(item => String(item.年份) === selectedYear)
        : hospitalData;
    const provinces = [...new Set(filteredData.map(item => item.省份).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    provinceSelect.replaceChildren(new Option('全部省份', ''));
    provinces.forEach(province => provinceSelect.add(new Option(province, province)));
    provinceSelect.value = provinces.includes(previousValue) ? previousValue : '';
}

function updateCitySelect(province) {
    const citySelect = document.getElementById('citySelect');
    const selectedYear = document.getElementById('yearSelect').value;
    const previousValue = citySelect.value;

    citySelect.replaceChildren(new Option('全部城市', ''));
    if (!province) return;

    const cities = [...new Set(
        hospitalData
            .filter(item => !selectedYear || String(item.年份) === selectedYear)
            .filter(item => item.省份 === province)
            .map(item => item.城市)
            .filter(Boolean)
    )].sort((a, b) => a.localeCompare(b, 'zh-CN'));

    cities.forEach(city => citySelect.add(new Option(city, city)));
    citySelect.value = cities.includes(previousValue) ? previousValue : '';
}

function matchesSearch(hospitalName, keywords) {
    const searchableValues = [hospitalName, ...(hospitalAliasMap.get(hospitalName) || [])]
        .map(value => String(value).toLowerCase());
    return keywords.every(keyword => searchableValues.some(value => value.includes(keyword)));
}

function getFilteredData() {
    const year = document.getElementById('yearSelect').value;
    const province = document.getElementById('provinceSelect').value;
    const city = document.getElementById('citySelect').value;
    const searchKeyword = document.getElementById('hospitalSearch').value.trim().toLowerCase();

    let filteredData = [...hospitalData];

    if (searchKeyword) {
        const keywords = searchKeyword.split(/\s+/).filter(Boolean);
        const matchedHospitals = new Set();
        hospitalHistoryMap.forEach((_history, hospitalName) => {
            if (matchesSearch(hospitalName, keywords)) matchedHospitals.add(hospitalName);
        });
        filteredData = filteredData.filter(item => matchedHospitals.has(item.医院名称));
    }

    if (year) filteredData = filteredData.filter(item => String(item.年份) === year);
    if (province) filteredData = filteredData.filter(item => item.省份 === province);
    if (city) filteredData = filteredData.filter(item => item.城市 === city);

    sortFilteredData(filteredData);
    return filteredData;
}

function createTextCell(value, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    const text = isEmptyValue(value) ? '-' : String(value);
    cell.textContent = text;
    if (text === '-') cell.classList.add('empty-value');
    return cell;
}

function createRankCell(hospital) {
    const cell = document.createElement('td');
    if (isGradeRank(hospital.排名)) {
        const badge = document.createElement('span');
        badge.className = 'grade-badge';
        badge.textContent = hospital.排名;
        badge.title = '官方等级制结果；同等级内不代表具体名次';
        cell.appendChild(badge);
    } else {
        const rank = document.createElement('span');
        rank.className = 'rank-value';
        rank.textContent = isNumericRank(hospital.排名) ? String(Number(hospital.排名)) : String(hospital.排名 || '-');
        cell.appendChild(rank);
    }
    return cell;
}

function createHospitalCell(hospital, rowKey) {
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hospital-history-button';
    button.dataset.rowKey = rowKey;
    button.dataset.hospitalName = hospital.医院名称;
    button.setAttribute('aria-expanded', String(expandedRowKey === rowKey));

    const name = document.createElement('span');
    name.className = 'hospital-name';
    name.textContent = hospital.医院名称;

    const aliases = getAliases(hospital);
    if (aliases.length) button.title = `曾用名称：${aliases.join('、')}`;
    else button.title = '查看历年排名变化';

    const affordance = document.createElement('span');
    affordance.className = 'history-affordance';
    affordance.setAttribute('aria-hidden', 'true');
    affordance.textContent = '›';

    button.append(name, affordance);
    cell.appendChild(button);
    return cell;
}

function createLocationCell(hospital, type) {
    const field = type === 'province' ? '省份' : '城市';
    const cell = document.createElement('td');
    const value = hospital[field];
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
    button.dataset.year = String(hospital.年份);
    button.textContent = value;
    button.setAttribute('aria-label', `查看 ${hospital.年份} 年 ${value} 上榜医院数量`);
    cell.appendChild(button);
    return cell;
}

function getRankChange(current, previous) {
    if (!previous) return { text: '首次记录', className: 'is-neutral' };

    if (isNumericRank(current.排名) && isNumericRank(previous.排名)) {
        const improvement = Number(previous.排名) - Number(current.排名);
        if (improvement > 0) return { text: `↑ 上升 ${improvement} 位`, className: 'is-up' };
        if (improvement < 0) return { text: `↓ 下降 ${Math.abs(improvement)} 位`, className: 'is-down' };
        return { text: '— 持平', className: 'is-neutral' };
    }

    if (isGradeRank(current.排名) && isGradeRank(previous.排名)) {
        const currentOrder = GRADE_ORDER[current.排名];
        const previousOrder = GRADE_ORDER[previous.排名];
        if (currentOrder < previousOrder) return { text: '↑ 等级提升', className: 'is-up' };
        if (currentOrder > previousOrder) return { text: '↓ 等级下降', className: 'is-down' };
        return { text: '— 等级持平', className: 'is-neutral' };
    }

    if (isGradeRank(current.排名) && isNumericRank(previous.排名)) {
        return { text: '改为等级制', className: 'is-system' };
    }
    if (isNumericRank(current.排名) && isGradeRank(previous.排名)) {
        return { text: '恢复数字排名', className: 'is-system' };
    }
    return { text: '制度变化', className: 'is-system' };
}

function createHistoryRow(hospitalName, rowKey) {
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
    title.textContent = `${hospitalName} · 历年排名变化`;
    const note = document.createElement('span');
    note.textContent = '等级制年份不换算为具体名次';
    header.append(title, note);

    const list = document.createElement('ol');
    list.className = 'rank-history-list';
    const history = hospitalHistoryMap.get(hospitalName) || [];

    history.forEach((record, index) => {
        const item = document.createElement('li');
        item.className = 'rank-history-item';

        const year = document.createElement('span');
        year.className = 'history-year';
        year.textContent = `${record.年份}年`;

        const rank = document.createElement('span');
        rank.className = 'history-rank';
        rank.textContent = formatRank(record.排名);

        const change = getRankChange(record, history[index + 1]);
        const changeText = document.createElement('span');
        changeText.className = `history-change ${change.className}`;
        changeText.textContent = change.text;

        item.append(year, rank, changeText);
        list.appendChild(item);
    });

    panel.append(header, list);
    cell.appendChild(panel);
    row.appendChild(cell);
    return row;
}

function updateResultSummary(filteredData) {
    const selectedYear = document.getElementById('yearSelect').value;
    const uniqueHospitals = new Set(filteredData.map(item => item.医院名称)).size;
    if (selectedYear) {
        document.getElementById('resultSummary').textContent = `${selectedYear} 年 · ${filteredData.length} 条记录`;
    } else {
        document.getElementById('resultSummary').textContent = `${filteredData.length} 条历年记录 · ${uniqueHospitals} 家医院`;
    }
}

function displayHospitals() {
    const hospitalList = document.getElementById('hospitalList');
    hospitalList.replaceChildren();

    const filteredData = getFilteredData();
    updateResultSummary(filteredData);

    if (!filteredData.length) {
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
    filteredData.forEach(hospital => {
        const rowKey = `${hospital.年份}::${hospital.医院名称}`;
        const row = document.createElement('tr');
        row.className = 'data-row';
        row.dataset.rowKey = rowKey;
        if (expandedRowKey === rowKey) row.classList.add('is-expanded');

        row.append(
            createTextCell(hospital.年份),
            createRankCell(hospital),
            createHospitalCell(hospital, rowKey),
            createTextCell(formatNumber(hospital.专科声誉)),
            createTextCell(formatNumber(hospital.科研学术)),
            createTextCell(formatNumber(hospital.综合得分)),
            createLocationCell(hospital, 'province'),
            createLocationCell(hospital, 'city')
        );
        fragment.appendChild(row);

        if (expandedRowKey === rowKey) {
            fragment.appendChild(createHistoryRow(hospital.医院名称, rowKey));
        }
    });

    hospitalList.appendChild(fragment);
}

function updateSortIndicators() {
    document.querySelectorAll('#hospitalTable thead th').forEach(th => th.setAttribute('aria-sort', 'none'));
    if (!sortConfig.column) return;
    const button = document.querySelector(`#hospitalTable thead button[data-sort="${sortConfig.column}"]`);
    if (!button) return;
    button.closest('th').setAttribute('aria-sort', sortConfig.direction === 'asc' ? 'ascending' : 'descending');
}

function handleSort(event) {
    const button = event.target.closest('button[data-sort]');
    if (!button) return;

    const column = button.dataset.sort;
    if (sortConfig.column === column) {
        sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
    } else {
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
    const field = locationType === 'province' ? '省份' : '城市';
    const count = hospitalData.filter(item => String(item.年份) === year && item[field] === location).length;
    tooltip.textContent = `${year} 年 ${location} 有 ${count} 家上榜医院`;
    tooltip.hidden = false;

    const rect = button.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - tooltip.offsetWidth - 12);
    const top = Math.min(rect.bottom + 6, window.innerHeight - tooltip.offsetHeight - 12);
    tooltip.style.left = `${Math.max(12, left)}px`;
    tooltip.style.top = `${Math.max(12, top)}px`;
}

function hideLocationStats() {
    const tooltip = document.getElementById('statsTooltip');
    tooltip.hidden = true;
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
                const expandedRow = [...document.querySelectorAll('#hospitalList tr.data-row')]
                    .find(row => row.dataset.rowKey === rowKey);
                expandedRow?.querySelector('.hospital-history-button')?.focus({ preventScroll: true });
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
    cell.textContent = '系统初始化失败，请刷新页面重试';
    row.appendChild(cell);
    hospitalList.appendChild(row);
    document.getElementById('resultSummary').textContent = '加载失败';
}

function init() {
    try {
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
