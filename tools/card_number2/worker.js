// 存储字母映射
let letterMap = {};
// 每批发送的结果数量
const BATCH_SEND_SIZE = 1000;
// 添加计数器
let totalCount = 0;

/**
 * Luhn 算法验证
 */
function luhnCheck(str) {
    let len = str.length;
    let parity = len % 2;
    let sum = 0;
    for (let i = len - 1; i >= 0; i--) {
        let digit = parseInt(str[i], 10);
        if ((i + parity) % 2 === 0) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

/**
 * 分批生成组合
 */
function* generateCombinationsIterator(str, combination = '') {
    if (str.length === 0) {
        if (combination.length > 0 && luhnCheck(combination)) {
            totalCount++;
            yield combination;
        }
    } else {
        let char = str[0];

        if (char >= '0' && char <= '9') {
            yield* generateCombinationsIterator(str.substring(1), combination + char);
        } else if (char.match(/[a-zA-Z]/)) {
            let firstLetter = char.toLowerCase();
            if (letterMap[firstLetter] === undefined) {
                for (let i = 0; i < 10; i++) {
                    letterMap[firstLetter] = i;
                    yield* generateCombinationsIterator(str.substring(1), combination + i);
                }
                letterMap[firstLetter] = undefined;
            } else {
                yield* generateCombinationsIterator(str.substring(1), combination + letterMap[firstLetter]);
            }
        } else if (char === '*') {
            for (let i = 0; i < 10; i++) {
                yield* generateCombinationsIterator(str.substring(1), combination + i);
            }
        }
    }
}

/**
 * 分批发送结果
 */
function sendBatchResults(batch, isComplete = false) {
    self.postMessage({
        type: 'result',
        results: batch,
        isComplete: isComplete,
        total: totalCount
    });
}

/**
 * 处理生成过程
 */
function processGeneration(iterator) {
    let batch = [];
    let lastSendTime = Date.now();
    
    function processBatch() {
        let startTime = Date.now();
        
        while (Date.now() - startTime < 100) { // 最多执行100ms
            let next = iterator.next();
            
            if (next.done) {
                if (batch.length > 0) {
                    sendBatchResults(batch, true);
                }
                return;
            }
            
            if (next.value) {
                batch.push(next.value);
                
                // 如果批次满了或者距离上次发送超过500ms，就发送数据
                if (batch.length >= BATCH_SEND_SIZE || 
                    (batch.length > 0 && Date.now() - lastSendTime > 500)) {
                    sendBatchResults(batch, false);
                    batch = [];
                    lastSendTime = Date.now();
                }
            }
        }
        
        setTimeout(() => processBatch(), 0);
    }
    
    processBatch();
}

// 监听主线程消息
self.addEventListener('message', function(e) {
    if (e.data.type === 'generate') {
        try {
            totalCount = 0;
            letterMap = {};
            
            const iterator = generateCombinationsIterator(e.data.input);
            processGeneration(iterator);
        } catch (error) {
            self.postMessage({
                type: 'error',
                message: error.message
            });
        }
    }
}); 