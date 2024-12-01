// 错误信息配置
const errorMessages = {
    loanAmount: '贷款金额必须大于 0，请重新输入',
    loanTerm: '贷款期限必须是 0-600 之间的整数，请重新输入',
    serviceFee: '月手续费率必须大于 0，请重新输入',
    irrDiverge: '计算结果异常，请检查输入的数据是否合理'
};

// 警告信息配置
const warningMessages = {
    loanAmountTooSmall: '当前贷款金额较小，计算结果可能存在误差',
    loanAmountTooLarge: '当前贷款金额较大，建议分多笔贷款办理',
    serviceFeeTooSmall: '当前月手续费率偏低，请确认是否准确',
    serviceFeeTooLarge: '当前月手续费率偏高，请确认是否准确'
};

// 合并后的数值处理工具函数
const numberUtils = {
    // 转换为2位小数的数字
    toFixed2: (num) => {
        return Math.round(num * 100) / 100;
    },
    
    // 移除千分位分隔符并转为数字
    parseAmount: (str) => {
        return Number(String(str).replace(/,/g, ''));
    },

    // 金额格式化函数
    formatMoney: (amount) => {
        return new Intl.NumberFormat('zh-CN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(numberUtils.toFixed2(amount));
    },

    // 格式化百分比
    formatPercent: (value) => {
        return numberUtils.toFixed2(value).toFixed(2);
    }
};

// 验证和错误处理工具函数
const validationUtils = {
    showError: (elementId, message) => {
        const errorEl = document.getElementById(elementId + 'Error');
        errorEl.textContent = message;
        errorEl.classList.add('show');
    },

    clearError: (elementId) => {
        const errorEl = document.getElementById(elementId + 'Error');
        errorEl.textContent = '';
        errorEl.classList.remove('show');
    },

    showWarning: (elementId, message) => {
        const warningEl = document.getElementById(elementId + 'Warning');
        warningEl.textContent = message;
        warningEl.classList.add('show');
    },

    clearWarning: (elementId) => {
        const warningEl = document.getElementById(elementId + 'Warning');
        if (warningEl) {
            warningEl.textContent = '';
            warningEl.classList.remove('show');
        }
    },

    validateInputs() {
        let isValid = true;
        const inputs = {
            loanAmount: Number(document.getElementById('loanAmount').value),
            loanTerm: Number(document.getElementById('loanTerm').value),
            serviceFeeRate: Number(document.getElementById('serviceFee').value)
        };

        // 清除所有错误和警告信息
        ['loanAmount', 'loanTerm', 'serviceFee'].forEach(id => {
            this.clearError(id);
            this.clearWarning(id);
        });

        // 验证贷款金额
        if (!inputs.loanAmount || inputs.loanAmount <= 0) {
            this.showError('loanAmount', errorMessages.loanAmount);
            isValid = false;
        } else {
            if (inputs.loanAmount < 1000) {
                this.showWarning('loanAmount', warningMessages.loanAmountTooSmall);
            } else if (inputs.loanAmount > 10000000) {
                this.showWarning('loanAmount', warningMessages.loanAmountTooLarge);
            }
        }

        // 验证贷款期限
        if (!Number.isInteger(inputs.loanTerm) || inputs.loanTerm <= 0 || inputs.loanTerm > 600) {
            this.showError('loanTerm', errorMessages.loanTerm);
            isValid = false;
        }

        // 验证月手续费率
        if (!inputs.serviceFeeRate || inputs.serviceFeeRate <= 0) {
            this.showError('serviceFee', errorMessages.serviceFee);
            isValid = false;
        } else {
            if (inputs.serviceFeeRate > 0 && inputs.serviceFeeRate < 0.01) {
                this.showWarning('serviceFee', warningMessages.serviceFeeTooSmall);
            } else if (inputs.serviceFeeRate > 100) {
                this.showWarning('serviceFee', warningMessages.serviceFeeTooLarge);
            }
        }

        return isValid ? inputs : null;
    }
};

// 改进的IRR计算函数
function IRR(cashFlows, apr = null) {
    if (!cashFlows?.length) return NaN;

    // 归一化现金流
    const maxAbsFlow = Math.abs(Math.max(...cashFlows.map(x => Math.abs(x))));
    const normalizedFlows = cashFlows.map(flow => flow / maxAbsFlow);

    // 牛顿法
    let irr = apr ? apr/1200 : 0.1;
    const maxNewtonIterations = 50;
    const tolerance = 1e-10;

    for (let i = 0; i < maxNewtonIterations; i++) {
        let npv = 0;
        let derivativeNpv = 0;

        for (let j = 0; j < normalizedFlows.length; j++) {
            const factor = Math.pow(1 + irr, j);
            npv += normalizedFlows[j] / factor;
            if (j > 0) {
                derivativeNpv -= j * normalizedFlows[j] / (factor * (1 + irr));
            }
        }

        if (Math.abs(npv) < tolerance) {
            return irr;
        }

        const adjustment = npv / derivativeNpv;
        irr -= adjustment;

        if (Math.abs(adjustment) < tolerance) {
            return irr;
        }
    }

    // 如果牛顿法未收敛，使用二分法
    let left = 0;
    let right = 1;
    const maxBisectionIterations = 100;

    for (let i = 0; i < maxBisectionIterations; i++) {
        const mid = (left + right) / 2;
        let npv = 0;

        for (let j = 0; j < normalizedFlows.length; j++) {
            npv += normalizedFlows[j] / Math.pow(1 + mid, j);
        }

        if (Math.abs(npv) < tolerance) {
            return mid;
        }

        if (npv > 0) {
            left = mid;
        } else {
            right = mid;
        }

        if (right - left < tolerance) {
            return mid;
        }
    }

    console.error(errorMessages.irrDiverge);
    return NaN;
}

// CSV导出功能
function exportToCSV(schedule, totals, apr) {
    // 添加BOM以支持中文
    const BOM = '\uFEFF';
    
    // 准备CSV内容
    const headers = ['期数', '月还款总额', '应还本金', '手续费', '剩余本金', '累计已还本金', '当期年利率', '提前还款年利率'];
    
    let csvContent = BOM + headers.join(',') + '\n';
    
    // 添加数据行
    schedule.forEach(row => {
        const rowData = [
            row.month,
            `"¥${numberUtils.formatMoney(row.payment)}"`,
            `"¥${numberUtils.formatMoney(row.principal)}"`,
            `"¥${numberUtils.formatMoney(row.serviceFee)}"`,
            `"¥${numberUtils.formatMoney(row.remainingPrincipal)}"`,
            `"¥${numberUtils.formatMoney(row.totalPaidPrincipal)}"`,
            `"${numberUtils.formatPercent(row.currentAPR)}%"`,
            `"${numberUtils.formatPercent(row.earlyRepaymentAPR)}%"`
        ];
        csvContent += rowData.join(',') + '\n';
    });

    // 添加合计行
    const totalRow = [
        '总计',
        `"¥${numberUtils.formatMoney(totals.totalPayment)}"`,
        `"¥${numberUtils.formatMoney(totals.totalPrincipal)}"`,
        `"¥${numberUtils.formatMoney(totals.totalServiceFee)}"`,
        '-',
        '-',
        '-',
        '-'
    ];
    csvContent += totalRow.join(',') + '\n';

    // 创建下载链接
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', '装修贷款还款明细表.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// 表格渲染函数
function renderTable(schedule, totals, apr) {
    return `
        <div class="summary-grid">
            <div class="summary-card">
                <div>实际年化利率</div>
                <div>${numberUtils.formatPercent(apr)}%</div>
            </div>
            <div class="summary-card">
                <div>月还款总额</div>
                <div>￥${numberUtils.formatMoney(schedule[0].payment)}</div>
            </div>
            <div class="summary-card">
                <div>总还款金额</div>
                <div>￥${numberUtils.formatMoney(totals.totalPayment)}</div>
            </div>
            <div class="summary-card">
                <div>总手续费</div>
                <div>￥${numberUtils.formatMoney(totals.totalServiceFee)}</div>
            </div>
        </div>
        <div class="table-container">
            <h3 class="table-title">装修贷款还款明细表 - <a href="#" onclick="window.lastExportData && exportToCSV(window.lastExportData.schedule, window.lastExportData.totals, window.lastExportData.apr); return false;" class="export-link">导出</a></h3>
            <table>
                <thead>
                    <tr>
                        <th>期数</th>
                        <th>月还款总额</th>
                        <th>应还本金</th>
                        <th>手续费</th>
                        <th>剩余本金</th>
                        <th>累计已还本金</th>
                        <th>当期年利率</th>
                        <th>提前还款年利率</th>
                    </tr>
                </thead>
                <tbody>
                    ${schedule.map(row => `
                        <tr>
                            <td>${row.month}</td>
                            <td>￥${numberUtils.formatMoney(row.payment)}</td>
                            <td>￥${numberUtils.formatMoney(row.principal)}</td>
                            <td>￥${numberUtils.formatMoney(row.serviceFee)}</td>
                            <td>￥${numberUtils.formatMoney(row.remainingPrincipal)}</td>
                            <td>￥${numberUtils.formatMoney(row.totalPaidPrincipal)}</td>
                            <td>${numberUtils.formatPercent(row.currentAPR)}%</td>
                            <td>${numberUtils.formatPercent(row.earlyRepaymentAPR)}%</td>
                        </tr>
                    `).join('')}
                    <tr>
                        <td>总计</td>
                        <td>￥${numberUtils.formatMoney(totals.totalPayment)}</td>
                        <td>￥${numberUtils.formatMoney(totals.totalPrincipal)}</td>
                        <td>￥${numberUtils.formatMoney(totals.totalServiceFee)}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                    </tr>
                </tbody>
            </table>
            <div class="export-btn-container">
                <button class="export-btn" onclick="window.lastExportData && exportToCSV(window.lastExportData.schedule, window.lastExportData.totals, window.lastExportData.apr)">导出还款明细表</button>
            </div>
        </div>
    `;
}

// 生成还款计划表
function generateSchedule(inputs) {
    const schedule = [];
    const monthlyPrincipal = numberUtils.toFixed2(inputs.loanAmount / inputs.loanTerm);
    const monthlyFee = numberUtils.toFixed2(inputs.loanAmount * inputs.serviceFeeRate / 100);

    let totalPaidPrincipal = 0;
    const totalPrincipalToRepay = inputs.loanAmount;
    let lastRemainingPrincipal = totalPrincipalToRepay;

    // 计算总体实际年化利率
    const totalCashFlows = [-inputs.loanAmount];
    for (let i = 0; i < inputs.loanTerm; i++) {
        totalCashFlows.push(monthlyPrincipal + monthlyFee);
    }
    const monthlyRate = IRR(totalCashFlows);
    const apr = monthlyRate * 12 * 100;

    for (let month = 1; month <= inputs.loanTerm; month++) {
        const principal = month === inputs.loanTerm ? 
            numberUtils.toFixed2(totalPrincipalToRepay - totalPaidPrincipal) : 
            monthlyPrincipal;
        
        const payment = numberUtils.toFixed2(principal + monthlyFee);

        totalPaidPrincipal = numberUtils.parseAmount(numberUtils.formatMoney(totalPaidPrincipal + principal));
        const remainingPrincipal = numberUtils.parseAmount(numberUtils.formatMoney(totalPrincipalToRepay - totalPaidPrincipal));

        const currentAPR = numberUtils.toFixed2(monthlyFee * 12 / (month === 1 ? totalPrincipalToRepay : numberUtils.parseAmount(numberUtils.formatMoney(lastRemainingPrincipal))) * 100);
        
        let earlyRepaymentAPR;
        
        if (month === inputs.loanTerm) {
            earlyRepaymentAPR = apr;
        } else {
            // 构造提前还款的现金流
            const cashFlows = [-inputs.loanAmount];  // 第0期是借款金额的负值
            
            // 添加正常还款期的现金流
            for (let i = 0; i < month - 1; i++) {
                cashFlows.push(monthlyPrincipal + monthlyFee);
            }
            
            // 最后一期合并当期还款和提前还款金额
            cashFlows.push(monthlyPrincipal + monthlyFee + remainingPrincipal);
            
            const monthlyIRR = IRR(cashFlows, apr);
            earlyRepaymentAPR = monthlyIRR ? numberUtils.toFixed2(monthlyIRR * 12 * 100) : 0;
        }

        schedule.push({
            month,
            payment,
            principal,
            serviceFee: monthlyFee,
            remainingPrincipal: Math.max(0, remainingPrincipal),
            totalPaidPrincipal,
            currentAPR,
            earlyRepaymentAPR
        });

        lastRemainingPrincipal = remainingPrincipal;
    }

    // 优化统计计算
    const totals = schedule.reduce((acc, row) => ({
        totalPayment: acc.totalPayment + numberUtils.parseAmount(numberUtils.formatMoney(row.payment)),
        totalPrincipal: acc.totalPrincipal + numberUtils.parseAmount(numberUtils.formatMoney(row.principal)),
        totalServiceFee: acc.totalServiceFee + numberUtils.parseAmount(numberUtils.formatMoney(row.serviceFee))
    }), {
        totalPayment: 0,
        totalPrincipal: 0,
        totalServiceFee: 0
    });

    return {schedule, apr, totals};
}

// DOM加载完成后初始化事件监听
document.addEventListener('DOMContentLoaded', () => {
    // 统一处理快速选择按钮点击事件
    const setupQuickSelectButtons = (container, inputId) => {
        container.addEventListener('click', e => {
            const button = e.target.closest('[data-value]');
            if (!button) return;

            const input = document.getElementById(inputId);
            input.value = button.dataset.value;

            container.querySelectorAll('[data-value]').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
        });

        const input = document.getElementById(inputId);
        input.addEventListener('input', () => {
            const currentValue = input.value;
            container.querySelectorAll('[data-value]').forEach(btn => {
                btn.classList[btn.dataset.value === currentValue ? 'add' : 'remove']('active');
            });
        });
    };

    // 初始化所有快速选择按钮
    const quickSelectFields = [
        {container: '.quick-amounts', inputId: 'loanAmount'},
        {container: '.quick-terms', inputId: 'loanTerm'},
        {container: '.quick-fees', inputId: 'serviceFee'}
    ];

    quickSelectFields.forEach(({container, inputId}) => {
        setupQuickSelectButtons(document.querySelector(container), inputId);
    });

    // 添加输入框焦点管理和回车事件处理
    const inputs = ['loanAmount', 'loanTerm', 'serviceFee'];
    
    // 设置初始焦点
    document.getElementById('loanAmount').focus();
    
    // 为每个输入框添加回车键处理
    inputs.forEach((inputId, index) => {
        document.getElementById(inputId).addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (index < inputs.length - 1) {
                    // 如果不是最后一个输入框，焦点移到下一个
                    document.getElementById(inputs[index + 1]).focus();
                } else {
                    // 如果是最后一个输入框，触发计算
                    document.getElementById('calculateBtn').click();
                }
            }
        });
    });

    // 计算按钮点击事件处理
    document.getElementById('calculateBtn').addEventListener('click', () => {
        document.getElementById('result').innerHTML = '';
        document.getElementById('result').classList.remove('show');
        const inputs = validationUtils.validateInputs();
        if (!inputs) return;
       
        const result = generateSchedule(inputs);
        // 保存数据用于导出
        window.lastExportData = result;
        
        document.getElementById('result').innerHTML = renderTable(result.schedule, result.totals, result.apr);
        document.getElementById('result').classList.add('show');
    });
}); 