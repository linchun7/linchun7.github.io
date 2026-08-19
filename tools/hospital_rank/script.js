const PAGE_SIZE = 100;
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
let gradeOrder = new Map();
let currentPage = 1;
let lastHistoryTrigger = null;

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
    return typeof record.grade === 'string' && gradeOrder.has(record.grade);
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
    const response = await fetch('./data/rankings.json');
    if (!response.ok) throw new Error(`数据加载失败：HTTP ${response.status}`);

    const data = await response.json();
    if (data?.schemaVersion !== 1 || !Array.isArray(data.hospitals) || !Array.isArray(data.years)) {
        throw new Error('榜单 JSON 结构无效');
    }

    rankingDataset = data;
    hospitalById = new Map(data.hospitals.map(hospital => [hospital.id, hospital]));
    if (hospitalById.size !== data.hospitals.length) throw new Error('医院实体 ID 存在重复');

    const grades = data.rankingModes?.grade?.grades || [];
    gradeOrder = new Map(grades.map((grade, index) => [grade, index]));

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

function getNearestPreviousNumericRecord(hospitalId, beforeYear) {
    const history = hospitalHistoryMap.get(hospitalId) || [];
    return history.find(item => item.year < Number(beforeYear) && isNumericRank(item)) || null;
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
        const gradeDiff = gradeOrder.get(a.grade) - gradeOrder.get(b.grade);
        if (gradeDiff !== 0) return isAsc ? gradeDiff : -gradeDiff;

        const aPrevious = getNearestPreviousNumericRecord(a.hospitalId, a.year);
        const bPrevious = getNearestPreviousNumericRecord(b.hospitalId, b.year);
        if (aPrevious && bPrevious && Number(aPrevious.rank) !== Number(bPrevious.rank)) {
            const diff = Number(aPrevious.rank) - Number(bPrevious.rank);
            return isAsc ? diff : -diff;
        }
        if (aPrevious && !bPrevious) return -1;
        if (!aPrevious && bPrevious) return 1;
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
    yearSelect.replaceChildren();
    years.forEach(year => yearSelect.add(new Option(`${year}年`, String(year))));
    yearSelect.add(new Option('全部年份', ''));

    const latestYear = years[0];
    const oldestYear = years[years.length - 1];
    yearSelect.value = String(latestYear);
    document.getElementById('brandSubtitle').textContent = `中国医院综合排行榜 · ${oldestYear}–${latestYear}`;
    document.getElementById('dataStatus').textContent = `最新数据 ${latestYear} 年 · 已结构化核验`;
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

function updateCitySelect(province, preserveValue = true) {
    const citySelect = document.getElementById('citySelect');
    const previousValue = preserveValue ? citySelect.value : '';
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
        badge.title = '官方等级；同等级内本站按最近一次数字排名作历史参考排序';
        cell.appendChild(badge);
    } else {
        const value = document.createElement('span');
        value.className = 'rank-value';
        value.textContent = isNumericRank(record) ? String(Number(record.rank)) : '-';
        cell.appendChild(value);
    }
    return cell;
}

function createHospitalCell(record) {
    const hospital = getHospital(record);
    const cell = document.createElement('td');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'hospital-history-button';
    button.dataset.hospitalId = record.hospitalId;
    button.setAttribute('aria-haspopup', 'dialog');

    const name = document.createElement('span');
    name.className = 'hospital-name';
    name.textContent = hospital?.name || record.sourceName;

    const affordance = document.createElement('span');
    affordance.className = 'history-affordance';
    affordance.setAttribute('aria-hidden', 'true');
    affordance.textContent = '›';

    const aliases = hospital?.aliases || [];
    button.title = aliases.length ? `查看历年排名与历史名称：${aliases.join('、')}` : '查看历年排名';
    button.append(name, affordance);
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
        const diff = gradeOrder.get(current.grade) - gradeOrder.get(previous.grade);
        if (diff < 0) return { text: '↑ 等级提升', className: 'is-up' };
        if (diff > 0) return { text: '↓ 等级下降', className: 'is-down' };
        return { text: '— 等级持平', className: 'is-neutral' };
    }
    if (isGradeRank(current) && isNumericRank(previous)) return { text: '改为等级制', className: 'is-system' };
    if (isNumericRank(current) && isGradeRank(previous)) return { text: '恢复数字排名', className: 'is-system' };
    return { text: '制度变化', className: 'is-system' };
}

function getKnownSourceNote(hospital, record) {
    if (hospital?.name === '复旦大学附属儿科医院' && record.year === 2014) {
        return '来源页面显示专科声誉 8.984、科研学术 5.795、综合得分 14.799，三项存在 0.020 的算术差异；本站保留来源展示值。';
    }
    return '';
}

function openHistoryDialog(hospitalId, trigger) {
    const dialog = document.getElementById('historyDialog');
    const body = document.getElementById('historyDialogBody');
    const hospital = getHospital(hospitalId);
    const history = hospitalHistoryMap.get(hospitalId) || [];
    if (!hospital || !history.length) return;

    lastHistoryTrigger = trigger;
    document.getElementById('historyDialogTitle').textContent = `${hospital.name} · 历年排名`;
    document.getElementById('historyDialogMeta').textContent = [hospital.province, hospital.city].filter(Boolean).join(' · ');
    body.replaceChildren();

    if (hospital.aliases?.length) {
        const aliases = document.createElement('p');
        aliases.className = 'history-aliases';
        const label = document.createElement('strong');
        label.textContent = '历史名称/别名：';
        aliases.append(label, document.createTextNode(hospital.aliases.join('、')));
        body.appendChild(aliases);
    }

    const list = document.createElement('ol');
    list.className = 'dialog-history-list';
    history.forEach((record, index) => {
        const item = document.createElement('li');
        item.className = 'dialog-history-item';

        const year = document.createElement('span');
        year.className = 'dialog-history-year';
        year.textContent = `${record.year}年`;

        const rank = document.createElement('span');
        rank.className = 'dialog-history-rank';
        rank.textContent = formatRank(record);

        const change = getRankChange(record, history[index + 1]);
        const changeText = document.createElement('span');
        changeText.className = `dialog-history-change history-change ${change.className}`;
        changeText.textContent = change.text;

        item.append(year, rank, changeText);

        if (record.sourceName && record.sourceName !== hospital.name) {
            const sourceName = document.createElement('span');
            sourceName.className = 'dialog-history-source';
            sourceName.textContent = `当年来源页面名称：${record.sourceName}`;
            item.appendChild(sourceName);
        }

        const sourceNote = getKnownSourceNote(hospital, record);
        if (sourceNote) {
            const note = document.createElement('span');
            note.className = 'dialog-history-note';
            note.textContent = `来源数据备注：${sourceNote}`;
            item.appendChild(note);
        }

        list.appendChild(item);
    });
    body.appendChild(list);

    const methodNote = document.createElement('p');
    methodNote.className = 'dialog-method-note';
    methodNote.textContent = '等级制年份仅展示官方等级；同等级内的先后顺序使用最近一次可用数字排名作为本站历史参考，不代表官方档内名次。';
    body.appendChild(methodNote);

    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
}

function selectedYearBlock() {
    const year = document.getElementById('yearSelect').value;
    if (!year) return null;
    return rankingDataset.years.find(block => String(block.year) === year) || null;
}

function updateContext(records) {
    const year = document.getElementById('yearSelect').value;
    const title = document.getElementById('workspaceTitle');
    const summary = document.getElementById('resultSummary');
    const modeNote = document.getElementById('rankingModeNote');
    const table = document.getElementById('hospitalTable');
    const block = selectedYearBlock();
    const gradeMode = block?.rankingMode === 'grade';

    table.classList.toggle('single-year', Boolean(year));
    table.classList.toggle('grade-mode', gradeMode);
    title.textContent = year ? `${year} 年医院榜单` : '历年医院榜单';

    if (year) {
        summary.textContent = `${year} 年 · 共 ${records.length} 家医院`;
    } else {
        const uniqueHospitals = new Set(records.map(record => record.hospitalId)).size;
        summary.textContent = `共 ${records.length} 条历年记录 · ${uniqueHospitals} 家医院`;
    }

    if (gradeMode) {
        const referenceYears = new Set(records.map(record => getNearestPreviousNumericRecord(record.hospitalId, record.year)?.year).filter(Boolean));
        const suffix = referenceYears.size === 1 ? `（主要参考 ${[...referenceYears][0]} 年）` : '';
        modeNote.textContent = `同等级内按最近一次可用数字排名作历史参考排序${suffix}，非官方档内名次。`;
        modeNote.hidden = false;
    } else {
        modeNote.hidden = true;
        modeNote.textContent = '';
    }
}

function renderPagination(totalRecords) {
    const pagination = document.getElementById('pagination');
    const allYears = document.getElementById('yearSelect').value === '';
    const totalPages = allYears ? Math.max(1, Math.ceil(totalRecords / PAGE_SIZE)) : 1;
    currentPage = Math.min(currentPage, totalPages);

    const shouldShow = allYears && totalRecords > PAGE_SIZE;
    pagination.hidden = !shouldShow;
    if (!shouldShow) return { start: 0, end: totalRecords };

    document.getElementById('paginationStatus').textContent = `第 ${currentPage} / ${totalPages} 页`;
    document.getElementById('prevPage').disabled = currentPage <= 1;
    document.getElementById('nextPage').disabled = currentPage >= totalPages;
    return {
        start: (currentPage - 1) * PAGE_SIZE,
        end: currentPage * PAGE_SIZE
    };
}

function displayHospitals() {
    const hospitalList = document.getElementById('hospitalList');
    const records = getFilteredData();
    updateContext(records);
    const pageRange = renderPagination(records.length);
    const visibleRecords = records.slice(pageRange.start, pageRange.end);

    hospitalList.replaceChildren();
    if (!visibleRecords.length) {
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
    visibleRecords.forEach(record => {
        const hospital = getHospital(record);
        const row = document.createElement('tr');
        row.className = 'data-row';
        row.dataset.hospitalId = record.hospitalId;
        row.dataset.year = String(record.year);
        row.append(
            createTextCell(record.year),
            createRankCell(record),
            createHospitalCell(record),
            createTextCell(formatNumber(record.specialtyReputation)),
            createTextCell(formatNumber(record.researchAcademic)),
            createTextCell(formatNumber(record.overallScore)),
            createTextCell(hospital?.province),
            createTextCell(hospital?.city)
        );
        fragment.appendChild(row);
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
    currentPage = 1;
    updateSortIndicators();
    displayHospitals();
}

function bindEvents() {
    document.getElementById('hospitalTable').querySelector('thead').addEventListener('click', handleSort);

    document.getElementById('yearSelect').addEventListener('change', () => {
        currentPage = 1;
        initProvinceSelect();
        updateCitySelect(document.getElementById('provinceSelect').value, false);
        displayHospitals();
    });

    document.getElementById('provinceSelect').addEventListener('change', event => {
        currentPage = 1;
        updateCitySelect(event.target.value, false);
        displayHospitals();
    });

    document.getElementById('citySelect').addEventListener('change', () => {
        currentPage = 1;
        displayHospitals();
    });

    document.getElementById('hospitalSearch').addEventListener('input', debounce(() => {
        currentPage = 1;
        displayHospitals();
    }, 180));

    document.getElementById('hospitalList').addEventListener('click', event => {
        const historyButton = event.target.closest('.hospital-history-button');
        if (!historyButton) return;
        openHistoryDialog(historyButton.dataset.hospitalId, historyButton);
    });

    document.getElementById('prevPage').addEventListener('click', () => {
        if (currentPage <= 1) return;
        currentPage -= 1;
        displayHospitals();
        document.getElementById('hospitalTable').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    document.getElementById('nextPage').addEventListener('click', () => {
        currentPage += 1;
        displayHospitals();
        document.getElementById('hospitalTable').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });

    const dialog = document.getElementById('historyDialog');
    document.getElementById('historyDialogClose').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
        if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
        lastHistoryTrigger?.focus({ preventScroll: true });
        lastHistoryTrigger = null;
    });
}

function showInitError(error) {
    console.error('初始化失败:', error);
    const hospitalList = document.getElementById('hospitalList');
    const staticRows = hospitalList.querySelectorAll('tr[data-static-prerendered="true"]');

    if (staticRows.length) {
        document.getElementById('dataStatus').textContent = '交互加载失败 · 已显示静态最新榜单';
        const summary = document.getElementById('resultSummary');
        if (!summary.textContent.includes('静态模式')) summary.textContent += ' · 静态模式';
        document.getElementById('rankingModeNote').hidden = true;

        ['yearSelect', 'provinceSelect', 'citySelect', 'hospitalSearch'].forEach(id => {
            document.getElementById(id).disabled = true;
        });
        hospitalList.querySelectorAll('button').forEach(button => {
            button.disabled = true;
            button.title = '交互数据加载失败，当前仅显示静态榜单';
        });
        return;
    }

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
    document.getElementById('copyrightYear').textContent = String(new Date().getFullYear());
    try {
        await loadRankingData();
        buildIndexes();
        initYearSelect();
        initProvinceSelect();
        updateCitySelect('', false);
        bindEvents();
        updateSortIndicators();
        displayHospitals();
    } catch (error) {
        showInitError(error);
    }
}

document.addEventListener('DOMContentLoaded', init);
