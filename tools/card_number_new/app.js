/* 银行卡号生成工具：主线程负责交互，Worker 负责计数和结果生成。 */

let results = [];
let currentPattern = '';
let uniqueLetters = [];
let currentPage = 1;
let worker = null;
let toastTimeout = null;
let isRunning = false;
let expectedCount = null;
let downloadMode = 'complete';

const pageSize = 200;
const MAX_PATTERN_LENGTH = 100;
// 固定保留上限只控制内存与导出规模，不影响符合规则总数的精确统计。
const MAX_RETAINED_RESULTS = 1000000;

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

function formatIntegerString(value) {
    if (value === null || value === undefined) return '—';
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 2200);
}

function setStatus(message, type = 'success') {
    const styles = {
        success: ['#059669', '#D1FAE5', '#A7F3D0'],
        warning: ['#B45309', '#FEF3C7', '#FDE68A'],
        error: ['#B91C1C', '#FEE2E2', '#FECACA']
    };
    const [color, background, borderColor] = styles[type] || styles.success;
    ui.statusBar.style.display = 'block';
    ui.statusBar.style.color = color;
    ui.statusBar.style.background = background;
    ui.statusBar.style.borderColor = borderColor;
    ui.statusBar.textContent = message;
}

function updateLengthWarning() {
    const length = ui.input.value.replace(/\s/g, '').length;
    ui.validCount.textContent = length;

    if (length > 0 && length < 12) {
        ui.lenWarning.textContent = '💡 少于常见的 12–19 位';
        ui.lenWarning.style.display = 'inline';
    } else if (length > 19) {
        ui.lenWarning.textContent = '💡 超出常见的 12–19 位';
        ui.lenWarning.style.display = 'inline';
    } else {
        ui.lenWarning.textContent = '';
        ui.lenWarning.style.display = 'none';
    }
}

function updateResultActions() {
    const hasResults = results.length > 0;
    ui.copyPageBtn.style.display = hasResults ? 'block' : 'none';
    ui.downloadBtn.style.display = hasResults && !isRunning ? 'block' : 'none';

    if (downloadMode === 'partial') {
        ui.downloadBtn.textContent = '下载当前结果（部分）';
    } else if (downloadMode === 'retained') {
        ui.downloadBtn.textContent = '下载当前显示结果(.csv)';
    } else {
        ui.downloadBtn.textContent = '下载结果(.csv)';
    }
}

function setRunning(running) {
    isRunning = running;
    ui.calcBtn.style.display = running ? 'none' : 'block';
    ui.stopBtn.style.display = running ? 'block' : 'none';
    ui.input.disabled = running;
    ui.clearBtn.disabled = running;
    ui.toggleAdvBtn.disabled = running;
    ui.advPanel.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.disabled = running; });
    updateResultActions();
}

ui.excludeOdd.addEventListener('change', function() {
    if (this.checked) ui.excludeEven.checked = false;
});

ui.excludeEven.addEventListener('change', function() {
    if (this.checked) ui.excludeOdd.checked = false;
});

ui.toggleAdvBtn.addEventListener('click', () => {
    const icon = ui.toggleAdvBtn.querySelector('.toggle-icon');
    const expanded = ui.advPanel.style.display !== 'flex';
    ui.advPanel.style.display = expanded ? 'flex' : 'none';
    icon.classList.toggle('rotate', expanded);
    ui.toggleAdvLabel.textContent = expanded ? '收起高级筛选选项' : '展开高级筛选选项';
    ui.toggleAdvBtn.setAttribute('aria-expanded', String(expanded));
});

// Worker 先用 10 个余数状态计算精确总数，再剪掉不可能通过 Luhn 校验的分支。
function calculationWorker() {
    // 较大的消息块能减少百万级结果下的线程通信，同时保留渐进显示能力。
    const RESULT_CHUNK_SIZE = 2000;
    const luhnTable = [
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]
    ];

    function compile(pattern, validDigits) {
        const variableIndex = new Map();
        const tokens = [];
        const contributions = [];
        let fixedContribution = 0;

        for (let position = 0; position < pattern.length; position++) {
            const char = pattern[position];
            const parity = (pattern.length - 1 - position) & 1;

            if (char >= '0' && char <= '9') {
                const digit = char.charCodeAt(0) - 48;
                fixedContribution = (fixedContribution + luhnTable[parity][digit]) % 10;
                tokens.push({ digit: char });
                continue;
            }

            // 每个 * 独立取值；相同字母（忽略大小写）共享一个取值。
            const key = char === '*' ? `star:${position}` : `letter:${char.toLowerCase()}`;
            let index = variableIndex.get(key);
            if (index === undefined) {
                index = contributions.length;
                variableIndex.set(key, index);
                contributions.push(new Array(10).fill(0));
            }

            for (let digit = 0; digit <= 9; digit++) {
                contributions[index][digit] = (contributions[index][digit] + luhnTable[parity][digit]) % 10;
            }
            tokens.push({ variable: index });
        }

        // BigInt 保证最多 100 位规则产生的巨大组合数仍能精确统计。
        const suffixCounts = Array.from({ length: contributions.length + 1 }, () => new Array(10).fill(0n));
        suffixCounts[contributions.length][0] = 1n;

        for (let index = contributions.length - 1; index >= 0; index--) {
            for (const digit of validDigits) {
                const ownContribution = contributions[index][digit];
                for (let residue = 0; residue < 10; residue++) {
                    const count = suffixCounts[index + 1][residue];
                    if (count > 0n) {
                        suffixCounts[index][(ownContribution + residue) % 10] += count;
                    }
                }
            }
        }

        return { tokens, contributions, suffixCounts, fixedContribution };
    }

    function materialize(tokens, assignment) {
        const output = new Array(tokens.length);
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            output[index] = token.digit === undefined ? assignment[token.variable] : token.digit;
        }
        return output.join('');
    }

    self.onmessage = function(event) {
        if (event.data.type !== 'start') return;

        try {
            const { input, validDigits, limit } = event.data;
            const compiled = compile(input, validDigits);
            const variableCount = compiled.contributions.length;
            const requiredResidue = (10 - compiled.fixedContribution) % 10;
            const exactCount = compiled.suffixCounts[0][requiredResidue];
            const assignment = new Array(variableCount);
            let chunk = [];
            let retainedCount = 0;

            postMessage({ type: 'meta', expectedCount: exactCount.toString() });

            function flush() {
                if (chunk.length === 0) return;
                postMessage({ type: 'chunk', data: chunk, count: retainedCount });
                chunk = [];
            }

            function generate(index, residue) {
                if (retainedCount >= limit) return;

                if (index === variableCount) {
                    if ((compiled.fixedContribution + residue) % 10 === 0) {
                        chunk.push(materialize(compiled.tokens, assignment));
                        retainedCount++;
                        if (chunk.length >= RESULT_CHUNK_SIZE) flush();
                    }
                    return;
                }

                for (const digit of validDigits) {
                    if (retainedCount >= limit) break;
                    const nextResidue = (residue + compiled.contributions[index][digit]) % 10;
                    const suffixNeeded = (10 - ((compiled.fixedContribution + nextResidue) % 10)) % 10;
                    if (compiled.suffixCounts[index + 1][suffixNeeded] === 0n) continue;
                    assignment[index] = digit;
                    generate(index + 1, nextResidue);
                }
            }

            generate(0, 0);
            flush();
            postMessage({
                type: 'done',
                count: retainedCount,
                truncated: exactCount > BigInt(retainedCount)
            });
        } catch (error) {
            postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
        }
    };
}

const workerBlob = new Blob([`(${calculationWorker.toString()})()`], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(workerBlob);

function failCalculation(message) {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    setRunning(false);
    downloadMode = results.length > 0 ? 'partial' : 'complete';
    updateResultActions();
    setStatus(`⚠️ 计算失败：${message}`, 'error');
    if (results.length === 0) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>计算线程发生错误，请重试；如果规则包含大量可变位，可增加固定数字后再计算。</div>";
    }
}

function initWorker() {
    if (worker) worker.terminate();

    const instance = new Worker(workerUrl);
    worker = instance;

    instance.onmessage = function(event) {
        if (worker !== instance) return;
        const data = event.data;

        if (data.type === 'meta') {
            expectedCount = data.expectedCount;
            ui.expectedCount.textContent = formatIntegerString(expectedCount);
            setStatus(`● 共 ${formatIntegerString(expectedCount)} 条符合规则，正在生成...`, 'warning');
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
                ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>未找到符合规则的卡号（请检查输入的卡号规则或放宽排除条件）</div>";
                setStatus('✓ 计算完成，没有符合规则的结果', 'success');
            } else if (data.truncated) {
                setStatus(`为保持页面流畅，当前显示前 ${formatIntegerString(results.length)} 条。`, 'warning');
                renderPage();
            } else {
                setStatus(`✓ 计算完成，共 ${formatIntegerString(results.length)} 条`, 'success');
                renderPage();
            }
            updatePaginationUI();
            updateResultActions();
        }
    };

    instance.onerror = function(event) {
        if (worker !== instance) return;
        event.preventDefault();
        failCalculation(event.message || '后台计算线程无法运行');
    };

    instance.onmessageerror = function() {
        if (worker !== instance) return;
        failCalculation('后台计算结果无法读取');
    };
}

function hasDifferentDigits(value) {
    for (let index = 1; index < value.length; index++) {
        if (value[index] !== value[0]) return true;
    }
    return false;
}

function isPalindrome(value) {
    for (let left = 0, right = value.length - 1; left < right; left++, right--) {
        if (value[left] !== value[right]) return false;
    }
    return true;
}

// 靓号特征只分析号码末尾；优先保留更长、更具体的特征，避免重复打标。
function analyzeCardFeatures(cardNumber) {
    const features = [];
    const length = cardNumber.length;

    let repeatLength = 1;
    while (repeatLength < length && cardNumber[length - 1 - repeatLength] === cardNumber[length - 1]) {
        repeatLength++;
    }
    if (repeatLength >= 4) {
        features.push({ type: 'repeat', label: `${repeatLength}连`, title: `末尾 ${repeatLength} 位数字相同` });
    }

    if (length >= 4) {
        const direction = cardNumber.charCodeAt(length - 1) - cardNumber.charCodeAt(length - 2);
        if (direction === 1 || direction === -1) {
            let sequenceLength = 2;
            while (
                sequenceLength < length &&
                cardNumber.charCodeAt(length - sequenceLength) - cardNumber.charCodeAt(length - sequenceLength - 1) === direction
            ) {
                sequenceLength++;
            }
            if (sequenceLength >= 4) {
                const ascending = direction === 1;
                features.push({
                    type: ascending ? 'sequence-up' : 'sequence-down',
                    label: `${sequenceLength}${ascending ? '顺' : '倒顺'}`,
                    title: `末尾 ${sequenceLength} 位数字${ascending ? '连续递增' : '连续递减'}`
                });
            }
        }
    }

    let palindromeLength = 0;
    for (let size = Math.min(8, length); size >= 4; size--) {
        const tail = cardNumber.slice(-size);
        if (hasDifferentDigits(tail) && isPalindrome(tail)) {
            palindromeLength = size;
            features.push({ type: 'palindrome', label: `${size}位回文`, title: `末尾 ${size} 位正读与反读相同` });
            break;
        }
    }

    let cycleType = '';
    if (length >= 8) {
        const tail8 = cardNumber.slice(-8);
        if (tail8.slice(0, 4) === tail8.slice(4) && hasDifferentDigits(tail8.slice(0, 4))) {
            cycleType = 'ABCDABCD';
        }
    }
    if (!cycleType && length >= 6) {
        const tail6 = cardNumber.slice(-6);
        if (tail6.slice(0, 3) === tail6.slice(3) && hasDifferentDigits(tail6.slice(0, 3))) {
            cycleType = 'ABCABC';
        }
    }
    if (cycleType) {
        features.push({ type: 'cycle', label: cycleType, title: '末尾数字按相同组合循环' });
    }

    if (!palindromeLength && !cycleType && length >= 4) {
        const tail4 = cardNumber.slice(-4);
        const [a, b, c, d] = tail4;
        if (a === b && c === d && a !== c) {
            features.push({ type: 'aabb', label: 'AABB', title: '末尾为两组不同的重复数字' });
        } else if (a === c && b === d && a !== b) {
            features.push({ type: 'abab', label: 'ABAB', title: '末尾为两组交替数字' });
        }
    }

    return features;
}

function renderFeatureTags(features) {
    return features.map((feature) => (
        `<span class="tag tag-${feature.type}" title="${feature.title}">${feature.label}</span>`
    )).join('');
}

function getFeatureLabels(features) {
    return features.map((feature) => feature.label);
}

function generateLegend(pattern) {
    uniqueLetters = [];

    for (const char of pattern.toLowerCase()) {
        if (/[a-z]/.test(char) && !uniqueLetters.includes(char)) {
            uniqueLetters.push(char);
        }
    }

    let html = pattern.includes('*') ? '<div class="legend-item"><span class="hl-star">*</span>：任意数字位</div>' : '';
    if (uniqueLetters.length > 0) {
        html += '<div class="legend-item"><span class="hl-letter">字母位</span>：相同字母代表相同数字位</div>';
    }

    ui.legendBox.innerHTML = html;
    ui.legendBox.style.display = html ? 'flex' : 'none';
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

    return `<div class="result-row" role="button" tabindex="0" data-clipboard="${formatted}" title="点击复制号码" aria-label="复制号码 ${formatted}">${html}</div>`;
}

function renderPage() {
    if (!currentPattern || results.length === 0) return;
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    ui.resultContent.innerHTML = currentData.map((result) => formatWithHighlight(result, currentPattern)).join('');
    // 清除隐藏状态，让 CSS 按桌面或窄屏规则选择 flex / grid 布局。
    ui.pagination.style.removeProperty('display');
    updateResultActions();
}

function resetCalculationOutput() {
    results = [];
    currentPage = 1;
    expectedCount = null;
    downloadMode = 'complete';
    ui.count.textContent = '0';
    ui.expectedCount.textContent = '—';
    ui.pagination.style.display = 'none';
    ui.legendBox.style.display = 'none';
    ui.legendBox.innerHTML = '';
    updatePaginationUI();
    updateResultActions();
}

function startCalculation() {
    if (isRunning) return;
    ui.input.classList.remove('input-error');
    ui.input.setAttribute('aria-invalid', 'false');
    const sanitizedInput = sanitizeInput(ui.input.value);
    if (sanitizedInput !== ui.input.value) ui.input.value = sanitizedInput;
    updateLengthWarning();
    currentPattern = sanitizedInput.replace(/[^a-zA-Z0-9*]/g, '');
    resetCalculationOutput();

    if (currentPattern.length === 0) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 请先输入包含数字、字母或 * 号的卡号规则。</div>";
        ui.input.classList.add('input-error');
        ui.input.setAttribute('aria-invalid', 'true');
        setStatus('⚠️ 请输入有效的卡号规则', 'error');
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
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 排除条件过滤掉了全部数字，无法填写 * 或字母位。</div>";
        setStatus('⚠️ 排除条件存在冲突', 'error');
        return;
    }

    ui.expectedCount.textContent = '计算中';
    ui.resultContent.innerHTML = '';
    ui.pagination.style.display = 'none';
    generateLegend(currentPattern);
    setRunning(true);
    setStatus('● 正在分析规则...', 'warning');

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
    setStatus(`⏸ 已手动停止，当前保留 ${formatIntegerString(results.length)} 条`, 'warning');
    if (results.length === 0) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder'>已停止计算，暂未生成结果。</div>";
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
    ui.statusBar.style.display = 'none';
    ui.legendBox.style.display = 'none';
    ui.legendBox.innerHTML = '';
    ui.resultContent.innerHTML = "<div class='empty-placeholder'>等待输入卡号规则：支持数字、英文字母和 *。相同字母代表相同数字，每个 * 独立代表任意数字。空格不计入位数。</div>";
    ui.pagination.style.display = 'none';
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
    showToast(copied ? `✅ 复制成功：${text}` : '⚠️ 复制失败，请手动选择号码');
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
    showToast(copied ? `✅ 成功复制本页 ${currentData.length} 条数据` : '⚠️ 复制失败，请重试');
});

function sanitizeInput(value) {
    const filtered = value.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');
    let output = '';
    let symbolCount = 0;

    for (const char of filtered) {
        if (char === ' ') {
            if (output && !output.endsWith(' ') && symbolCount < MAX_PATTERN_LENGTH) output += char;
        } else if (symbolCount < MAX_PATTERN_LENGTH) {
            output += char;
            symbolCount++;
        }
    }
    return output;
}

ui.input.addEventListener('input', () => {
    ui.input.classList.remove('input-error');
    ui.input.setAttribute('aria-invalid', 'false');
    const exceededLimit = (ui.input.value.match(/[a-zA-Z0-9*]/g) || []).length > MAX_PATTERN_LENGTH;
    const sanitized = sanitizeInput(ui.input.value);
    if (sanitized !== ui.input.value) ui.input.value = sanitized;
    updateLengthWarning();
    if (exceededLimit) showToast(`最多支持 ${MAX_PATTERN_LENGTH} 位，超出部分已忽略`);
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

ui.pageInput.addEventListener('input', function() {
    this.value = this.value.replace(/\D/g, '');
});
ui.pageInput.addEventListener('keydown', function(event) {
    if (event.key === 'Enter') this.blur();
});
ui.pageInput.addEventListener('change', function() {
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
        // 每批文本立即固化为 Blob 分片，避免百万行字符串与最终文件同时常驻 JS 堆。
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
        if (lines.length > 0) {
            parts.push(new Blob([lines.join('')], { type: 'text/plain;charset=utf-8' }));
        }

        const blob = new Blob(parts, { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const suffix = exportMode === 'partial' ? '_部分结果' : exportMode === 'retained' ? '_当前显示结果' : '';
        link.href = url;
        link.download = `卡号生成结果_${exportResults.length}条${suffix}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
        showToast('⚠️ 下载文件生成失败，请关闭其他占用内存的页面后重试');
    } finally {
        ui.downloadBtn.disabled = false;
        updateResultActions();
    }
});

window.addEventListener('beforeunload', () => {
    if (worker) worker.terminate();
    URL.revokeObjectURL(workerUrl);
});

updateLengthWarning();
updatePaginationUI();
