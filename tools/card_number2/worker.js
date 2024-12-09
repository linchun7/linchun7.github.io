// 存储生成的银行卡号组合
let results = [];
// 存储字母映射
let letterMap = {};
// 最大生成结果数量
const maxResults = Number.MAX_SAFE_INTEGER;

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
 * 生成银行卡号的组合
 */
function generateCombinations(str, combination = '') {
    if (results.length >= maxResults) {
        return;
    }

    if (str.length === 0) {
        if (combination.length > 0 && luhnCheck(combination)) {
            results.push(combination);
        }
    } else {
        let char = str[0];

        if (char >= '0' && char <= '9') {
            generateCombinations(str.substring(1), combination + char);
        } else if (char.match(/[a-zA-Z]/)) {
            let firstLetter = char.toLowerCase();
            if (letterMap[firstLetter] === undefined) {
                for (let i = 0; i < 10; i++) {
                    letterMap[firstLetter] = i;
                    generateCombinations(str.substring(1), combination + i);
                }
                letterMap[firstLetter] = undefined;
            } else {
                generateCombinations(str.substring(1), combination + letterMap[firstLetter]);
            }
        } else if (char === '*') {
            for (let i = 0; i < 10; i++) {
                generateCombinations(str.substring(1), combination + i);
            }
        }
    }
}

// 监听主线程消息
self.addEventListener('message', function(e) {
    if (e.data.type === 'generate') {
        results = [];
        letterMap = {};
        generateCombinations(e.data.input);
        
        // 返回结果给主线程
        self.postMessage({
            type: 'result',
            results: results
        });
    }
}); 