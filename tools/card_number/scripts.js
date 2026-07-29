// 存储生成的银行卡号组合
let results = [];
// 最大生成结果数量
let maxResults = 50000; // 你可以根据需要设置最大数量

// 从右向左的 Luhn 位权贡献：普通位、双倍后减 9 的位
const luhnTable = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [0, 2, 4, 6, 8, 1, 3, 5, 7, 9]
];

/**
 * 生成银行卡号的组合
 * @param {string} str - 输入的银行卡号模板
 */
function generateCombinations(str) {
  const length = str.length;
  if (length === 0 || results.length >= maxResults) return;

  // 变量按首次出现顺序编号；每个 * 独立，相同字母（忽略大小写）共享编号。
  const variableAtPosition = new Int32Array(length);
  variableAtPosition.fill(-1);
  const letterVariables = new Int32Array(26);
  letterVariables.fill(-1);
  let variableCount = 0;

  for (let position = 0; position < length; position++) {
    const code = str.charCodeAt(position);
    if (code >= 48 && code <= 57) continue;

    let variable;
    if (code === 42) {
      variable = variableCount++;
    } else {
      const lowerCode = code >= 65 && code <= 90 ? code + 32 : code;
      const letterIndex = lowerCode - 97;
      variable = letterVariables[letterIndex];
      if (variable === -1) {
        variable = variableCount++;
        letterVariables[letterIndex] = variable;
      }
    }
    variableAtPosition[position] = variable;
  }

  // 每个变量取 0-9 时对 Luhn 总和的贡献，重复字母的多处贡献在这里合并。
  const contributions = new Uint8Array(variableCount * 10);
  let fixedContribution = 0;

  for (let position = 0; position < length; position++) {
    const parity = (length - 1 - position) & 1;
    const variable = variableAtPosition[position];

    if (variable === -1) {
      fixedContribution = (fixedContribution + luhnTable[parity][str.charCodeAt(position) - 48]) % 10;
      continue;
    }

    const offset = variable * 10;
    for (let digit = 0; digit < 10; digit++) {
      contributions[offset + digit] = (contributions[offset + digit] + luhnTable[parity][digit]) % 10;
    }
  }

  if (variableCount === 0) {
    if (fixedContribution === 0) results.push(formatFixedCardNumber(str));
    return;
  }

  // 每个掩码记录从当前变量开始可达到的 Luhn 余数，用于提前剪掉无解分支。
  const suffixMasks = new Uint16Array(variableCount + 1);
  suffixMasks[variableCount] = 1;

  for (let variable = variableCount - 1; variable >= 0; variable--) {
    const nextMask = suffixMasks[variable + 1];
    const offset = variable * 10;
    let mask = 0;

    for (let digit = 0; digit < 10; digit++) {
      const ownContribution = contributions[offset + digit];
      for (let residue = 0; residue < 10; residue++) {
        if (nextMask & (1 << residue)) {
          mask |= 1 << ((ownContribution + residue) % 10);
        }
      }
    }
    suffixMasks[variable] = mask;
  }

  const requiredResidue = (10 - fixedContribution) % 10;
  if ((suffixMasks[0] & (1 << requiredResidue)) === 0) return;

  const assignment = new Uint8Array(variableCount);
  const nextDigits = new Uint8Array(variableCount);
  const prefixResidues = new Uint8Array(variableCount + 1);
  let depth = 0;

  // 使用显式栈遍历，避免规则很长时由递归深度引发调用栈溢出。
  while (depth >= 0 && results.length < maxResults) {
    if (depth === variableCount) {
      if ((fixedContribution + prefixResidues[depth]) % 10 === 0) {
        results.push(materializeCardNumber(str, variableAtPosition, assignment));
      }
      depth--;
      continue;
    }

    let descended = false;
    const offset = depth * 10;

    while (nextDigits[depth] < 10) {
      const digit = nextDigits[depth]++;
      const nextResidue = (prefixResidues[depth] + contributions[offset + digit]) % 10;
      const suffixNeeded = (10 - ((fixedContribution + nextResidue) % 10)) % 10;

      if ((suffixMasks[depth + 1] & (1 << suffixNeeded)) === 0) continue;

      assignment[depth] = digit;
      prefixResidues[depth + 1] = nextResidue;
      depth++;
      if (depth < variableCount) nextDigits[depth] = 0;
      descended = true;
      break;
    }

    if (!descended) {
      nextDigits[depth] = 0;
      depth--;
    }
  }
}

function formatFixedCardNumber(cardNumber) {
  return cardNumber.replace(/\d{4}(?=\d)/g, '$& ');
}

function materializeCardNumber(pattern, variableAtPosition, assignment) {
  const length = pattern.length;
  const formattedLength = length + Math.floor((length - 1) / 4);
  const output = new Array(formattedLength);
  let outputIndex = 0;

  for (let position = 0; position < length; position++) {
    const variable = variableAtPosition[position];
    output[outputIndex++] = variable === -1 ? pattern[position] : assignment[variable];
    if ((position + 1) % 4 === 0 && position + 1 < length) output[outputIndex++] = ' ';
  }

  return output.join('');
}

/**
 * 开始生成银行卡号组合
 */
function startGeneration() {
  let inputStr = document.getElementById('inputField').value;
  let processedInput = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
  results = [];

  if (processedInput.length > 0) {
    generateCombinations(processedInput);
  }

  displayResults();
}

/**
 * 显示生成结果
 */
function displayResults() {
  let countMessage;
  let countText = "生成的卡号数量：";

  if (results.length >= maxResults) {
    countText = ''; // 清空
    countMessage = `生成的卡号过多，仅显示前 ${maxResults} 条`;
  } else {
    countMessage = `${results.length}`;
  }
	
  document.getElementById('countText').textContent = countText;
  document.getElementById('count').textContent = countMessage;
  document.getElementById('result').textContent = results.join('\n');
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
  document.getElementById('validCount').textContent = `${validCount}`;
}

/**
 * Luhn 算法验证
 * @param {string} str - 输入的银行卡号
 * @returns {boolean} - 验证结果，true 表示通过
 */
function luhnCheck(str) {
  let len = str.length;
  let sum = 0;
  for (let i = len - 1; i >= 0; i--) {
    const digit = str.charCodeAt(i) - 48;
    sum += luhnTable[(len - 1 - i) & 1][digit];
  }
  return sum % 10 === 0;
}
