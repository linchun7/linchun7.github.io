// script.js
const ul = document.getElementById("toolList");
const searchInput = document.getElementById("searchInput");
const noResults = document.getElementById("noResults");

// 优化相似度算法
function similarity(s1, s2) {
    // 如果字符串完全相同
    if (s1 === s2) return 1.0;
    
    // 如果其中一个字符串包含另一个
    if (s1.includes(s2) || s2.includes(s1)) {
        return 0.8;
    }

    // 计算两个字符串的公共子序列长度
    function getLCS(str1, str2) {
        const m = str1.length;
        const n = str2.length;
        const dp = Array(m + 1).fill().map(() => Array(n + 1).fill(0));
        
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (str1[i - 1] === str2[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }
        return dp[m][n];
    }

    const lcs = getLCS(s1, s2);
    return lcs / Math.max(s1.length, s2.length);
}

function displayToolList(tools, keyword) {
    try {
        ul.innerHTML = "";
        tools.forEach(tool => {
            const li = document.createElement("li");
            const link = document.createElement("a");
            link.className = "tool-link";
            link.href = tool.link;
            link.innerHTML = highlightSearchKeyword(tool.name, keyword);
            li.appendChild(link);
            ul.appendChild(li);
        });
    } catch (error) {
        console.error('显示工具列表时出错:', error);
        ul.innerHTML = '<li class="error">加载失败，请刷新页面重试</li>';
    }
}

// 优化搜索函数
function filterToolsByKeyword(keyword) {
    if (!keyword) return toolList;
    
    const keywordLower = keyword.toLowerCase().trim();
    const keywords = keywordLower.split(/\s+/).filter(k => k.length > 0);
    
    if (keywords.length === 0) return toolList;
    
    const exactMatches = [];
    const partialMatches = [];
    const fuzzyMatches = [];
    
    toolList.forEach(tool => {
        const name = tool.name.toLowerCase();
        
        // 1. 精确匹配（完全相同或包含关系）
        if (name === keywordLower || name.includes(keywordLower)) {
            exactMatches.push(tool);
            return;
        }
        
        // 2. 无序关键词匹配（所有关键词都出现，不考虑顺序）
        if (keywords.length > 1) {
            if (keywords.every(k => k.length > 0 && name.includes(k))) {
                exactMatches.push(tool);
                return;
            }
        }
        
        // 3. 部分匹配（每个字符都出现）
        const keywordChars = Array.from(keywordLower).filter(char => char.trim());
        if (keywordChars.length > 0 && keywordChars.every(char => name.includes(char))) {
            partialMatches.push(tool);
            return;
        }
        
        // 4. 模糊匹配（相似度阈值调整）
        const sim = similarity(name, keywordLower);
        if (sim > 0.4) {
            fuzzyMatches.push({
                tool,
                similarity: sim
            });
        }
    });
    
    fuzzyMatches.sort((a, b) => {
        const simDiff = b.similarity - a.similarity;
        if (simDiff === 0) {
            return toolList.indexOf(a.tool) - toolList.indexOf(b.tool);
        }
        return simDiff;
    });
    
    return [
        ...exactMatches,
        ...partialMatches,
        ...fuzzyMatches.map(item => item.tool)
    ];
}

// 优化高亮显示函数
function highlightSearchKeyword(text, keyword) {
    if (!keyword) return text;
    
    const textLower = text.toLowerCase();
    const keywordLower = keyword.toLowerCase().trim();
    const keywords = keywordLower.split(/\s+/).filter(k => k.length > 0);
    
    if (keywords.length === 0) return text;
    
    // 精确匹配高亮
    if (textLower.includes(keywordLower)) {
        const regex = new RegExp(`(${escapeRegExp(keyword)})`, 'gi');
        return text.replace(regex, '<span class="highlight">$1</span>');
    }
    
    // 无序关键词匹配高亮
    if (keywords.length > 1 && keywords.every(k => textLower.includes(k))) {
        // 先收集所有需要高亮的位置
        const positions = [];
        keywords.forEach(k => {
            const regex = new RegExp(escapeRegExp(k), 'gi');
            let match;
            while ((match = regex.exec(textLower)) !== null) {
                positions.push({
                    start: match.index,
                    end: match.index + k.length,
                    text: text.slice(match.index, match.index + k.length)
                });
            }
        });
        
        if (positions.length === 0) return text;
        
        // 按位置排序并合并重叠区域
        positions.sort((a, b) => a.start - b.start);
        const mergedPositions = [];
        let current = positions[0];
        
        for (let i = 1; i < positions.length; i++) {
            if (current && positions[i].start <= current.end) {
                current.end = Math.max(current.end, positions[i].end);
            } else {
                if (current) mergedPositions.push(current);
                current = positions[i];
            }
        }
        if (current) {
            mergedPositions.push(current);
        }
        
        // 从后向前替换，避免位置变化
        let result = text;
        for (let i = mergedPositions.length - 1; i >= 0; i--) {
            const pos = mergedPositions[i];
            const highlightText = `<span class="highlight">${text.slice(pos.start, pos.end)}</span>`;
            result = result.slice(0, pos.start) + highlightText + result.slice(pos.end);
        }
        return result;
    }
    
    // 部分匹配高亮
    const keywordChars = Array.from(keywordLower);
    if (keywordChars.length > 0 && keywordChars.every(char => textLower.includes(char))) {
        const positions = [];
        keywordChars.forEach(char => {
            if (!char.trim()) return; // 跳过空格
            const regex = new RegExp(escapeRegExp(char), 'gi');
            let match;
            while ((match = regex.exec(textLower)) !== null) {
                positions.push({
                    start: match.index,
                    end: match.index + char.length,
                    text: text.slice(match.index, match.index + char.length)
                });
            }
        });
        
        if (positions.length === 0) return text;
        
        positions.sort((a, b) => a.start - b.start);
        const mergedPositions = [];
        let current = positions[0];
        
        for (let i = 1; i < positions.length; i++) {
            if (current && positions[i].start <= current.end) {
                current.end = Math.max(current.end, positions[i].end);
            } else {
                if (current) mergedPositions.push(current);
                current = positions[i];
            }
        }
        if (current) {
            mergedPositions.push(current);
        }
        
        let result = text;
        for (let i = mergedPositions.length - 1; i >= 0; i--) {
            const pos = mergedPositions[i];
            const highlightText = `<span class="highlight">${text.slice(pos.start, pos.end)}</span>`;
            result = result.slice(0, pos.start) + highlightText + result.slice(pos.end);
        }
        return result;
    }
    
    // 模糊匹配高亮
    if (similarity(textLower, keywordLower) > 0.3) {
        return `<span class="fuzzy-highlight">${text}</span>`;
    }
    
    return text;
}

let toolList = [];
let currentKeyword = "";

// 获取所有工具链接
const toolElements = Array.from(ul.getElementsByTagName("a"));
toolList = toolElements.map(toolElement => ({
    name: toolElement.textContent,
    link: toolElement.href
}));

displayToolList(toolList, "");

// 1. 转义正则表达式特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 2. 添加防抖处理
function debounce(func, wait, immediate = false) {
    let timeout;
    return function(...args) {
        const later = () => {
            timeout = null;
            if (!immediate) func.apply(this, args);
        };
        const callNow = immediate && !timeout;
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
        if (callNow) func.apply(this, args);
    };
}

// 4. 优化事件监听
searchInput.addEventListener("input", debounce(function() {
    const keyword = this.value.trim();
    if (keyword === currentKeyword) return;
    
    currentKeyword = keyword;
    
    try {
        if (keyword === "") {
            displayToolList(toolList, "");
            noResults.style.display = "none";
        } else {
            const filteredTools = filterToolsByKeyword(keyword);
            displayToolList(filteredTools, keyword);
            noResults.style.display = filteredTools.length === 0 ? "block" : "none";
        }
    } catch (error) {
        console.error('搜索出错:', error);
        displayToolList(toolList, ""); // 发生错误时显示所有工具
        noResults.style.display = "none";
    }
}, 300));
