// 生成银行卡号时的延迟函数
async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let results = [];
let letterMap = {};

/**
 * 生成银行卡号的组合
 * @param {string} str - 输入的银行卡号模板
 * @param {number} batchSize - 每批显示的条数
 * @param {string} combination - 当前组合的中间结果
 */
async function generateCombinations(str, batchSize, combination = '') {
  if (str.length === 0) {
    if (luhnCheck(combination)) { // Luhn 验证通过才加入结果
      results.push(combination);
      if (results.length % batchSize === 0) {
        displayResults();
        await sleep(0); // 设置适当的延迟，这里是 200 毫秒
      }
    }
  } else {
    let char = str[0];

    if (char >= '0' && char <= '9') {
      await generateCombinations(str.substring(1), batchSize, combination + char);
    } else if (char.match(/[a-zA-Z]/)) {
      let firstLetter = char.toLowerCase();
      if (letterMap[firstLetter] === undefined) {
        for (let i = 0; i < 10; i++) {
          letterMap[firstLetter] = i;
          await generateCombinations(str.substring(1), batchSize, combination + i);
        }
        letterMap[firstLetter] = undefined;
      } else {
        await generateCombinations(str.substring(1), batchSize, combination + letterMap[firstLetter]);
      }
    } else if (char === '*') {
      for (let i = 0; i < 10; i++) {
        await generateCombinations(str.substring(1), batchSize, combination + i);
      }
    }
  }
}

// 处理用户输入
document.getElementById('inputField').addEventListener('input', async function() {
  handleInput();
  await startGeneration();
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
  document.getElementById('validCount').innerText = `有效位数: ${validCount}`;
}

/**
 * 开始生成银行卡号组合
 */
async function startGeneration() {
  let inputStr = document.getElementById('inputField').value;
  let processedInput = inputStr.replace(/[^a-zA-Z0-9*]/g, ''); //
  results = [];
  letterMap = {};
  let batchSize = 10000; // 设置每批显示的条数
  await generateCombinations(processedInput, batchSize);
  displayResults();
}

/**
 * 显示生成结果
 */
function displayResults() {
  document.getElementById('result').innerText = results.join('\n');
  document.getElementById('count').innerText = `生成的组合数量: ${results.length}`;
}

/**
 * Luhn 算法验证
 * @param {string} str - 输入的银行卡号
 * @returns {boolean} - 验证结果，true表示通过
 */
function luhnCheck(str) {
  let len = str.length;
  let parity = len % 2;
  let sum = 0;
  for (let i = len - 1; i >= 0; i--) {
    let d = parseInt(str.charAt(i));
    if (i % 2 === parity) d *= 2;
    if (d > 9) d -= 9;
    sum += d;
  }
  return sum % 10 === 0;
}