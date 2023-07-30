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
    let rawInput = input.value.replace(/[^0-9xX*\s]/g, '');
    input.value = rawInput; // 清除非法字符
    let validCount = (rawInput.match(/[0-9xX*]/g) || []).length;
    let wildcardCount = (rawInput.match(/[xX*]/g) || []).length;

    // 限制已输入有效位数不大于30位
    if (validCount > 30) {
        output.textContent = '有效位数超过 30 位，无法生成卡号。';
        cardCount.textContent = `生成的卡号数量：0`;
        return;
    }

    // 更新信息
    info.textContent = `已输入有效位数：${validCount}`;
	
	
	// 生成和显示银行卡号
	if (validCount < 15) {
		output.textContent = '有效位数少于15位，无法生成卡号。';
		cardCount.textContent = `生成的卡号数量：0`;
	} else if (wildcardCount > 4) {
		output.textContent = '可变内容超过4位，无法生成卡号。';
		cardCount.textContent = `生成的卡号数量：0`;
	} else {
		let cardNumbers = generateCardNumbers(rawInput.replace(/\s+/g, ''));
		output.textContent = formatCardNumbers(cardNumbers).join('\n');
		cardCount.textContent = `生成的卡号数量：${cardNumbers.length}`;
	}
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

function formatCardNumbers(cardNumbers) {
    // 每4位加一个空格显示
    return cardNumbers.map(cardNumber => cardNumber.replace(/\s/g, '').replace(/(.{4})/g, '$1 '));
}
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?db1887936545a6bc1ba1afebdd10e617";
  var s = document.getElementsByTagName("script")[0]; 
  s.parentNode.insertBefore(hm, s);
})();
