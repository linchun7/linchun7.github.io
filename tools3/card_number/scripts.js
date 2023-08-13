// 存储生成的银行卡号组合
let results = [];
// 存储字母映射
let letterMap = {};
// 最大生成结果数量
let maxResults = 10000; // 你可以根据需要设置最大数量

/**
 * 生成银行卡号的组合
 * @param {string} str - 输入的银行卡号模板
 * @param {string} combination - 当前组合的中间结果
 */
function generateCombinations(str, combination = '') {
  if (results.length >= maxResults) {
    return; // 停止生成
  }

  if (str.length === 0) {
    // 当组合非空且通过 Luhn 验证时，添加到结果列表
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
        // 生成对应字母的所有数字组合
        for (let i = 0; i < 10; i++) {
          letterMap[firstLetter] = i;
          generateCombinations(str.substring(1), combination + i);
        }
        letterMap[firstLetter] = undefined;
      } else {
        generateCombinations(str.substring(1), combination + letterMap[firstLetter]);
      }
    } else if (char === '*') {
      // 对于星号，生成所有可能的数字组合
      for (let i = 0; i < 10; i++) {
        generateCombinations(str.substring(1), combination + i);
      }
    }
  }
}

/**
 * 开始生成银行卡号组合
 */
function startGeneration() {
  let inputStr = document.getElementById('inputField').value;
  let processedInput = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
  results = [];
  letterMap = {};

  if (processedInput.length > 0) {
    generateCombinations(processedInput);
  }

  displayResults();
}

/**
 * 显示生成结果
 */
function displayResults() {
  let formattedResults = results.map(result => {
    // 插入空格，每隔4位数字
    let formattedResult = result.replace(/\d{4}(?=\d)/g, '$& ');

    return formattedResult;
  });

  let countMessage = results.length >= maxResults
    ? `生成的卡号数量：为了显示体验，仅显示前 ${maxResults} 条结果。`
    : `生成的卡号数量：${results.length}`;
  
  document.getElementById('result').textContent = formattedResults.join('\n');
  document.getElementById('count').textContent = countMessage;
}

// 处理用户输入
document.getElementById('inputField').addEventListener('input', function() {
  handleInput();
  startGeneration();
});

// 添加点击事件处理
document.getElementById('generateButton').addEventListener('click', function() {
  startGeneration();
});

/**
 * 处理用户输入，过滤非法字符并更新统计信息
 */
function handleInput() {
  let inputField = document.getElementById('inputField');
  let inputStr = inputField.value;

  // 过滤非字母、数字、星号的字符，并将多个空格替换为一个空格
  inputStr = inputStr.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');

  // 更新输入框内容
  inputField.value = inputStr;

  // 统计有效位数（不包括空格）
  let validCount = inputStr.replace(/[^a-zA-Z0-9*]/g, '').length;
  document.getElementById('validCount').textContent = `已输入有效位数：${validCount}`;
}

/**
 * Luhn 算法验证
 * @param {string} str - 输入的银行卡号
 * @returns {boolean} - 验证结果，true 表示通过
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
