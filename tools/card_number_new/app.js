let results = [];
let currentPattern = '';
let uniqueLetters = []; 
let letterColors = {}; 
let currentPage = 1;

// ==== 优化：单页容量调整至体验极佳的 200 条 ====
const pageSize = 200; 
const MAX_SAFE_LIMIT = 5000000; 
let worker = null;
let toastTimeout = null;

const COLOR_PALETTE = [
    { text: '#2563EB', bg: 'rgba(37, 99, 235, 0.12)' }, 
    { text: '#DC2626', bg: 'rgba(220, 38, 38, 0.12)' }, 
    { text: '#059669', bg: 'rgba(5, 150, 105, 0.12)' }, 
    { text: '#7C3AED', bg: 'rgba(124, 58, 237, 0.12)' }, 
    { text: '#EA580C', bg: 'rgba(234, 88, 12, 0.12)' }, 
    { text: '#DB2777', bg: 'rgba(219, 39, 119, 0.12)' }, 
    { text: '#0891B2', bg: 'rgba(8, 145, 178, 0.12)' }, 
    { text: '#4F46E5', bg: 'rgba(79, 70, 229, 0.12)' }, 
    { text: '#65A30D', bg: 'rgba(101, 163, 13, 0.12)' }, 
    { text: '#B91C1C', bg: 'rgba(185, 28, 28, 0.12)' }  
];

function getLetterStyle(index) { return COLOR_PALETTE[index % COLOR_PALETTE.length]; }

const ui = {
    input: document.getElementById('inputField'), calcBtn: document.getElementById('calcBtn'),
    stopBtn: document.getElementById('stopBtn'), clearBtn: document.getElementById('clearBtn'),
    count: document.getElementById('count'), validCount: document.getElementById('validCount'),
    resultContent: document.getElementById('result-container'), statusBar: document.getElementById('status-bar'),
    pagination: document.getElementById('pagination'), pageInput: document.getElementById('pageInput'),
    totalPages: document.getElementById('totalPages'), 
    firstPageBtn: document.getElementById('firstPageBtn'), lastPageBtn: document.getElementById('lastPageBtn'),
    prevBtn: document.getElementById('prevBtn'), nextBtn: document.getElementById('nextBtn'), 
    downloadBtn: document.getElementById('downloadBtn'), copyPageBtn: document.getElementById('copyPageBtn'),
    legendBox: document.getElementById('dynamic-legend'), toggleAdvBtn: document.getElementById('toggleAdvBtn'), 
    advPanel: document.getElementById('advPanel'), excludeOdd: document.getElementById('excludeOdd'), 
    excludeEven: document.getElementById('excludeEven'), numberCheckboxes: document.getElementById('numberCheckboxes'),
    toast: document.getElementById('toast')
};

function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => {
        ui.toast.classList.remove('show');
    }, 2000);
}

ui.excludeOdd.addEventListener('change', function() {
    if (this.checked) ui.excludeEven.checked = false;
});
ui.excludeEven.addEventListener('change', function() {
    if (this.checked) ui.excludeOdd.checked = false;
});

ui.toggleAdvBtn.addEventListener('click', () => {
    const icon = ui.toggleAdvBtn.querySelector('.toggle-icon');
    if (ui.advPanel.style.display === 'flex') {
        ui.advPanel.style.display = 'none';
        icon.classList.remove('rotate');
    } else {
        ui.advPanel.style.display = 'flex';
        icon.classList.add('rotate');
    }
});

const workerCode = `
    let isCancelled = false; 
    let chunk = []; 
    let totalFound = 0; 
    let letterMap = {};
    let validDigits = []; 
    let globalPattern = ''; 
    let maxLimit = 5000000;
    
    const luhnArr = [ 
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 
        [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]  
    ];

    function luhnCheckFast(str) {
        let sum = 0;
        let len = str.length;
        for (let i = len - 1; i >= 0; i--) { 
            sum += luhnArr[(len - 1 - i) & 1][str.charCodeAt(i) - 48]; 
        }
        return sum % 10 === 0;
    }

    function generate(index, combination) {
        if (isCancelled || totalFound >= maxLimit) return;
        
        if (index === globalPattern.length) {
            if (luhnCheckFast(combination)) {
                chunk.push(combination); 
                totalFound++;
                if (chunk.length >= 500) { 
                    postMessage({ type: 'chunk', data: chunk, count: totalFound }); 
                    chunk = []; 
                }
            }
            return;
        }

        let char = globalPattern[index];

        if (char >= '0' && char <= '9') { 
            generate(index + 1, combination + char); 
        } 
        else if (char.match(/[a-zA-Z]/)) {
            let f = char.toLowerCase();
            if (letterMap[f] === undefined) {
                for (let i = 0; i < validDigits.length; i++) {
                    let d = validDigits[i];
                    letterMap[f] = d; 
                    generate(index + 1, combination + d);
                }
                letterMap[f] = undefined; 
            } else { 
                generate(index + 1, combination + letterMap[f]); 
            }
        } 
        else if (char === '*') {
            for (let i = 0; i < validDigits.length; i++) {
                generate(index + 1, combination + validDigits[i]);
            }
        }
    }

    self.onmessage = function(e) {
        if (e.data.type === 'start') {
            isCancelled = false; chunk = []; totalFound = 0; letterMap = {};
            globalPattern = e.data.input;
            maxLimit = e.data.limit;
            
            validDigits = e.data.validDigits;

            generate(0, '');
            postMessage({ type: 'done', data: chunk, count: totalFound, hitLimit: totalFound >= maxLimit });
        } else if (e.data.type === 'stop') { 
            isCancelled = true; 
        }
    };
`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(blob);

function initWorker() {
    if (worker) worker.terminate();
    worker = new Worker(workerUrl);
    worker.onmessage = function(e) {
        if (e.data.type === 'chunk' || e.data.type === 'done') {
            let oldLen = results.length;
            results.push(...e.data.data);
            ui.count.textContent = e.data.count.toLocaleString();
            
            if (e.data.type === 'done') {
                ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
                ui.statusBar.style.display = 'block'; 
                
                if (e.data.hitLimit) {
                    ui.statusBar.textContent = '⚠️ 触发 500 万条防崩溃熔断';
                    ui.statusBar.style.color = '#B45309';
                    ui.statusBar.style.background = '#FEF3C7';
                    ui.statusBar.style.borderColor = '#FDE68A';
                } else {
                    ui.statusBar.textContent = '✓ 计算完成';
                    ui.statusBar.style.color = '#059669';
                    ui.statusBar.style.background = '#D1FAE5';
                    ui.statusBar.style.borderColor = '#A7F3D0';
                }

                if (results.length === 0) {
                     ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>未找到符合规则的号码，可能是筛选条件过于苛刻。</div>";
                }
            }
            
            if (oldLen < currentPage * pageSize || e.data.type === 'done') {
                if (results.length > 0) renderPage(); 
            }
            updatePaginationUI();
        }
    };
}

ui.stopBtn.addEventListener('click', () => {
    if (worker) {
        worker.terminate(); worker = null;
        ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
        ui.statusBar.style.display = 'block'; ui.statusBar.textContent = '⏸️ 已手动停止计算';
        ui.statusBar.style.color = '#B45309'; ui.statusBar.style.background = '#FEF3C7'; ui.statusBar.style.borderColor = '#FDE68A';
    }
});

ui.clearBtn.addEventListener('click', () => {
    if (worker) { worker.terminate(); worker = null; }
    
    ui.input.value = ''; ui.input.classList.remove('input-error');
    ui.validCount.textContent = '0';
    document.getElementById('lenWarning').style.display = 'none';
    ui.count.textContent = '0';
    results = []; currentPattern = '';
    
    ui.statusBar.style.display = 'none'; 
    ui.legendBox.style.display = 'none'; ui.legendBox.innerHTML = '';
    ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
    ui.resultContent.innerHTML = "<div class='empty-placeholder'>💳 等待输入卡号规则...</div>";
    ui.pagination.style.display = 'none'; 
    ui.downloadBtn.style.display = 'none';
    ui.copyPageBtn.style.display = 'none'; 
    
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    ui.excludeOdd.checked = false; ui.excludeEven.checked = false;
    ui.input.focus();
});

function parseTags(str, asHtml = true) {
    let tags = [];
    const repeatMatch = str.match(/(\d)\1{3,}$/); 
    if (repeatMatch) {
        let text = `${repeatMatch[0].length}连`;
        tags.push(asHtml ? `<span class="tag tag-repeat">👑 ${text}</span>` : `👑${text}`);
    }

    let tailAsc = 1;
    for(let i = str.length - 1; i > 0; i--) {
        if (str.charCodeAt(i) - str.charCodeAt(i-1) === 1) tailAsc++;
        else break;
    }
    let tailDesc = 1;
    for(let i = str.length - 1; i > 0; i--) {
        if (str.charCodeAt(i) - str.charCodeAt(i-1) === -1) tailDesc++;
        else break;
    }
    let maxSeq = Math.max(tailAsc, tailDesc);
    if (maxSeq >= 4) { 
        tags.push(asHtml ? `<span class="tag tag-straight">🚀 ${maxSeq}顺</span>` : `🚀${maxSeq}顺`); 
    }

    let tail4 = str.slice(-4);
    if (/(\d)\1(\d)\2/.test(tail4) && tail4[0] !== tail4[2]) {
        tags.push(asHtml ? '<span class="tag tag-pattern">✨ AABB</span>' : '✨AABB');
    } else if (/(\d)(\d)\1\2/.test(tail4) && tail4[0] !== tail4[1]) {
        tags.push(asHtml ? '<span class="tag tag-pattern">💫 ABAB</span>' : '💫ABAB');
    }

    return asHtml ? tags.join('') : tags;
}

function generateLegend(pattern) {
    uniqueLetters = []; letterColors = {};
    let chars = pattern.toLowerCase().split('');
    for (let c of chars) { 
        if (/[a-z]/.test(c) && !uniqueLetters.includes(c)) {
            uniqueLetters.push(c); 
            letterColors[c] = getLetterStyle(uniqueLetters.length - 1); 
        }
    }
    
    let html = pattern.includes('*') ? `<div class="legend-item"><span class="hl-star">*</span> : 任意数字位</div>` : '';
    uniqueLetters.forEach((letter) => {
        let colorStyle = letterColors[letter];
        html += `<div class="legend-item" style="--color-star: ${colorStyle.text}">
                    <span style="color: ${colorStyle.text}; background: ${colorStyle.bg}; padding: 0 4px; border-radius: 4px; font-weight: 700;">${letter}</span> : 相同数字位
                 </div>`;
    });
    
    if (html) {
        ui.legendBox.style.display = 'flex';
        ui.legendBox.innerHTML = html;
    } else {
        ui.legendBox.style.display = 'none';
    }
}

function formatWithHighlight(cardNumber, pattern) {
    let html = '<div class="number-part">';
    let rawFormatted = cardNumber.replace(/\d{4}(?=\d)/g, '$& ');
    
    for (let i = 0; i < cardNumber.length; i++) {
        if (i > 0 && i % 4 === 0) html += ' '; 
        let pChar = pattern[i]; let cChar = cardNumber[i];
        if (pChar === '*') { html += `<span class="hl-star">${cChar}</span>`; } 
        else if (/[a-zA-Z]/.test(pChar)) {
            let colorStyle = letterColors[pChar.toLowerCase()];
            html += `<span style="color: ${colorStyle.text}; background: ${colorStyle.bg}; padding: 0 2px; border-radius: 3px; font-weight: 800;">${cChar}</span>`;
        } else { html += `<span class="hl-normal">${cChar}</span>`; }
    }
    html += '</div>';
    
    let tagsHtml = parseTags(cardNumber.replace(/\s/g, ''), true);
    if(tagsHtml) html += `<div class="tag-part">${tagsHtml}</div>`;
    
    return `<div class="result-row" data-clipboard="${rawFormatted}" title="点击复制号码">${html}</div>`;
}

function renderPage() {
    if (currentPattern === '') return;
    if (results.length === 0) return; 
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    ui.resultContent.innerHTML = currentData.map(res => formatWithHighlight(res, currentPattern)).join('');
    ui.pagination.style.display = 'flex'; 
    ui.downloadBtn.style.display = 'block';
    ui.copyPageBtn.style.display = 'block';
}

function updatePaginationUI() {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    ui.totalPages.textContent = total.toLocaleString();
    if (document.activeElement !== ui.pageInput) ui.pageInput.value = currentPage;
    
    let isFirst = currentPage <= 1;
    let isLast = currentPage >= total;
    
    ui.prevBtn.disabled = isFirst;
    ui.firstPageBtn.disabled = isFirst;
    ui.nextBtn.disabled = isLast;
    ui.lastPageBtn.disabled = isLast;
}

function startCalculation() {
    ui.input.classList.remove('input-error'); 
    let inputStr = ui.input.value;
    currentPattern = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
    
    if (currentPattern.length === 0) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 请先输入包含数字、字母或 * 号的有效卡号规则！</div>";
        ui.input.classList.add('input-error');
        ui.input.focus();
        return;
    }

    let excludes = [];
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => { excludes.push(cb.value); });
    
    let hasVariables = /[a-zA-Z*]/.test(currentPattern);
    
    let validDigits = [];
    for (let i = 0; i < 10; i++) {
        if (excludes.includes(i.toString())) continue;
        if (ui.excludeOdd.checked && i % 2 !== 0) continue;
        if (ui.excludeEven.checked && i % 2 === 0) continue;
        validDigits.push(i);
    }

    if (validDigits.length === 0 && hasVariables) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 逻辑冲突：您的排除条件过滤掉了所有的 0-9 数字，无法进行推演。</div>";
        return;
    }

    initWorker();
    results = []; currentPage = 1; generateLegend(currentPattern);
    
    ui.resultContent.innerHTML = "";
    ui.calcBtn.style.display = 'none'; ui.stopBtn.style.display = 'block';
    ui.count.textContent = "0"; ui.pagination.style.display = 'none'; 
    ui.downloadBtn.style.display = 'none'; ui.copyPageBtn.style.display = 'none';
    ui.statusBar.style.display = 'block'; 
    ui.statusBar.style.color = '#B45309'; ui.statusBar.style.background = '#FEF3C7'; ui.statusBar.style.borderColor = '#FDE68A';
    ui.statusBar.textContent = '● 算法正在计算中...';

    worker.postMessage({ type: 'start', input: currentPattern, filters: { exclude: excludes, excludeOdd: ui.excludeOdd.checked, excludeEven: ui.excludeEven.checked }, validDigits: validDigits, limit: MAX_SAFE_LIMIT });
}

ui.resultContent.addEventListener('click', (e) => {
    let row = e.target.closest('.result-row');
    if (!row) return;
    let textToCopy = row.getAttribute('data-clipboard');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showToast('✅ 复制成功: ' + textToCopy);
        });
    } else {
        let textArea = document.createElement("textarea");
        textArea.value = textToCopy;
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus(); textArea.select();
        try { document.execCommand('copy'); showToast('✅ 复制成功: ' + textToCopy); } catch (err) {}
        document.body.removeChild(textArea);
    }
});

ui.copyPageBtn.addEventListener('click', () => {
    if (results.length === 0) return;
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    const content = currentData.map(res => {
        let formatted = res.replace(/\d{4}(?=\d)/g, '$& ');
        let tagsArr = parseTags(res, false); 
        return tagsArr.length > 0 ? `${formatted}  [${tagsArr.join(', ')}]` : formatted;
    }).join('\n');
    
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(content).then(() => showToast(`✅ 成功复制本页 ${currentData.length} 条数据`));
    } else {
        let textArea = document.createElement("textarea");
        textArea.value = content;
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus(); textArea.select();
        try { document.execCommand('copy'); showToast(`✅ 成功复制本页 ${currentData.length} 条数据`); } catch (err) {}
        document.body.removeChild(textArea);
    }
});

ui.input.addEventListener('input', () => {
    ui.input.classList.remove('input-error');
    
    let filtered = ui.input.value.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');
    ui.input.value = filtered; 
    
    let len = filtered.replace(/\s/g, '').length;
    ui.validCount.textContent = len;
    
    const lenWarning = document.getElementById('lenWarning');
    if (len > 19) { lenWarning.style.display = 'inline'; } 
    else { lenWarning.style.display = 'none'; }
});

ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCalculation(); });
ui.calcBtn.addEventListener('click', startCalculation);

ui.pageInput.addEventListener('input', function() { this.value = this.value.replace(/\D/g, ''); });
ui.pageInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });

ui.firstPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage = 1; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
ui.lastPageBtn.addEventListener('click', () => { 
    const total = Math.ceil(results.length / pageSize);
    if (currentPage < total) { currentPage = total; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } 
});
ui.prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
ui.nextBtn.addEventListener('click', () => { if (currentPage < Math.ceil(results.length / pageSize)) { currentPage++; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });

ui.pageInput.addEventListener('change', function() {
    let val = parseInt(this.value);
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    
    if (isNaN(val) || val <= 0) val = 1;
    if (val > total) val = total;
    
    currentPage = val;
    this.value = currentPage; 
    
    renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ==== CSV 核心导出逻辑：注入 \uFEFF 防止 Excel 乱码，分离特征列 ====
ui.downloadBtn.addEventListener('click', () => {
    if (results.length === 0) return;
    
    // CSV 表头（BOM防乱码）
    let csvContent = '\uFEFF银行卡号,特征标签\n';
    
    csvContent += results.map(res => {
        let formatted = res.replace(/\d{4}(?=\d)/g, '$& ');
        let tagsArr = parseTags(res, false); 
        // 多个标签使用 / 分隔，避免逗号破坏 CSV 列结构
        let tagsStr = tagsArr.length > 0 ? tagsArr.join(' / ') : '无';
        return `"${formatted}","${tagsStr}"`; 
    }).join('\n');
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = `卡号推演结果_${results.length}条.csv`;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a); 
    URL.revokeObjectURL(url);
});