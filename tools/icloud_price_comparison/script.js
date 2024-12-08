// 使用 ExchangeRate-API 的免费端点获取实时汇率数据
// 数据来源：https://www.exchangerate-api.com
const EXCHANGE_API_URL = 'https://open.er-api.com/v6/latest/CNY';

// 存储汇率数据和状态
let exchangeRates = defaultRates; // 初始使用固定汇率
let isLiveRate = false;

// 当实时汇率获取失败时，使用 exchangeRates.js 中的固定汇率作为备用
// 固定汇率数据来源：XE Currency Data (https://www.xe.com)

// 获取实时汇率数据
async function fetchExchangeRates() {
    showLoading();
    try {
        const response = await fetch(EXCHANGE_API_URL);
        const data = await response.json();
        
        // 转换汇率（因为API返回的是以CNY为基准的汇率，需要取倒数）
        exchangeRates = Object.keys(data.rates).reduce((acc, currency) => {
            acc[currency] = 1 / data.rates[currency];
            return acc;
        }, {});
        
        exchangeRates['CNY'] = 1.0;
        isLiveRate = true;
        
        // 存储汇率数据和时间
        localStorage.setItem('exchangeRates', JSON.stringify({
            rates: exchangeRates,
            timestamp: new Date().getTime(),
            isLive: true
        }));
        
        updateTable();
    } catch (error) {
        console.error('获取汇率失败:', error);
        handleError('汇率数据加载失败，使用备用数据');
        useBackupRates();
    }
}

// 使用备用汇率
function useBackupRates() {
    const storedRates = localStorage.getItem('exchangeRates');
    if (storedRates) {
        const { rates, timestamp, isLive } = JSON.parse(storedRates);
        const hoursSinceUpdate = (new Date().getTime() - timestamp) / (1000 * 60 * 60);
        
        if (hoursSinceUpdate < 24) {
            // 如果缓存的汇率不超过24小时，使用缓存的汇率
            exchangeRates = rates;
            isLiveRate = isLive;
            console.log(`使用${Math.round(hoursSinceUpdate)}小时前的汇率数据`);
        } else {
            // 如果超过24小时，使用默认固定汇率
            exchangeRates = defaultRates;
            isLiveRate = false;
            console.warn('使用固定汇率数据');
        }
    } else {
        // 如果没有缓存的汇率，使用默认固定汇率
        exchangeRates = defaultRates;
        isLiveRate = false;
        console.warn('使用固定汇率数据');
    }
    updateTable();
}

function convertToCNY(price, currency) {
    const rate = exchangeRates[currency];
    if (!rate) {
        console.warn(`Missing exchange rate for currency: ${currency}`);
        return price * (defaultRates[currency] || 0); // 如果没有汇率，使用默认汇率
    }
    return price * rate;
}

let sortDirection = 'asc';
let currentSortColumn = '50GB';

function updateTable() {
    const tbody = document.getElementById('price-tbody');
    let sortedData = [...pricesData];
    
    // 根据当前排序列进行排序
    sortedData.sort((a, b) => {
        let compareResult;
        if (['50GB', '200GB', '2TB', '6TB', '12TB'].includes(currentSortColumn)) {
            // 使用换算成人民币后的价格进行排序
            const priceA = convertToCNY(Number(a[currentSortColumn]), a.Currency);
            const priceB = convertToCNY(Number(b[currentSortColumn]), b.Currency);
            compareResult = priceA - priceB;
        } else if (currentSortColumn === '国家/地区') {
            compareResult = a['国家/地区'].localeCompare(b['国家/地区']);
        } else if (currentSortColumn === '货币') {
            compareResult = a['货币'].localeCompare(b['货币']);
        }
        return sortDirection === 'asc' ? compareResult : -compareResult;
    });

    tbody.innerHTML = '';
    sortedData.forEach(item => {
        const row = document.createElement('tr');
        const prices = ['50GB', '200GB', '2TB', '6TB', '12TB']
            .map(size => formatPriceCell(Number(item[size]), item.Currency));

        row.innerHTML = `
            <td>${item['国家/地区']}</td>
            <td>${formatCurrencyCell(item.Currency)}</td>
            <td>${prices[0]}</td>
            <td>${prices[1]}</td>
            <td>${prices[2]}</td>
            <td>${prices[3]}</td>
            <td>${prices[4]}</td>
        `;
        tbody.appendChild(row);
    });

    updateSortIndicators();
}

function updateSortIndicators() {
    const headers = document.querySelectorAll('th');
    headers.forEach(header => {
        header.classList.remove('sort-asc', 'sort-desc');
        if (header.textContent === currentSortColumn) {
            header.classList.add(sortDirection === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

function initSortHeaders() {
    const headers = document.querySelectorAll('th');
    headers.forEach(header => {
        header.style.cursor = 'pointer';
        header.addEventListener('click', () => {
            const column = header.textContent;
            if (currentSortColumn === column) {
                sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
            } else {
                currentSortColumn = column;
                sortDirection = 'asc';
            }
            updateTable();
        });
    });
}

function formatCurrencyCell(currency) {
    const rate = exchangeRates[currency];
    const rateInfo = currency === 'CNY' ? '' : 
        `<div class="rate-info">${isLiveRate ? '实时汇率' : '固定汇率'}：${rate?.toFixed(4)}</div>`;
    
    return `<div class="currency-cell">
        <div class="currency-name">${currency}</div>
        ${rateInfo}
    </div>`;
}

function formatPriceCell(price, currency) {
    let formattedPrice;
    if (['JPY', 'KRW', 'VND', 'IDR', 'CLP', 'COP', 'HUF', 'ISK'].includes(currency)) {
        formattedPrice = Math.round(price).toLocaleString();
    } else {
        formattedPrice = price.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }
    
    const cnyPrice = convertToCNY(price, currency);
    const formattedCNY = cnyPrice.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

    return `<div class="price-cell">
        <div class="cny-price">￥${formattedCNY}</div>
        <div class="original-price">${formattedPrice} ${currency}</div>
    </div>`;
}

function updateTimeDisplay() {
    const updateInfo = document.querySelector('.update-info');
    const date = new Date(DATA_UPDATE_TIME).toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).replace(/\//g, '/');
    updateInfo.textContent = `价格更新时间：${date}`;
}

function showLoading() {
    const tbody = document.getElementById('price-tbody');
    tbody.innerHTML = '<tr><td colspan="7" class="loading"></td></tr>';
}

function handleError(message) {
    const tbody = document.getElementById('price-tbody');
    tbody.innerHTML = `<tr><td colspan="7" style="color: #666; text-align: center; padding: 20px;">${message}</td></tr>`;
}

document.addEventListener('DOMContentLoaded', () => {
    initSortHeaders();
    updateTimeDisplay();
    fetchExchangeRates(); // 尝试获取实时汇率
});