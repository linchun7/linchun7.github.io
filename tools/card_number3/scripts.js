// 存储生成的银行卡号组合
let results = [];
// 存储字母映射
let letterMap = {};
// 最大生成结果数量
let maxResults = 50000; // 你可以根据需要设置最大数量

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
    // 插入像素，每隔4位数字
  let formattedResult = result.replace(/\d{4}(?=\d)/g, '$&<span class="digit-space"></span>');

    return formattedResult;
  });

  let countMessage = results.length >= maxResults
    ? `生成的卡号过多，仅显示前 ${maxResults} 条`
    : `生成的卡号数量：${results.length}`;
  
  document.getElementById('result').innerHTML = formattedResults.join('<br>');
  document.getElementById('count').textContent = countMessage;
}

// 处理用户输入
document.getElementById('inputField').addEventListener('input', function() {
  handleInput();
  startGeneration();
});

// 添加点击事件处理
document.getElementById('generateButton').addEventListener('click', function() {
  clearInput(); // 调用清空输入框函数
  document.getElementById('inputField').focus(); // 设置输入框焦点
  startGeneration(); // 重新开始生成银行卡号组合
});

/**
 * 清空输入框内容
 */
function clearInput() {
  document.getElementById('inputField').value = ''; // 清空输入框内容
  handleInput(); // 更新统计信息
}

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


// 百度统计代码
var _hmt = _hmt || [];
(function() {
  var hm = document.createElement("script");
  hm.src = "https://hm.baidu.com/hm.js?db1887936545a6bc1ba1afebdd10e617";
  var s = document.getElementsByTagName("script")[0]; 
  s.parentNode.insertBefore(hm, s);
})();
