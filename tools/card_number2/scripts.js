// 创建 Worker 实例
let worker = new Worker('worker.js');

// 添加结果缓存
let allResults = [];

// 监听 worker 消息
worker.addEventListener('message', function(e) {
    if (e.data.type === 'result') {
        allResults = allResults.concat(e.data.results);
        
        // 直接显示当前接收到的数量
        document.getElementById('count').textContent = allResults.length;
        
        if (e.data.isComplete) {
            // 计算完成时，不管有没有结果都清除"计算中..."
            document.getElementById('result').textContent = '';
            displayResults(allResults);
            allResults = []; // 清空缓存
        } else {
            // 有结果时清除"计算中..."并显示结果
            if (e.data.results.length > 0) {
                document.getElementById('result').textContent = '';
                displayResults(allResults);
            }
        }
    }
});

// 添加错误处理
worker.addEventListener('error', function(e) {
    console.error('Worker error:', e);
    displayResults([]); // 发生错误时显示空结果
});

/**
 * 开始生成银行卡号组合
 */
function startGeneration() {
    let inputStr = document.getElementById('inputField').value;
    let processedInput = inputStr.replace(/[^a-zA-Z0-9*]/g, '');

    if (processedInput.length > 0) {
        document.getElementById('result').textContent = '计算中...';
        document.getElementById('count').textContent = '';
        
        worker.postMessage({
            type: 'generate',
            input: processedInput
        });
    } else {
        displayResults([]);
    }
}

/**
 * 显示生成结果
 */
function displayResults(results) {
    let formattedResults = results.map(result => {
        // 先将结果分组为4位一组
        let formatted = result.replace(/\d{4}(?=\d)/g, '$& ');
        // 获取原始输入
        let inputStr = document.getElementById('inputField').value.replace(/\s/g, '');
        
        // 将结果转换为数组以便处理
        let chars = formatted.split('');
        let inputChars = inputStr.split('');
        let pos = 0; // 用于跟踪实际位置（不包括空格）
        
        // 遍历结果的每个字符
        for(let i = 0; i < chars.length; i++) {
            if(chars[i] !== ' ') { // 跳过空格
                if(pos < inputChars.length) {
                    if(/[a-zA-Z]/.test(inputChars[pos])) {
                        // 对字母对应位置添加字母高亮
                        chars[i] = `<span class="highlight-letter">${chars[i]}</span>`;
                    } else if(inputChars[pos] === '*') {
                        // 对星号对应位置添加星号高亮
                        chars[i] = `<span class="highlight-star">${chars[i]}</span>`;
                    }
                }
                pos++;
            }
        }
        return chars.join('');
    });

    let countMessage = `${results.length}`;
    let countText = "生成的卡号数量：";
    
    document.getElementById('countText').textContent = countText;
    document.getElementById('count').textContent = countMessage;
    document.getElementById('result').innerHTML = formattedResults.join('\n');
}

// 处理用户输入
document.getElementById('inputField').addEventListener('input', function() {
    handleInput();
    startGeneration();
});

// 添加点击事件处理
document.getElementById('generateButton').addEventListener('click', function() {
    clearInput();
    document.getElementById('inputField').focus();
    startGeneration();
});

/**
 * 清空输入框内容
 */
function clearInput() {
    document.getElementById('inputField').value = '';
    handleInput();
}

/**
 * 处理用户输入，过滤非法字符并更新统计信息
 */
function handleInput() {
    let inputField = document.getElementById('inputField');
    let inputStr = inputField.value;

    inputStr = inputStr.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');
    inputField.value = inputStr;

    let validCount = inputStr.replace(/[^a-zA-Z0-9*]/g, '').length;
    document.getElementById('validCount').textContent = `${validCount}`;
}

// 百度统计代码
var _hmt = _hmt || [];
(function() {
    var hm = document.createElement("script");
    hm.src = "https://hm.baidu.com/hm.js?db1887936545a6bc1ba1afebdd10e617";
    var s = document.getElementsByTagName("script")[0]; 
    s.parentNode.insertBefore(hm, s);
})();

// 添加页面卸载时的清理
window.addEventListener('unload', function() {
    if (worker) {
        worker.terminate();
    }
});


