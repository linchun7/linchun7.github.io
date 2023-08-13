// 存储生成的卡号数组test
let generatedNumbers = [];

// 存储字母映射到数字的映射表
let charMap = {};

// 每批生成的数量限制
const batchSize = 10000;

// 递归生成卡号组合的函数
function generateNumbersBatch(input, batch = 0, combination = '') {
  if (generatedNumbers.length >= batchSize) {
    displayGeneratedNumbers(batchSize);
    return;
  }

  if (input.length === 0) {
    if (combination && isValidLuhn(combination)) {
      generatedNumbers.push(combination);
      batch++;
    }
  } else {
    let char = input[0];

    if (char >= '0' && char <= '9') {
      generateNumbersBatch(input.substring(1), batch, combination + char);
    } else if (char.match(/[a-zA-Z]/)) {
      let firstChar = char.toLowerCase();
      if (!charMap[firstChar]) {
        for (let i = 0; i < 10; i++) {
          if (generatedNumbers.length >= batchSize) {
            displayGeneratedNumbers(batchSize);
            return;
          }
          charMap[firstChar] = i;
          generateNumbersBatch(input.substring(1), batch, combination + i);
          batch++;
        }
        charMap[firstChar] = undefined;
      } else {
        generateNumbersBatch(input.substring(1), batch, combination + charMap[firstChar]);
        batch++;
      }
    } else if (char === '*') {
      for (let i = 0; i < 10; i++) {
        if (generatedNumbers.length >= batchSize) {
          displayGeneratedNumbers(batchSize);
          return;
        }
        generateNumbersBatch(input.substring(1), batch, combination + i);
        batch++;
      }
    }
  }
}

// 启动生成初始卡号批次的函数
function startNumberGenerationBatch() {
  const userInput = document.getElementById('inputField').value;
  const processedInput = userInput.replace(/[^a-zA-Z0-9*]/g, '');
  generatedNumbers = [];
  charMap = {};

  if (processedInput.length > 0) {
    generateNumbersBatch(processedInput);
  }

  displayGeneratedNumbers();
}

// 显示生成的卡号函数
function displayGeneratedNumbers(limit = generatedNumbers.length) {
  const formattedNumbers = generatedNumbers.slice(0, limit).map(formatCardNumber).join('\n');
  document.getElementById('result').textContent = formattedNumbers;

  const countElement = document.getElementById('count');
  if (generatedNumbers.length >= batchSize) {
    countElement.textContent = `生成的卡号数量超过${batchSize}，为了用户体验，显示前${batchSize}条结果。`;
  } else {
    countElement.textContent = `生成的卡号数量：${generatedNumbers.length}`;
  }
}

// 格式化卡号的函数
function formatCardNumber(cardNumber) {
  const segments = cardNumber.match(/.{1,4}/g);
  return segments.join(' ');
}

// Luhn 算法检验函数
function isValidLuhn(number) {
  let length = number.length;
  let parity = length % 2;
  let sum = 0;
  for (let i = length - 1; i >= 0; i--) {
    let digit = parseInt(number[i], 10);
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

// 处理用户输入的函数
function handleInput() {
  const inputField = document.getElementById('inputField');
  let userInput = inputField.value;

  userInput = userInput.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');

  inputField.value = userInput;

  const validCount = userInput.replace(/[^a-zA-Z0-9*]/g, '').length;
  document.getElementById('validCount').textContent = `已输入有效位数：${validCount}`;
}

// 监听输入字段变化事件，处理输入和生成卡号
document.getElementById('inputField').addEventListener('input', function() {
  handleInput();
  startNumberGenerationBatch();
});

// 监听确定按钮点击事件，触发生成卡号
document.getElementById('submit').addEventListener('click', function() {
  startNumberGenerationBatch();
});

// 生成初始批次
startNumberGenerationBatch();
