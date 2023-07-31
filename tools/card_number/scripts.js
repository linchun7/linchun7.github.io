// 获取 HTML 元素
const input = document.getElementById('input');
const submit = document.getElementById('submit');
const info = document.getElementById('info');
const cardCount = document.getElementById('cardCount');
const output = document.getElementById('output');

// 处理输入内容，当输入框内容改变时调用
input.addEventListener('input', handleInput);

// 自动聚焦输入框
input.focus();

function handleInput() {
    // 获取并处理输入
    let filteredInput = filterInput(input.value);
    input.value = filteredInput;
    let validCount = countValidDigits(filteredInput);
    let wildcardCount = countWildcards(filteredInput);

    // 限制已输入有效位数不大于30位
    if (validCount > 30) {
		output.innerHTML = '<span class="red-text">有效位数超过 30 位，请输入 30 位以内的卡号。</span>';
        cardCount.textContent = `生成的卡号数量：0`;
        return;
    }

    // 更新信息
    info.textContent = `已输入有效位数：${validCount}`;

    // 生成和显示银行卡号
    if (validCount < 15) {
		output.innerHTML = '<span class="red-text">有效位数不足 15 位，请输入 15 位以上的卡号。</span>';
        cardCount.textContent = `生成的卡号数量：0`;
    } else if (wildcardCount > 4) {
		output.innerHTML = '<span class="red-text">可变符号超过 4 位，请删除多余的 x 或 * 号。</span>';
        cardCount.textContent = `生成的卡号数量：0`;
    } else {
        let cardNumbers = generateCardNumbers(filteredInput.replace(/\s+/g, ''));
        output.textContent = formatCardNumbers(cardNumbers).join('\n');
        cardCount.textContent = `生成的卡号数量：${cardNumbers.length}`;
    }
}

function filterInput(input) {
    return input.replace(/[^0-9xX*\s]/g, '');
}

function countValidDigits(input) {
    return (input.match(/[0-9xX*]/g) || []).length;
}

function countWildcards(input) {
    return (input.match(/[xX*]/g) || []).length;
}

function generateCardNumbers(template) {
    // 生成满足 Luhn 算法的银行卡号
    let cardNumbers = [];
    let wildcardCount = (template.match(/[xX*]/g) || []).length;

    for (let i = 0; i < Math.pow(10, wildcardCount); i++) {
        let cardNumber = template;
        let replacements = String(i).padStart(wildcardCount, '0').split('');
        replacements.forEach(replacement => {
            cardNumber = cardNumber.replace(/[xX*]/, replacement);
        });
        if (luhnCheck(cardNumber)) {
            cardNumbers.push(cardNumber);
        }
    }

    return cardNumbers;
}

function luhnCheck(cardNumber) {
    // 进行 Luhn 校验
    let sum = 0;
    for (let i = 0; i < cardNumber.length; i++) {
        let digit = parseInt(cardNumber[cardNumber.length - 1 - i]);
        if (i % 2 === 1) {
            digit *= 2;
            if (digit > 9) {
                digit -= 9;
            }
        }
        sum += digit;
    }
    return sum % 10 === 0;
}

function formatCardNumber(cardNumber) {
    return cardNumber.replace(/\s/g, '').replace(/(.{4})/g, '$1 ');
}

function formatCardNumbers(cardNumbers) {
    return cardNumbers.map(formatCardNumber);
}

// 百度统计代码
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?db1887936545a6bc1ba1afebdd10e617";
  var s = document.getElementsByTagName("script")[0]; 
  s.parentNode.insertBefore(hm, s);
})();
