let results = [];
let currentPattern = '';
let uniqueLetters = []; 
let letterColors = {}; 
let currentPage = 1;
const pageSize = 100;
let worker = null;

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
    totalPages: document.getElementById('totalPages'), prevBtn: document.getElementById('prevBtn'),
    nextBtn: document.getElementById('nextBtn'), downloadBtn: document.getElementById('downloadBtn'),
    legendBox: document.getElementById('dynamic-legend'), toggleAdvBtn: document.getElementById('toggleAdvBtn'),
    advPanel: document.getElementById('advPanel'), 
    excludeOdd: document.getElementById('excludeOdd'), excludeEven: document.getElementById('excludeEven'),
    numberCheckboxes: document.getElementById('numberCheckboxes')
};

ui.excludeOdd.addEventListener('change', function() {
    if (this.checked) ui.excludeEven.checked = false;
});
ui.excludeEven.addEventListener('change', function() {
    if (this.checked) ui.excludeOdd.checked = false;
});

ui.toggleAdvBtn.addEventListener('click', () => {
    if (ui.advPanel.style.display === 'flex') {
        ui.advPanel.style.display = 'none';
        ui.toggleAdvBtn.innerHTML = '⚙️ 展开高级筛选选项 ▼';
    } else {
        ui.advPanel.style.display = 'flex';
        ui.toggleAdvBtn.innerHTML = '⚙️ 收起高级筛选选项 ▲';
    }
});

const workerCode = `
    let isCancelled = false; 
    let chunk = []; 
    let totalFound = 0; 
    let letterMap = {};
    let validDigits = []; 
    let globalPattern = ''; 
    
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
        if (isCancelled || totalFound >= 1000000) return;
        
        if (index === globalPattern.length) {
            if (luhnCheckFast(combination)) {
                chunk.push(combination); 
                totalFound++;
                if (chunk.length >= 300) { 
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
            
            validDigits = [];
            let filters = e.data.filters;
            for (let i = 0; i < 10; i++) {
                if (filters.exclude.includes(i.toString())) continue;
                if (filters.excludeOdd && i % 2 !== 0) continue;
                if (filters.excludeEven && i % 2 === 0) continue;
                validDigits.push(i);
            }

            generate(0, '');
            postMessage({ type: 'done', data: chunk, count: totalFound });
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
            results.push(...e.data.data);
            ui.count.textContent = e.data.count.toLocaleString();
            if (e.data.type === 'done') {
                ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
                ui.statusBar.style.display = 'block'; 
                ui.statusBar.textContent = '✓ 计算完成';
                ui.statusBar.style.color = '#059669';
                ui.statusBar.style.background = '#D1FAE5';
                ui.statusBar.style.borderColor = '#A7F3D0';
                if (results.length === 0) {
                     ui.resultContent.innerHTML = "<span style='color: #DC2626;'>未找到符合规则的号码，可能是筛选条件过于苛刻。</span>";
                }
            }
            if (results.length > 0) renderPage(); 
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
    ui.validCount.textContent = '0'; ui.count.textContent = '0';
    results = []; currentPattern = '';
    
    ui.statusBar.style.display = 'none'; ui.legendBox.innerHTML = '';
    ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
    ui.resultContent.innerHTML = "等待输入卡号规则...";
    ui.pagination.style.display = 'none'; ui.downloadBtn.style.display = 'none';
    
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    ui.excludeOdd.checked = false; ui.excludeEven.checked = false;
    ui.input.focus();
});

function getTags(str) {
    let tags = [];
    const repeatMatch = str.match(/(\d)\1{3,}/g); 
    if (repeatMatch) {
        let maxRepeat = Math.max(...repeatMatch.map(m => m.length));
        if (maxRepeat >= 4) { tags.push(`<span class="tag tag-repeat">${maxRepeat}连</span>`); }
    }

    let maxAsc = 1, currentAsc = 1; let maxDesc = 1, currentDesc = 1;
    for(let i = 1; i < str.length; i++) {
        let diff = str.charCodeAt(i) - str.charCodeAt(i-1);
        if (diff === 1) { currentAsc++; maxAsc = Math.max(maxAsc, currentAsc); currentDesc = 1; } 
        else if (diff === -1) { currentDesc++; maxDesc = Math.max(maxDesc, currentDesc); currentAsc = 1; } 
        else { currentAsc = 1; currentDesc = 1; }
    }
    let maxSeq = Math.max(maxAsc, maxDesc);
    if (maxSeq >= 4) { tags.push(`<span class="tag tag-straight">${maxSeq}顺</span>`); }

    let tail4 = str.slice(-4);
    if (/(\d)\1(\d)\2/.test(tail4) && tail4[0] !== tail4[2]) tags.push('<span class="tag tag-pattern">AABB</span>');
    else if (/(\d)(\d)\1\2/.test(tail4) && tail4[0] !== tail4[1]) tags.push('<span class="tag tag-pattern">ABAB</span>');

    return tags.join(' ');
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
    ui.legendBox.innerHTML = html;
}

function formatWithHighlight(cardNumber, pattern) {
    let html = '';
    for (let i = 0; i < cardNumber.length; i++) {
        if (i > 0 && i % 4 === 0) html += ' '; 
        let pChar = pattern[i]; let cChar = cardNumber[i];
        if (pChar === '*') { html += `<span class="hl-star">${cChar}</span>`; } 
        else if (/[a-zA-Z]/.test(pChar)) {
            let colorStyle = letterColors[pChar.toLowerCase()];
            html += `<span style="color: ${colorStyle.text}; background: ${colorStyle.bg}; padding: 0 2px; border-radius: 3px; font-weight: 800;">${cChar}</span>`;
        } else { html += `<span class="hl-normal">${cChar}</span>`; }
    }
    return html + getTags(cardNumber.replace(/\s/g, ''));
}

function renderPage() {
    if (currentPattern === '') return;
    if (results.length === 0) return; 
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    ui.resultContent.innerHTML = currentData.map(res => formatWithHighlight(res, currentPattern)).join('\n');
    ui.pagination.style.display = 'flex'; ui.downloadBtn.style.display = 'block';
}

function updatePaginationUI() {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    ui.totalPages.textContent = total.toLocaleString();
    if (document.activeElement !== ui.pageInput) ui.pageInput.value = currentPage;
    ui.pageInput.max = total;
    ui.prevBtn.disabled = currentPage <= 1; ui.nextBtn.disabled = currentPage >= total;
}

function startCalculation() {
    ui.input.classList.remove('input-error'); 
    let inputStr = ui.input.value;
    currentPattern = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
    
    if (currentPattern.length === 0) {
        ui.resultContent.innerHTML = "<span style='color: var(--error-red); font-weight: bold;'>⚠️ 请先输入包含数字、字母或 * 号的有效卡号规则！</span>";
        ui.input.classList.add('input-error');
        ui.input.focus();
        return;
    }

    let excludes = [];
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => { excludes.push(cb.value); });
    
    let hasVariables = /[a-zA-Z*]/.test(currentPattern);
    if (excludes.length === 10 && hasVariables) {
        ui.resultContent.innerHTML = "<span style='color: var(--error-red); font-weight: bold;'>⚠️ 逻辑冲突：您排除了 0-9 所有数字，导致未知位无法推演。</span>";
        return;
    }

    let filters = { exclude: excludes, excludeOdd: ui.excludeOdd.checked, excludeEven: ui.excludeEven.checked };

    initWorker();
    results = []; currentPage = 1; generateLegend(currentPattern);
    
    ui.resultContent.innerHTML = "";
    ui.calcBtn.style.display = 'none'; ui.stopBtn.style.display = 'block';
    ui.count.textContent = "0"; ui.pagination.style.display = 'none'; ui.downloadBtn.style.display = 'none';
    ui.statusBar.style.display = 'block'; 
    ui.statusBar.style.color = '#B45309'; ui.statusBar.style.background = '#FEF3C7'; ui.statusBar.style.borderColor = '#FDE68A';
    ui.statusBar.textContent = '● 算法正在计算中...';

    worker.postMessage({ type: 'start', input: currentPattern, filters: filters });
}

ui.input.addEventListener('input', () => {
    ui.input.classList.remove('input-error');
    let filtered = ui.input.value.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');
    ui.input.value = filtered; ui.validCount.textContent = filtered.replace(/\s/g, '').length;
});

ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCalculation(); });
ui.calcBtn.addEventListener('click', startCalculation);

ui.prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderPage(); updatePaginationUI(); } });
ui.nextBtn.addEventListener('click', () => { if (currentPage < Math.ceil(results.length / pageSize)) { currentPage++; renderPage(); updatePaginationUI(); } });

ui.pageInput.addEventListener('keydown', (e) => {
    if (['.', '-', '+', 'e'].includes(e.key)) e.preventDefault();
});

ui.pageInput.addEventListener('change', () => {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    let val = parseInt(ui.pageInput.value);
    if (isNaN(val) || val <= 0) currentPage = 1;
    else if (val > total) currentPage = total;
    else currentPage = val;
    renderPage(); updatePaginationUI();
});
document.getElementById('firstBtn').addEventListener('click', () => { currentPage = 1; renderPage(); updatePaginationUI(); });
document.getElementById('lastBtn').addEventListener('click', () => { currentPage = Math.ceil(results.length / pageSize); renderPage(); updatePaginationUI(); });

ui.downloadBtn.addEventListener('click', () => {
    if (results.length === 0) return;
    const content = results.map(res => {
        let formatted = res.replace(/\d{4}(?=\d)/g, '$& ');
        let tagsStr = getTags(res).replace(/<[^>]+>/g, ''); 
        return tagsStr ? `${formatted}  [${tagsStr.trim().replace(/\s+/g, ', ')}]` : formatted;
    }).join('\n');
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `卡号生成结果_${results.length}条.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
});