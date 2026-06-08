/**
 * 银行卡号生成器 - 核心业务逻辑 (v1.0.0 白话优版)
 * 采用 Web Worker 多线程计算，Luhn 位运算校验，内存防抖指针生成算法。
 */

// ==========================================
// 1. 全局配置与状态池
// ==========================================
let results = [];             // 全局结果数据集
let currentPattern = '';      // 当前正在生成的格式规则
let uniqueLetters = [];       // 当前规则中包含的去重字母
let letterColors = {};        // 为不同字母分配的颜色映射池
let currentPage = 1;          // 当前页码
let worker = null;            // 后台计算线程实例
let toastTimeout = null;      // Toast 计时器，用于防抖覆盖

const pageSize = 200;                 // 最佳分页容量体验阈值
const MAX_SAFE_LIMIT = 5000000;       // 内存保护熔断阈值（500万条）

// 10套高对比度专属色板（超出10个字母自动取模循环使用）
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

function getLetterStyle(index) { 
    return COLOR_PALETTE[index % COLOR_PALETTE.length]; 
}

// ==========================================
// 2. DOM 元素集中绑定
// ==========================================
const ui = {
    input: document.getElementById('inputField'), 
    calcBtn: document.getElementById('calcBtn'),
    stopBtn: document.getElementById('stopBtn'), 
    clearBtn: document.getElementById('clearBtn'),
    count: document.getElementById('resultCount'), 
    validCount: document.getElementById('validCount'),
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
    advPanel: document.getElementById('advPanel'), 
    excludeOdd: document.getElementById('excludeOdd'), 
    excludeEven: document.getElementById('excludeEven'), 
    numberCheckboxes: document.getElementById('numberCheckboxes'),
    toast: document.getElementById('toast')
};

// ==========================================
// 3. 通用交互辅助函数
// ==========================================

function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => ui.toast.classList.remove('show'), 2000);
}

// 奇偶排除的互斥逻辑
ui.excludeOdd.addEventListener('change', function() {
    if (this.checked) ui.excludeEven.checked = false;
});
ui.excludeEven.addEventListener('change', function() {
    if (this.checked) ui.excludeOdd.checked = false;
});

// 高级选项面板的折叠与箭头动画
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

// ==========================================
// 4. 核心计算引擎 (Web Worker 多线程实现)
// ==========================================
const workerCode = `
    let isCancelled = false; 
    let chunk = []; 
    let totalFound = 0; 
    let letterMap = {};
    let validDigits = []; 
    let globalPattern = ''; 
    let maxLimit = 5000000;
    
    // Luhn 算法运算查表法
    const luhnArr = [ 
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], // 奇数位(从右数)无需操作
        [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]  // 偶数位(从右数)乘2减9
    ];

    /**
     * 极速 Luhn 算法校验
     * 采用位运算 (len - 1 - i) & 1 绝对保证无论卡号多长，始终自右向左精确定位奇偶
     */
    function luhnCheckFast(str) {
        let sum = 0;
        let len = str.length;
        for (let i = len - 1; i >= 0; i--) { 
            sum += luhnArr[(len - 1 - i) & 1][str.charCodeAt(i) - 48]; 
        }
        return sum % 10 === 0;
    }

    /**
     * 游标递归生成器
     */
    function generate(index, combination) {
        // 达到熔断极限或手动停止，强制回溯
        if (isCancelled || totalFound >= maxLimit) return;
        
        // 触底校验层
        if (index === globalPattern.length) {
            if (luhnCheckFast(combination)) {
                chunk.push(combination); 
                totalFound++;
                // 满 500 条抛回主线程渲染，防止主线程阻塞
                if (chunk.length >= 500) { 
                    postMessage({ type: 'chunk', data: chunk, count: totalFound }); 
                    chunk = []; 
                }
            }
            return;
        }

        let char = globalPattern[index];

        // 情景 A: 固定已填写的数字位，直接继承
        if (char >= '0' && char <= '9') { 
            generate(index + 1, combination + char); 
        } 
        // 情景 B: 字母等值未知位
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
        // 情景 C: 星号随机未知位
        else if (char === '*') {
            for (let i = 0; i < validDigits.length; i++) {
                generate(index + 1, combination + validDigits[i]);
            }
        }
    }

    // Worker 消息接收中枢
    self.onmessage = function(e) {
        if (e.data.type === 'start') {
            isCancelled = false; chunk = []; totalFound = 0; letterMap = {};
            
            globalPattern = e.data.input;
            maxLimit = e.data.limit;
            validDigits = e.data.validDigits;

            generate(0, '');
            // 计算自然结束，携带极限触达标志位回传
            postMessage({ type: 'done', data: chunk, count: totalFound, hitLimit: totalFound >= maxLimit });
        } else if (e.data.type === 'stop') { 
            isCancelled = true; 
        }
    };
`;
const blob = new Blob([workerCode], { type: 'application/javascript' });
const workerUrl = URL.createObjectURL(blob);

// 初始化与接收 Worker 数据
function initWorker() {
    if (worker) worker.terminate();
    worker = new Worker(workerUrl);
    worker.onmessage = function(e) {
        if (e.data.type === 'chunk' || e.data.type === 'done') {
            let oldLen = results.length;
            results.push(...e.data.data);
            ui.count.textContent = e.data.count.toLocaleString();
            
            // 接收完成指令的视图状态复位
            if (e.data.type === 'done') {
                ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
                ui.statusBar.style.display = 'block'; 
                
                // 根据是否触发了安全熔断来呈现不同报警UI
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

                // 未找到符合规则的号码提示
                if (results.length === 0) {
                     ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 未找到符合规则的号码（请检查输入的数字是否正确，或放宽排除条件）</div>";
                }
            }
            
            // 防闪烁优化：仅当当前展示页未填满数据，或已完成计算时触发DOM刷新
            if (oldLen < currentPage * pageSize || e.data.type === 'done') {
                if (results.length > 0) renderPage(); 
            }
            updatePaginationUI();
        }
    };
}

// ==========================================
// 5. 靓号分析与渲染引擎
// ==========================================

function parseTags(str, asHtml = true) {
    let tags = [];
    
    // N连号 (锚定末尾)
    const repeatMatch = str.match(/(\d)\1{3,}$/); 
    if (repeatMatch) {
        let text = `${repeatMatch[0].length}连`;
        tags.push(asHtml ? `<span class="tag tag-repeat">👑 ${text}</span>` : `👑${text}`);
    }

    // N顺子 (逆向推导升降序，锚定末尾)
    let tailAsc = 1;
    for(let i = str.length - 1; i > 0; i--) {
        if (str.charCodeAt(i) - str.charCodeAt(i-1) === 1) tailAsc++; else break;
    }
    let tailDesc = 1;
    for(let i = str.length - 1; i > 0; i--) {
        if (str.charCodeAt(i) - str.charCodeAt(i-1) === -1) tailDesc++; else break;
    }
    let maxSeq = Math.max(tailAsc, tailDesc);
    if (maxSeq >= 4) { 
        tags.push(asHtml ? `<span class="tag tag-straight">🚀 ${maxSeq}顺</span>` : `🚀${maxSeq}顺`); 
    }

    // 双拼尾阵提取 (取最后4位)
    let tail4 = str.slice(-4);
    if (/(\d)\1(\d)\2/.test(tail4) && tail4[0] !== tail4[2]) {
        tags.push(asHtml ? '<span class="tag tag-pattern">✨ AABB</span>' : '✨AABB');
    } else if (/(\d)(\d)\1\2/.test(tail4) && tail4[0] !== tail4[1]) {
        tags.push(asHtml ? '<span class="tag tag-pattern">💫 ABAB</span>' : '💫ABAB');
    }

    return asHtml ? tags.join('') : tags;
}

// 构建页面顶部的色彩规则图例
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

// 格式化并合并单行数据的 Flex DOM 结构
function formatWithHighlight(cardNumber, pattern) {
    let html = '<div class="number-part">';
    let rawFormatted = cardNumber.replace(/\d{4}(?=\d)/g, '$& ');
    
    // 缝合色彩特征高亮
    for (let i = 0; i < cardNumber.length; i++) {
        if (i > 0 && i % 4 === 0) html += ' '; 
        let pChar = pattern[i]; let cChar = cardNumber[i];
        if (pChar === '*') { 
            html += `<span class="hl-star">${cChar}</span>`; 
        } else if (/[a-zA-Z]/.test(pChar)) {
            let colorStyle = letterColors[pChar.toLowerCase()];
            html += `<span style="color: ${colorStyle.text}; background: ${colorStyle.bg}; padding: 0 2px; border-radius: 3px; font-weight: 800;">${cChar}</span>`;
        } else { 
            html += `<span class="hl-normal">${cChar}</span>`; 
        }
    }
    html += '</div>';
    
    // 注入右侧标签系统
    let tagsHtml = parseTags(cardNumber.replace(/\s/g, ''), true);
    if(tagsHtml) html += `<div class="tag-part">${tagsHtml}</div>`;
    
    // data-clipboard 用于提供无感点击复制的数据源
    return `<div class="result-row" data-clipboard="${rawFormatted}" title="点击复制号码">${html}</div>`;
}

// 主渲染器
function renderPage() {
    if (currentPattern === '') return;
    if (results.length === 0) return; 
    
    const start = (currentPage - 1) * pageSize;
    const currentData = results.slice(start, start + pageSize);
    ui.resultContent.innerHTML = currentData.map(res => formatWithHighlight(res, currentPattern)).join('');
    
    // UI 功能解冻
    ui.pagination.style.display = 'flex'; 
    ui.downloadBtn.style.display = 'block';
    ui.copyPageBtn.style.display = 'block';
}

// ==========================================
// 6. 生命周期控制与事件响应
// ==========================================

function startCalculation() {
    ui.input.classList.remove('input-error'); 
    let inputStr = ui.input.value;
    currentPattern = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
    
    // 安全防御：空规则拦截
    if (currentPattern.length === 0) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 请先输入包含数字、字母或 * 号的卡号规则！</div>";
        ui.input.classList.add('input-error');
        ui.input.focus();
        return;
    }

    let excludes = [];
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => { excludes.push(cb.value); });
    let hasVariables = /[a-zA-Z*]/.test(currentPattern);
    
    // 核心业务防御：前置构建合法数字沙盘，阻断因矛盾互斥产生的死局
    let validDigits = [];
    for (let i = 0; i < 10; i++) {
        if (excludes.includes(i.toString())) continue;
        if (ui.excludeOdd.checked && i % 2 !== 0) continue;
        if (ui.excludeEven.checked && i % 2 === 0) continue;
        validDigits.push(i);
    }

    // 逻辑死锁拦截
    if (validDigits.length === 0 && hasVariables) {
        ui.resultContent.innerHTML = "<div class='empty-placeholder' style='color: var(--error-red); font-weight: bold;'>⚠️ 逻辑冲突：您的排除条件过滤掉了所有的 0-9 数字，无法生成卡号。</div>";
        return;
    }

    // 开启新任务前置初始化
    initWorker();
    results = []; currentPage = 1; generateLegend(currentPattern);
    
    // 重置并清理 UI
    ui.resultContent.innerHTML = "";
    ui.calcBtn.style.display = 'none'; 
    ui.stopBtn.style.display = 'block';
    ui.count.textContent = "0"; 
    ui.pagination.style.display = 'none'; 
    ui.downloadBtn.style.display = 'none'; 
    ui.copyPageBtn.style.display = 'none';
    
    ui.statusBar.style.display = 'block'; 
    ui.statusBar.style.color = '#B45309'; 
    ui.statusBar.style.background = '#FEF3C7'; 
    ui.statusBar.style.borderColor = '#FDE68A';
    ui.statusBar.textContent = '● 算法正在计算中...';

    // 交派计算任务给子线程
    worker.postMessage({ 
        type: 'start', 
        input: currentPattern, 
        filters: { exclude: excludes, excludeOdd: ui.excludeOdd.checked, excludeEven: ui.excludeEven.checked }, 
        validDigits: validDigits, 
        limit: MAX_SAFE_LIMIT 
    });
}

// 物理销毁线程事件
ui.stopBtn.addEventListener('click', () => {
    if (worker) {
        worker.terminate(); worker = null;
        ui.calcBtn.style.display = 'block'; ui.stopBtn.style.display = 'none';
        ui.statusBar.style.display = 'block'; ui.statusBar.textContent = '⏸️ 已手动停止计算';
        ui.statusBar.style.color = '#B45309'; ui.statusBar.style.background = '#FEF3C7'; ui.statusBar.style.borderColor = '#FDE68A';
    }
});

// 数据重置归零事件
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
    
    // UI 清场
    ui.pagination.style.display = 'none'; 
    ui.downloadBtn.style.display = 'none';
    ui.copyPageBtn.style.display = 'none'; 
    
    ui.numberCheckboxes.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    ui.excludeOdd.checked = false; ui.excludeEven.checked = false;
    ui.input.focus();
});

// ==========================================
// 7. 外围辅助交互机制
// ==========================================

// 事件委托：全列表无感复制捕获
ui.resultContent.addEventListener('click', (e) => {
    let row = e.target.closest('.result-row');
    if (!row) return;
    let textToCopy = row.getAttribute('data-clipboard');
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            showToast('✅ 复制成功: ' + textToCopy);
        });
    } else {
        // 兼容版复制方案
        let textArea = document.createElement("textarea");
        textArea.value = textToCopy;
        textArea.style.position = "fixed";
        document.body.appendChild(textArea);
        textArea.focus(); textArea.select();
        try { document.execCommand('copy'); showToast('✅ 复制成功: ' + textToCopy); } catch (err) {}
        document.body.removeChild(textArea);
    }
});

// 批量单页数据提取
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

// 输入框实时清理过滤与报警检测
ui.input.addEventListener('input', () => {
    ui.input.classList.remove('input-error');
    
    let filtered = ui.input.value.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');
    ui.input.value = filtered; 
    
    let len = filtered.replace(/\s/g, '').length;
    ui.validCount.textContent = len;
    
    // 超过国际标准卡号19位的温和指引
    const lenWarning = document.getElementById('lenWarning');
    if (len > 19) { lenWarning.style.display = 'inline'; } 
    else { lenWarning.style.display = 'none'; }
});

ui.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCalculation(); });
ui.calcBtn.addEventListener('click', startCalculation);

// ==========================================
// 8. 分页流与 CSV 文件导出体系
// ==========================================

function updatePaginationUI() {
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    ui.totalPages.textContent = total.toLocaleString();
    
    // 防干扰：用户正通过焦点打字时屏蔽刷新
    if (document.activeElement !== ui.pageInput) {
        ui.pageInput.value = currentPage;
    }
    
    let isFirst = currentPage <= 1;
    let isLast = currentPage >= total;
    
    ui.prevBtn.disabled = isFirst;
    ui.firstPageBtn.disabled = isFirst;
    ui.nextBtn.disabled = isLast;
    ui.lastPageBtn.disabled = isLast;
}

ui.pageInput.addEventListener('input', function() { this.value = this.value.replace(/\D/g, ''); });
ui.pageInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') this.blur(); });

ui.firstPageBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage = 1; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
ui.lastPageBtn.addEventListener('click', () => { 
    const total = Math.ceil(results.length / pageSize);
    if (currentPage < total) { currentPage = total; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } 
});
ui.prevBtn.addEventListener('click', () => { if (currentPage > 1) { currentPage--; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });
ui.nextBtn.addEventListener('click', () => { if (currentPage < Math.ceil(results.length / pageSize)) { currentPage++; renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' }); } });

// 分页越界强纠错机制
ui.pageInput.addEventListener('change', function() {
    let val = parseInt(this.value);
    const total = Math.max(1, Math.ceil(results.length / pageSize));
    
    if (isNaN(val) || val <= 0) val = 1;
    if (val > total) val = total;
    
    currentPage = val;
    this.value = currentPage; 
    
    renderPage(); updatePaginationUI(); window.scrollTo({ top: 0, behavior: 'smooth' });
});

// CSV 文件构建流，附带防乱码 BOM 头
ui.downloadBtn.addEventListener('click', () => {
    if (results.length === 0) return;
    
    // 注入 BOM（\uFEFF）强制 Excel 使用 UTF-8 解析
    let csvContent = '\uFEFF银行卡号,特征标签\n';
    
    csvContent += results.map(res => {
        let formatted = res.replace(/\d{4}(?=\d)/g, '$& ');
        let tagsArr = parseTags(res, false); 
        // 隔离符处理：合并数组并避开逗号，防止 CSV 错列
        let tagsStr = tagsArr.length > 0 ? tagsArr.join(' / ') : '无';
        return `"${formatted}","${tagsStr}"`; 
    }).join('\n');
    
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); 
    a.href = url; 
    a.download = `卡号生成结果_${results.length}条.csv`;
    document.body.appendChild(a); 
    a.click(); 
    document.body.removeChild(a); 
    URL.revokeObjectURL(url);
});