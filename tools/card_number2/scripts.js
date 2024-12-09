// 创建 Worker 实例
let worker = new Worker('worker.js');

// 监听 worker 消息
worker.addEventListener('message', function(e) {
    if (e.data.type === 'result') {
        displayResults(e.data.results);
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
        return result.replace(/\d{4}(?=\d)/g, '$& ');
    });

    let countMessage = `${results.length}`;
    let countText = "生成的卡号数量：";
    
    document.getElementById('countText').textContent = countText;
    document.getElementById('count').textContent = countMessage;
    document.getElementById('result').textContent = formattedResults.join('\n');
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


