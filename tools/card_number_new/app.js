'use strict';

let results = [];
let currentPattern = '';
let currentPage = 1;
let worker = null;
let toastTimeout = null;
let isRunning = false;
let expectedCount = null;
let downloadMode = 'complete';

const pageSize = 200;
const MAX_PATTERN_LENGTH = 100;
const MAX_RETAINED_RESULTS = 1000000;
const ASSET_VERSION = '20260818-1';

const {
    analyzeCardFeatures,
    formatIntegerString,
    getFeatureLabels,
    normalizeRuleInput
} = window.CardNumberCore;

const ui = {
    input: document.getElementById('inputField'),
    calcBtn: document.getElementById('calcBtn'),
    stopBtn: document.getElementById('stopBtn'),
    clearBtn: document.getElementById('clearBtn'),
    count: document.getElementById('resultCount'),
    expectedCount: document.getElementById('expectedCount'),
    validCount: document.getElementById('validCount'),
    lenWarning: document.getElementById('lenWarning'),
    resultContent: document.getElementById('result-container'),
    statusBar: document.getElementById('status-bar'),
    pagination: document.getElementById('pagination'),
    pageInput: document.getElementById('pageInput'),
    totalPages: document.getElementById('totalPages'),
    firstPageBtn: document.getElementById('firstPageBtn'),
    lastPageBtn: document.getElementById('lastPageBtn'),
    prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    copyPageBtn: document.getElementById('copyPageBtn'),
    legendBox: document.getElementById('dynamic-legend'),
    toggleAdvBtn: document.getElementById('toggleAdvBtn'),
    toggleAdvLabel: document.getElementById('toggleAdvLabel'),
    advPanel: document.getElementById('advPanel'),
    excludeOdd: document.getElementById('excludeOdd'),
    excludeEven: document.getElementById('excludeEven'),
    numberCheckboxes: document.getElementById('numberCheckboxes'),
    toast: document.getElementById('toast')
};

function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 2400);
}

function setStatus(message, type = 'success') {
    ui.statusBar.className = `status-pill status-${type}`;
    ui.statusBar.textContent = message;
    ui.statusBar.hidden = false;
}

function summarizeRemovedChars(chars) {
    const shown = chars.slice(0, 6).map((char) => `“${char}”`).join('、');
    return chars.length > 6 ? `${shown} 等` : shown;
}

function sanitizeCurrentInput(announce = true) {
    const normalized = normalizeRuleInput(ui.input.value, MAX_PATTERN_LENGTH);
    if (normalized.value !== ui.input.value) ui.input.value = normalized.value;

    if (announce) {
        const notices = [];
        if (normalized.removedChars.length > 0) {
            notices.push(`已删除不支持字符：${summarizeRemovedChars(normalized.removedChars)}`);
        }
        if (normalized.truncated) notices.push(`最多支持 ${MAX_PATTERN_LENGTH} 位，超出部分已忽略`);
        if (notices.length > 0) showToast(notices.join('；'));
    }

    return normalized;
}

function updateLengthWarning() {
    const length = (ui.input.value.match(/[a-zA-Z0-9*]/g) || []).length;
    ui.validCount.textContent = length;

    if (length > 0 && length < 12) {
        ui.lenWarning.textContent = '少于常见的 12–19 位';
        ui.lenWarning.hidden = false;
    } else if (length > 19) {
        ui.lenWarning.textContent = '超出常见的 12–19 位';
        ui.lenWarning.hidden = false;
    } else {
        ui.lenWarning.textContent = '';
        ui.lenWarning.hidden = true;
    }
}

function updateResultActions() {
    const hasResults = results.length > 0;
    ui.copyPageBtn.hidden = !hasResults;
    ui.downloadBtn.hidden = !(hasResults && !isRunning);

    if (downloadMode === 'partial') {
        ui.downloadBtn.textContent = '下载当前结果（部分）';
    } else if (downloadMode === 'retained') {
        ui.downloadBtn.textContent = '下载生成结果(.csv)';
    } else {
        ui.downloadBtn.textContent = '下载结果(.csv)';
    }
}

function setRunning(running) {
    isRunning = running;
    ui.calcBtn.hidden = running;
    ui.stopBtn.hidden = !running;
    ui.input.disabled = running;
    ui.clearBtn.disabled = running;
    ui.toggleAdvBtn.disabled = running;
    ui.advPanel.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = running; });
    updateResultActions();
}

ui.excludeOdd.addEventListener('change', function () {
    if (this.checked) ui.excludeEven.checked = false;
});

ui.excludeEven.addEventListener('change', function () {
    if (this.checked) ui.excludeOdd.checked = false;
});

ui.toggleAdvBtn.addEventListener('click', () => {
    const expanded = !ui.advPanel.classList.contains('is-open');
    ui.advPanel.classList.toggle('is-open', expanded);
    ui.toggleAdvLabel.textContent = expanded ? '收起高级筛选' : '展开高级筛选';
    ui.toggleAdvBtn.setAttribute('aria-expanded', String(expanded));
});

function failCalculation(message) {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    setRunning(false);
    downloadMode = results.length > 0 ? 'partial' : 'complete';
    updateResultActions();
    setStatus(`计算失败：${message}`, 'error');
    if (results.length === 0) {
        ui.resultContent.innerHTML = '<div class="empty-placeholder error-copy">计算线程发生错误，请重试；如果规则包含大量可变位，可增加固定数字后再计算。</div>';
    }
}

function initWorker() {
    if (worker) worker.terminate();

    const instance = new Worker(`worker.js?v=${ASSET_VERSION}`);
    worker = instance;

    instance.onmessage = function (event) {
        if (worker !== instance) return;
        const data = event.data;

        if (data.type === 'meta') {
            expectedCount = data.expectedCount;
            ui.expectedCount.textContent = formatIntegerString(expectedCount);
            setStatus(`共 ${formatIntegerString(expectedCount)} 条，正在生成`, 'warning');
            return;
        }

        if (data.type === 'error') {
            failCalculation(data.message || '未知错误');
            return;
        }

        if (data.type === 'chunk') {
            const oldLength = results.length;
            results.push(...data.data);
            ui.count.textContent = formatIntegerString(results.length);
            if (oldLength < currentPage * pageSize && results.length > 0) renderPage();
            updatePaginationUI();
            return;
        }

        if (data.type === 'done') {
            instance.terminate();
            worker = null;
            downloadMode = data.truncated ? 'retained' : 'complete';
            setRunning(false);

            if (results.length === 0) {
                ui.resultContent.innerHTML = '<div class="empty-placeholder error-copy">未找到符合规则的卡号，请检查规则或放宽排除条件。</div>';
                setStatus('计算完成，没有符合规则的结果', 'success');
            } else if (data.truncated) {
                setStatus(`结果较多，仅生成前 ${formatIntegerString(results.length)} 条`, 'warning');
                renderPage();
            } else {
                setStatus(`计算完成，共 ${formatIntegerString(results.length)} 条`, 'success');
                renderPage();
            }
            updatePaginationUI();
            updateResultActions();
        }
    };

    instance.onerror = function (event) {
        if (worker !== instance) return;
        event.preventDefault();
        failCalculation(event.message || '后台计算线程无法运行');
    };

    instance.onmessageerror = function () {
        if (worker !== instance) return;
        failCalculation('后台计算结果无法读取');
    };
}

function renderFeatureTags(features) {
    return features.map((feature) => (
        `<span class="tag tag-${feature.type}" title="${feature.title}">${feature.label}</span>`
    )).join('');
}

function generateLegend(pattern) {
    let html = pattern.includes('*') ? '<div class="legend-item"><span class="legend-dot legend-star"></span><span><strong>*</strong>：每位独立取值</span></div>' : '';
    if (/[a-zA-Z]/.test(pattern)) {
        html += '<div class="legend-item"><span class="legend-dot legend-letter"></span><span><strong>字母</strong>：同一字母代表同一数字，不区分大小写</span></div>';
    }

    ui.legendBox.innerHTML = html;
    ui.legendBox.hidden = !html;
}

function formatWithHighlight(cardNumber, pattern) {
    let html = '<div class="number-part">';
    const formatted = cardNumber.replace(/\d{4}(?=\d)/g, '$& ');

    for (let index = 0; index < cardNumber.length; index++) {
        if (index > 0 && index % 4 === 0) html += ' ';
        const patternChar = pattern[index];
        const numberChar = cardNumber[index];

        if (patternChar === '*') {
            html += `<span class="hl-star">${numberChar}</span>`;
        } else if (/[a-zA-Z]/.test(patternChar)) {
            html += `<span class="hl-letter">${numberChar}</span>`;
        } else {
            html += `<span class="hl-normal">${numberChar}</span>`;
        }
    }
    html += '</div>';

    const features = analyzeCardFeatures(cardNumber);
    if (features.length > 0) html += `<div class="tag-part">${renderFeatureTags(features)}</div>`;

    return `<div class="result-row" role="button" tabindex="0" data-clipboard="${cardNumber}" title="点击复制纯数字卡号" aria-label="复制卡号 ${formatted}">${html}</div>`;
}

function renderPage() {
    if (!currentPattern || results.length === 0) return;
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    ui.resultContent.innerHTML = currentData.map((result) => formatWithHighlight(result, currentPattern)).join('');
    ui.pagination.hidden = false;
    updateResultActions();
}

function resetCalculationOutput() {
    results = [];
    currentPage = 1;
    expectedCount = null;
    downloadMode = 'complete';
    ui.count.textContent = '0';
    ui.expectedCount.textContent = '—';
    ui.pagination.hidden = true;
    ui.legendBox.hidden = true;
    ui.legendBox.innerHTML = '';
    updatePaginationUI();
    updateResultActions();
}

function startCalculation() {
    if (isRunning) return;
    ui.input.classList.remove('input-error');
    ui.input.setAttribute('aria-invalid', 'false');
    const normalized = sanitizeCurrentInput(true);
    updateLengthWarning();
    currentPattern = normalized.value.replace(/\s/g, '');
    resetCalculationOutput();

    if (currentPattern.length === 0) {
        ui.resultContent.innerHTML = '<div class="empty-placeholder error-copy">请先输入包含数字、字母或 * 号的卡号规则。</div>';
        ui.input.classList.add('input-error');
        ui.input.setAttribute('aria-invalid', 'true');
        setStatus('请输入有效的卡号规则', 'error');
        ui.input.focus();
        return;
    }

    const excludes = Array.from(ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]:checked'), (checkbox) => checkbox.value);
    const hasVariables = /[a-zA-Z*]/.test(currentPattern);
    const validDigits = [];

    for (let digit = 0; digit <= 9; digit++) {
        if (excludes.includes(String(digit))) continue;
        if (ui.excludeOdd.checked && digit % 2 !== 0) continue;
        if (ui.excludeEven.checked && digit % 2 === 0) continue;
        validDigits.push(digit);
    }

    if (validDigits.length === 0 && hasVariables) {
        ui.resultContent.innerHTML = '<div class="empty-placeholder error-copy">排除条件过滤掉了全部数字，无法填写 * 或字母位。</div>';
        setStatus('排除条件存在冲突', 'error');
        return;
    }

    ui.expectedCount.textContent = '计算中';
    ui.resultContent.innerHTML = '';
    ui.pagination.hidden = true;
    generateLegend(currentPattern);
    setRunning(true);
    setStatus('正在分析规则', 'warning');

    try {
        initWorker();
        worker.postMessage({
            type: 'start',
            input: currentPattern,
            validDigits,
            limit: MAX_RETAINED_RESULTS
        });
    } catch (error) {
        failCalculation(error && error.message ? error.message : '无法启动后台计算');
    }
}

ui.stopBtn.addEventListener('click', () => {
    if (!worker) return;
    worker.terminate();
    worker = null;
    downloadMode = 'partial';
    setRunning(false);
    if (expectedCount === null) ui.expectedCount.textContent = '—';
    setStatus(`已停止，已生成 ${formatIntegerString(results.length)} 条`, 'warning');
    if (results.length === 0) {
        ui.resultContent.innerHTML = '<div class="empty-placeholder">已停止计算，暂未生成结果。</div>';
    } else {
        renderPage();
    }
    updatePaginationUI();
});

ui.clearBtn.addEventListener('click', () => {
    if (worker) {
        worker.terminate();
        worker = null;
    }

    results = [];
    currentPattern = '';
    currentPage = 1;
    expectedCount = null;
    downloadMode = 'complete';
    ui.input.value = '';
    ui.input.classList.remove('input-error');
    ui.input.setAttribute('aria-invalid', 'false');
    ui.count.textContent = '0';
    ui.expectedCount.textContent = '—';
    ui.statusBar.hidden = true;
    ui.legendBox.hidden = true;
    ui.legendBox.innerHTML = '';
    ui.resultContent.innerHTML = '<div class="empty-placeholder">等待输入规则。支持数字、英文字母和 *；空格不计入位数。</div>';
    ui.pagination.hidden = true;
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => { checkbox.checked = false; });
    ui.excludeOdd.checked = false;
    ui.excludeEven.checked = false;
    updateLengthWarning();
    updateResultActions();
    ui.input.focus();
});

function fallbackCopy(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch (error) {
        copied = false;
    }
    document.body.removeChild(textArea);
    return copied;
}

async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            return fallbackCopy(text);
        }
    }
    return fallbackCopy(text);
}

async function copyResultRow(row) {
    const text = row.getAttribute('data-clipboard');
    const copied = await copyText(text);
    showToast(copied ? `复制成功：${text}` : '复制失败，请手动选择号码');
}

ui.resultContent.addEventListener('click', (event) => {
    const row = event.target.closest('.result-row');
    if (row) copyResultRow(row);
});

ui.resultContent.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('.result-row');
    if (!row) return;
    event.preventDefault();
    copyResultRow(row);
});

ui.copyPageBtn.addEventListener('click', async () => {
    if (results.length === 0) return;
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    const content = currentData.map((result) => {
        const formatted = result.replace(/\d{4}(?=\d)/g, '$& ');
        const tags = getFeatureLabels(analyzeCardFeatures(result));
        return tags.length > 0 ? `${formatted}  [${tags.join(', ')}]` : formatted;
    }).join('\n');
    const copied = await copyText(content);
    showToast(copied ? `成功复制本页 ${currentData.length} 条数据` : '复制失败，请重试');
});

ui.input.addEventListener('input', () => {
    ui.input.classList.remove('input-error');
    ui.input.setAttribute('aria-invalid', 'false');
    sanitizeCurrentInput(true);
    updateLengthWarning();
});

ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') startCalculation();
});
ui.calcBtn.addEventListener('click', startCalculation);

function updatePaginationUI() {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    ui.totalPages.textContent = formatIntegerString(total);
    if (document.activeElement !== ui.pageInput) ui.pageInput.value = currentPage;

    const isFirst = currentPage <= 1;
    const isLast = currentPage >= total;
    ui.prevBtn.disabled = isFirst;
    ui.firstPageBtn.disabled = isFirst;
    ui.nextBtn.disabled = isLast;
    ui.lastPageBtn.disabled = isLast;
}

function goToPage(page) {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    currentPage = Math.min(Math.max(1, page), total);
    renderPage();
    updatePaginationUI();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

ui.pageInput.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '');
});
ui.pageInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') this.blur();
});
ui.pageInput.addEventListener('change', function () {
    goToPage(Number.parseInt(this.value, 10) || 1);
});
ui.firstPageBtn.addEventListener('click', () => goToPage(1));
ui.lastPageBtn.addEventListener('click', () => goToPage(Math.ceil(results.length / pageSize)));
ui.prevBtn.addEventListener('click', () => goToPage(currentPage - 1));
ui.nextBtn.addEventListener('click', () => goToPage(currentPage + 1));

function escapeCsv(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

ui.downloadBtn.addEventListener('click', async () => {
    if (results.length === 0 || isRunning || ui.downloadBtn.disabled) return;

    const exportResults = results;
    const exportMode = downloadMode;
    ui.downloadBtn.disabled = true;
    ui.downloadBtn.textContent = '正在整理文件...';

    try {
        const parts = [new Blob(['\uFEFF银行卡号,特征标签\n'], { type: 'text/plain;charset=utf-8' })];
        let lines = [];

        for (let index = 0; index < exportResults.length; index++) {
            const result = exportResults[index];
            const formatted = result.replace(/\d{4}(?=\d)/g, '$& ');
            const tags = getFeatureLabels(analyzeCardFeatures(result));
            lines.push(`${escapeCsv(formatted)},${escapeCsv(tags.length > 0 ? tags.join(' / ') : '无')}\n`);

            if (lines.length >= 2000) {
                parts.push(new Blob([lines.join('')], { type: 'text/plain;charset=utf-8' }));
                lines = [];
            }
            if (index > 0 && index % 10000 === 0) {
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
        if (lines.length > 0) parts.push(new Blob([lines.join('')], { type: 'text/plain;charset=utf-8' }));

        const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const suffix = exportMode === 'partial' ? '_部分结果' : '';
        link.href = url;
        link.download = `卡号生成结果_${exportResults.length}条${suffix}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        showToast('下载文件生成失败，请关闭其他占用内存的页面后重试');
    } finally {
        ui.downloadBtn.disabled = false;
        updateResultActions();
    }
});

window.addEventListener('beforeunload', () => {
    if (worker) worker.terminate();
});

updateLengthWarning();
updatePaginationUI();
updateResultActions();
