// 在文件开头添加一个全局变量来存储医院名称映射
let hospitalAliasMap = new Map();
// 添加新的映射用于年份特定的曾用名
let yearlyAliasMap = new Map();

// 直接使用 data.js 中定义的 hospitalData
function initYearSelect() {
    const yearSelect = document.getElementById('yearSelect');
    if (!yearSelect) {
        console.error('未找到年份选择器元素');
        return;
    }

    const years = [...new Set(hospitalData.map(item => item.年份))]
        .filter(year => year)
        .sort((a, b) => b - a);

    years.forEach(year => {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year + '年';
        yearSelect.appendChild(option);
    });
}

// 初始化省份选择器
function initProvinceSelect() {
    const provinceSelect = document.getElementById('provinceSelect');
    const yearSelect = document.getElementById('yearSelect');
    if (!provinceSelect) return;

    // 获取当前选择的年份
    const selectedYear = yearSelect.value;
    
    // 根据年份筛选数据
    let filteredData = hospitalData;
    if (selectedYear) {
        filteredData = hospitalData.filter(item => item.年份 == selectedYear);
    }

    // 获取筛选后数据中的省份
    const provinces = [...new Set(filteredData.map(item => item.省份))]
        .filter(province => province)
        .sort();

    // 清空现有选项（除了默认选项）
    while (provinceSelect.options.length > 1) {
        provinceSelect.remove(1);
    }

    provinces.forEach(province => {
        const option = document.createElement('option');
        option.value = province;
        option.textContent = province;
        provinceSelect.appendChild(option);
    });
}

// 更新城市选择器
function updateCitySelect(province) {
    const citySelect = document.getElementById('citySelect');
    const yearSelect = document.getElementById('yearSelect');
    if (!citySelect) return;

    // 清空现有选项（除了默认选项）
    while (citySelect.options.length > 1) {
        citySelect.remove(1);
    }

    if (province) {
        // 获取当前选择的年份
        const selectedYear = yearSelect.value;

        // 根据年份和省份筛选数据
        const cities = [...new Set(
            hospitalData
                .filter(item => selectedYear ? item.年份 == selectedYear : true)
                .filter(item => item.省份 === province)
                .map(item => item.城市)
        )].sort();

        cities.forEach(city => {
            const option = document.createElement('option');
            option.value = city;
            option.textContent = city;
            citySelect.appendChild(option);
        });
    }
}

// 排序状态
let sortConfig = {
    column: null,
    direction: 'asc'
};

// 比较函数
function compareValues(a, b, isAsc = true) {
    // 处理空值
    if (a === '' || a === null || a === undefined) return isAsc ? 1 : -1;
    if (b === '' || b === null || b === undefined) return isAsc ? -1 : 1;
    
    // 数字比较
    if (!isNaN(a) && !isNaN(b)) {
        return isAsc ? a - b : b - a;
    }
    
    // 字符串比较
    return isAsc ? 
        String(a).localeCompare(String(b), 'zh-CN') : 
        String(b).localeCompare(String(a), 'zh-CN');
}

// 添加防抖函数
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// 显示医院列表
function displayHospitals() {
    const year = document.getElementById('yearSelect').value;
    const province = document.getElementById('provinceSelect').value;
    const city = document.getElementById('citySelect').value;
    const searchKeyword = document.getElementById('hospitalSearch').value.trim().toLowerCase();
    
    const hospitalList = document.getElementById('hospitalList');
    if (!hospitalList) return;

    hospitalList.innerHTML = '';
    
    let filteredData = hospitalData;

    // 按关键词筛选
    if (searchKeyword) {
        // 将搜索关键词按空格分割成数组，并去除空字符串
        const keywords = searchKeyword.split(/\s+/).filter(k => k);
        
        // 先找出所有匹配的医院名称
        const matchedHospitals = new Set();
        
        hospitalData.forEach(item => {
            // 检查是否所有关键词都匹配
            const matchesAllKeywords = keywords.every(keyword => {
                // 检查当前名称
                if (item.医院名称.toLowerCase().includes(keyword)) {
                    return true;
                }
                // 检查基本曾用名称
                const baseAliases = hospitalAliasMap.get(item.医院名称) || [];
                if (baseAliases.some(alias => alias.toLowerCase().includes(keyword))) {
                    return true;
                }
                // 检查年份特定的曾用名称
                const yearMap = yearlyAliasMap.get(item.年份);
                if (yearMap) {
                    const yearlyAliases = yearMap.get(item.医院名称) || [];
                    if (yearlyAliases.some(alias => alias.toLowerCase().includes(keyword))) {
                        return true;
                    }
                }
                return false;
            });

            if (matchesAllKeywords) {
                matchedHospitals.add(item.医院名称);
            }
        });

        // 过滤数据，显示所有匹配医院的所有年份记录
        filteredData = filteredData.filter(item => 
            matchedHospitals.has(item.医院名称)
        );
    }

    // 按年份筛选
    if (year) {
        filteredData = filteredData.filter(item => item.年份 == year);
    }

    // 按省份筛选
    if (province) {
        filteredData = filteredData.filter(item => item.省份 === province);
    }

    // 按城市筛选
    if (city) {
        filteredData = filteredData.filter(item => item.城市 === city);
    }

    if (filteredData.length === 0) {
        // 添加空数据提示
        const emptyRow = document.createElement('tr');
        emptyRow.innerHTML = `
            <td colspan="8" class="empty-message">
                没有找到符合条件的医院数据
            </td>
        `;
        hospitalList.appendChild(emptyRow);
    } else {
        // 应用排序
        if (sortConfig.column) {
            const isAsc = sortConfig.direction === 'asc';
            
            filteredData.sort((a, b) => {
                let aValue = a[sortConfig.column];
                let bValue = b[sortConfig.column];

                // 特殊处理2023年的排名
                if (sortConfig.column === '排名' && a.年份 == 2023) {
                    const rankOrder = {'A++++': 1, 'A+++': 2, 'A++': 3, 'A+': 4, 'A': 5};
                    // 获取等级数值
                    const aRank = rankOrder[aValue];
                    const bRank = rankOrder[bValue];
                    
                    if (aRank !== bRank) {
                        // 不同等级，直接比较等级
                        return isAsc ? aRank - bRank : bRank - aRank;
                    } else {
                        // 同等级，查找2022年排名
                        const aHospital = a.医院名称;
                        const bHospital = b.医院名称;
                        
                        const a2022 = hospitalData.find(item => 
                            item.医院名称 === aHospital && item.年份 === 2022
                        );
                        const b2022 = hospitalData.find(item => 
                            item.医院名称 === bHospital && item.年份 === 2022
                        );
                        
                        // 如果都有2022年排名，按2022年排名排序
                        if (a2022 && b2022) {
                            const a2022Rank = Number(a2022.排名);
                            const b2022Rank = Number(b2022.排名);
                            return isAsc ? a2022Rank - b2022Rank : b2022Rank - a2022Rank;
                        }
                        // 如果只有一个有2022年排名，有排名的排在前面
                        else if (a2022) {
                            return isAsc ? -1 : 1;
                        }
                        else if (b2022) {
                            return isAsc ? 1 : -1;
                        }
                        // 都没有2022年排名，按医院名称排序
                        return isAsc ? 
                            aHospital.localeCompare(bHospital, 'zh-CN') : 
                            bHospital.localeCompare(aHospital, 'zh-CN');
                    }
                }

                // 数字类型字段
                if (['专科声誉', '科研学术', '综合得分', '年份'].includes(sortConfig.column)) {
                    // 处理空值
                    if (aValue === '') {
                        return isAsc ? -1 : 1;  // 升序时空值排最前，降序时排最后
                    }
                    if (bValue === '') {
                        return isAsc ? 1 : -1;  // 升序时空值排最前，降序时排最后
                    }
                    aValue = Number(aValue);
                    bValue = Number(bValue);
                }

                return compareValues(aValue, bValue, isAsc);
            });
        } else {
            // 默认按年份降序，排名升序排列
            filteredData.sort((a, b) => {
                const yearCompare = compareValues(b.年份, a.年份); // 年份降序
                if (yearCompare !== 0) return yearCompare;
                
                // 年份相同时按排名升序
                if (a.年份 == 2023) {
                    const rankOrder = {'A++++': 1, 'A+++': 2, 'A++': 3, 'A+': 4, 'A': 5};
                    // 获取等级数值
                    const aRank = rankOrder[a.排名];
                    const bRank = rankOrder[b.排名];
                    
                    if (aRank !== bRank) {
                        return aRank - bRank;
                    } else {
                        // 同等级，查找2022年排名
                        const a2022 = hospitalData.find(item => 
                            item.医院名称 === a.医院名称 && item.年份 === 2022
                        );
                        const b2022 = hospitalData.find(item => 
                            item.医院名称 === b.医院名称 && item.年份 === 2022
                        );
                        
                        if (a2022 && b2022) {
                            return Number(a2022.排名) - Number(b2022.排名);
                        }
                        else if (a2022) return -1;
                        else if (b2022) return 1;
                        return a.医院名称.localeCompare(b.医院名称, 'zh-CN');
                    }
                }
                return Number(a.排名) - Number(b.排名);
            });
        }

        // 优化表格渲染
        const fragment = document.createDocumentFragment();
        filteredData.forEach(hospital => {
            const row = document.createElement('tr');
            // 获取基本曾用名
            const baseAliases = hospitalAliasMap.get(hospital.医院名称) || [];
            // 获取年份特定的曾用名
            const yearMap = yearlyAliasMap.get(hospital.年份);
            const yearlyAliases = yearMap ? yearMap.get(hospital.医院名称) || [] : [];
            
            // 如果有年份特定的曾用名，使用它，否则使用基本曾用名
            const aliases = yearlyAliases.length > 0 ? yearlyAliases : baseAliases;
            const aliasesText = aliases.length > 0 ? `\n曾用名称：${aliases.join('、')}` : '';
            
            row.innerHTML = `
                <td>${hospital.年份}</td>
                <td>${hospital.排名}</td>
                <td title="${hospital.医院名称}${aliasesText}">${hospital.医院名称}</td>
                <td>${formatNumber(hospital.专科声誉)}</td>
                <td>${formatNumber(hospital.科研学术)}</td>
                <td>${formatNumber(hospital.综合得分)}</td>
                <td>${hospital.省份}</td>
                <td>${hospital.城市}</td>
            `;
            fragment.appendChild(row);
        });
        hospitalList.appendChild(fragment);
    }
}

// 处理表头点击排序
function handleSort(e) {
    const th = e.target.closest('th');
    if (!th) return;

    const column = th.dataset.sort;
    
    // 更新排序图标
    document.querySelectorAll('th').forEach(header => {
        header.classList.remove('sort-asc', 'sort-desc');
    });

    if (sortConfig.column === column) {
        // 切换排序方向
        sortConfig.direction = sortConfig.direction === 'asc' ? 'desc' : 'asc';
    } else {
        // 新的排序列
        sortConfig.column = column;
        sortConfig.direction = 'asc';
    }

    // 添加排序图标
    th.classList.add(`sort-${sortConfig.direction}`);

    // 重新显示数据
    displayHospitals();
}

// 绘制排名趋势图
function drawRankingTrend(hospitalName) {
    const chart = echarts.init(document.getElementById('rankingTrend'));
    
    // 获取年份范围
    const years = [...new Set(hospitalData.map(item => item.年份))].sort();
    
    // 准备数据
    const data = years.map(year => {
        const record = hospitalData.find(item => 
            item.医院名称 === hospitalName && item.年份 === year
        );
        if (!record) return null;
        // 2023年特殊处理
        if (year === 2023) {
            const rankMap = {
                'A++++': '1-20', 
                'A+++': '21-40', 
                'A++': '41-60', 
                'A+': '61-80', 
                'A': '81-100'
            };
            return rankMap[record.排名] || null;
        }
        return record.排名;
    });

    const series = [{
        name: hospitalName,
        type: 'line',
        data: data,
        connectNulls: true,
        symbol: 'circle',
        symbolSize: 8,
        label: {
            show: true,
            formatter: function(params) {
                return params.value;
            }
        }
    }];

    const option = {
        title: {
            text: `${hospitalName}排名趋势`,
            left: 'center'
        },
        tooltip: {
            trigger: 'axis',
            backgroundColor: 'rgba(50, 50, 50, 0.9)',
            borderWidth: 0,
            textStyle: {
                color: '#fff'
            },
            formatter: function(params) {
                return params.map(param => {
                    const year = years[param.dataIndex];
                    let rank = param.value;
                    return `${param.seriesName}<br/>
                            ${year}年: ${rank}`;
                }).join('<br/>');
            }
        },
        legend: {
            type: 'scroll',
            orient: 'horizontal',
            bottom: 0
        },
        grid: {
            left: '3%',
            right: '4%',
            bottom: '15%',
            containLabel: true
        },
        xAxis: {
            type: 'category',
            data: years,
            name: '年份'
        },
        yAxis: {
            type: 'value',
            name: '排名',
            inverse: true,
            minInterval: 1,  // 最小间隔为1，确保只显示整数
            axisLabel: {
                formatter: function(value) {
                    return Math.floor(value);  // 确保显示整数
                }
            }
        },
        series: series
    };

    chart.setOption(option);
}

// 主函数
function init() {
    // 初始化医院别名映射
    initHospitalAliasMap();
    
    // 添加错误处理
    try {
        initYearSelect();
        initProvinceSelect();
        // 初始显示数据
        displayHospitals();
    } catch (error) {
        console.error('初始化失败:', error);
        // 在表格中显示错误信息
        const hospitalList = document.getElementById('hospitalList');
        if (hospitalList) {
            const errorRow = document.createElement('tr');
            errorRow.innerHTML = `
                <td colspan="8" class="error-message-row">
                    系统初始化失败，请刷新页面重试
                </td>
            `;
            hospitalList.appendChild(errorRow);
        }
    }
    
    // 监听年份选择变化
    document.getElementById('yearSelect').addEventListener('change', () => {
        // 重新初始化省份选择器
        initProvinceSelect();
        // 清空城市选择
        document.getElementById('citySelect').selectedIndex = 0;
        // 更新显示
        displayHospitals();
    });

    // 监听省份选择变化
    const provinceSelect = document.getElementById('provinceSelect');
    provinceSelect.addEventListener('change', (e) => {
        updateCitySelect(e.target.value);
        displayHospitals();
    });

    // 监听城市选择变化
    document.getElementById('citySelect').addEventListener('change', displayHospitals);

    // 添加表头排序事件监听
    document.querySelector('thead').addEventListener('click', handleSort);
    
    // 添加医院名称点击事件
    document.getElementById('hospitalList').addEventListener('click', (e) => {
        const cell = e.target.closest('td');
        if (!cell) return;

        if (cell.cellIndex === 2) { // 医院名称列
            const hospitalName = cell.textContent;
            document.querySelector('.charts-container').style.display = 'block';
            drawRankingTrend(hospitalName);
            document.querySelector('.charts-container').scrollIntoView({ behavior: 'smooth' });
        } else if (cell.cellIndex === 6 || cell.cellIndex === 7) { // 省份或城市列
            showLocationStats(e);
        }
    });

    // 添加鼠标移入移出事件
    document.getElementById('hospitalList').addEventListener('mouseover', (e) => {
        const cell = e.target.closest('td');
        if (cell && (cell.cellIndex === 6 || cell.cellIndex === 7)) {
            showLocationStats(e);
        }
    });

    document.getElementById('hospitalList').addEventListener('mouseout', (e) => {
        const cell = e.target.closest('td');
        if (cell && (cell.cellIndex === 6 || cell.cellIndex === 7)) {
            hideLocationStats();
        }
    });

    // 优化窗口resize事件
    window.addEventListener('resize', debounce(() => {
        const rankingChart = echarts.getInstanceByDom(document.getElementById('rankingTrend'));
        if (rankingChart) rankingChart.resize();
    }, 250));

    // 添加搜索框事件监听
    document.getElementById('hospitalSearch').addEventListener('input', debounce(() => {
        displayHospitals();
    }, 300));
}

// 确保DOM加载完成后再执行初始化
document.addEventListener('DOMContentLoaded', init);

// 添加数字格式化函数
function formatNumber(value) {
    if (value === '' || value === null || value === undefined) return '-';
    if (typeof value === 'number') {
        return value.toFixed(2).replace(/\.?0+$/, '');
    }
    return value;
}

// 显示位置统计信息
function showLocationStats(e) {
    const cell = e.target.closest('td');
    if (!cell) return;

    // 获取当前行的年份
    const row = cell.closest('tr');
    const rowYear = row.cells[0].textContent;

    const isProvince = cell.cellIndex === 6;
    const location = cell.textContent;
    const yearData = hospitalData.filter(item => item.年份 == rowYear);
    
    let count;
    let tooltip = document.querySelector('.stats-tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.className = 'stats-tooltip';
        document.body.appendChild(tooltip);
    }

    if (isProvince) {
        count = yearData.filter(item => item.省份 === location).length;
        tooltip.textContent = `${rowYear} 年 ${location} 有 ${count} 家上榜医院`;
    } else {
        count = yearData.filter(item => item.城市 === location).length;
        tooltip.textContent = `${rowYear} 年 ${location} 有 ${count} 家上榜医院`;
    }

    // 设置提示框位置
    const rect = cell.getBoundingClientRect();
    tooltip.style.left = rect.left + 'px';
    tooltip.style.top = (rect.bottom + 5) + 'px';
    tooltip.style.opacity = '1';
}

// 隐藏统计信息
function hideLocationStats() {
    const tooltip = document.querySelector('.stats-tooltip');
    if (tooltip) {
        tooltip.style.opacity = '0';
    }
}

// 添加初始化医院别名映射的函数
function initHospitalAliasMap() {
    // 保持原有的初始化逻辑
    hospitalData.forEach(hospital => {
        if (hospital.曾用名称) {
            const aliases = hospital.曾用名称.split('、').filter(name => name.trim());
            hospitalAliasMap.set(hospital.医院名称, aliases);
        }
    });

    // 添加年份特定的曾用名初始化
    hospitalData.forEach(hospital => {
        const year = hospital.年份;
        if (!yearlyAliasMap.has(year)) {
            yearlyAliasMap.set(year, new Map());
        }
        const yearMap = yearlyAliasMap.get(year);
        
        if (hospital.曾用名称) {
            const aliases = hospital.曾用名称.split('、').filter(name => name.trim());
            yearMap.set(hospital.医院名称, aliases);
        }
    });
} 