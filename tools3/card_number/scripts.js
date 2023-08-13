let results = [];
let letterMap = {};
let currentPage = 0;
const resultsPerPage = 100; // 每页显示的结果数量
const batchSize = resultsPerPage * 10; // 每批生成的数量

function generateCombinationsBatch(str, batchSize, currentBatch = 0, combination = '') {
  if (results.length >= batchSize) {
    return;
  }

  if (str.length === 0) {
    if (combination.length > 0 && luhnCheck(combination)) {
      results.push(combination);
      currentBatch++;
    }
  } else {
    let char = str[0];

    if (char >= '0' && char <= '9') {
      generateCombinationsBatch(str.substring(1), batchSize, currentBatch, combination + char);
    } else if (char.match(/[a-zA-Z]/)) {
      let firstLetter = char.toLowerCase();
      if (letterMap[firstLetter] === undefined) {
        for (let i = 0; i < 10; i++) {
          if (results.length >= batchSize) {
            return;
          }
          letterMap[firstLetter] = i;
          generateCombinationsBatch(str.substring(1), batchSize, currentBatch, combination + i);
          currentBatch++;
        }
        letterMap[firstLetter] = undefined;
      } else {
        generateCombinationsBatch(str.substring(1), batchSize, currentBatch, combination + letterMap[firstLetter]);
        currentBatch++;
      }
    } else if (char === '*') {
      for (let i = 0; i < 10; i++) {
        if (results.length >= batchSize) {
          return;
        }
        generateCombinationsBatch(str.substring(1), batchSize, currentBatch, combination + i);
        currentBatch++;
      }
    }
  }
}

function startGenerationBatch() {
  let inputStr = document.getElementById('inputField').value;
  let processedInput = inputStr.replace(/[^a-zA-Z0-9*]/g, '');
  results = [];
  letterMap = {};

  if (processedInput.length > 0) {
    generateCombinationsBatch(processedInput, batchSize);
  }

  currentPage = 0; // 重置当前页
  displayResults();
}

function displayResults() {
  const startIndex = currentPage * resultsPerPage;
  const endIndex = Math.min((currentPage + 1) * resultsPerPage, results.length);
  const pageResults = results.slice(startIndex, endIndex);
  
  document.getElementById('result').textContent = pageResults.join('\n');
  document.getElementById('count').textContent = `生成的卡号数量：${results.length}`;
  updatePageContent();
  updatePageButtons();
}

function handleInput() {
  let inputField = document.getElementById('inputField');
  let inputStr = inputField.value;

  inputStr = inputStr.replace(/[^a-zA-Z0-9*\s]/g, '').replace(/\s+/g, ' ');

  inputField.value = inputStr;

  let validCount = inputStr.replace(/[^a-zA-Z0-9*]/g, '').length;
  document.getElementById('validCount').textContent = `已输入有效位数：${validCount}`;
}

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

function updatePageButtons() {
  const prevPageButton = document.getElementById('prevPage');
  const nextPageButton = document.getElementById('nextPage');

  prevPageButton.disabled = currentPage === 0;
  nextPageButton.disabled = (currentPage + 1) * resultsPerPage >= results.length;
}

function updatePageContent() {
  const startIndex = currentPage * resultsPerPage;
  const endIndex = Math.min((currentPage + 1) * resultsPerPage, results.length);
  const pageResults = results.slice(startIndex, endIndex);
  
  document.getElementById('result').textContent = pageResults.join('\n');
}

document.getElementById('inputField').addEventListener('input', function() {
  handleInput();
  startGenerationBatch();
});

document.getElementById('prevPage').addEventListener('click', function() {
  if (currentPage > 0) {
    currentPage--;
    displayResults();
  }
});

document.getElementById('nextPage').addEventListener('click', function() {
  const nextPageStart = (currentPage + 1) * resultsPerPage;
  if (nextPageStart < results.length) {
    currentPage++;
    displayResults();
  }
});

startGenerationBatch(); // 生成初始批次
updatePageButtons();
