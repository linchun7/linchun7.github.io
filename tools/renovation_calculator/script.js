// 错误信息配置
const errorMessages = {
    loanAmount: '贷款金额必须大于 0，请重新输入',
    loanTerm: '贷款期限必须是 1-600 之间的整数，请重新输入',
    serviceFee: '月手续费率必须大于等于 0，请重新输入',
    irrDiverge: '计算结果异常，请检查输入的数据是否合理'
};

// 警告信息配置
const warningMessages = {
    loanAmountTooSmall: '当前贷款金额较小，计算结果可能存在误差',
    loanAmountTooLarge: '当前贷款金额较大，建议分多笔贷款办理',
    serviceFeeTooSmall: '当前月手续费率偏低，请确认是否准确',
    serviceFeeTooLarge: '当前月手续费率偏高，请确认是否准确'
};

const numberUtils = {
    toFixed2: (num) => Math.round((num + Number.EPSILON) * 100) / 100,
    formatMoney: (amount) => new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(numberUtils.toFixed2(amount)),
    formatPercent: (value) => numberUtils.toFixed2(value).toFixed(2)
};

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
        const amountRaw = document.getElementById('loanAmount').value.trim();
        const termRaw = document.getElementById('loanTerm').value.trim();
        const feeRaw = document.getElementById('serviceFee').value.trim();
        const amountNumber = Number(amountRaw);
        const inputs = {
            loanAmount: Number.isFinite(amountNumber) ? numberUtils.toFixed2(amountNumber) : NaN,
            loanTerm: Number(termRaw),
            serviceFeeRate: Number(feeRaw)
        };

        ['loanAmount', 'loanTerm', 'serviceFee'].forEach(id => {
            this.clearError(id);
            this.clearWarning(id);
        });

        if (!amountRaw || !Number.isFinite(inputs.loanAmount) || inputs.loanAmount <= 0) {
            this.showError('loanAmount', errorMessages.loanAmount);
            isValid = false;
        } else if (inputs.loanAmount < 1000) {
            this.showWarning('loanAmount', warningMessages.loanAmountTooSmall);
        } else if (inputs.loanAmount > 10000000) {
            this.showWarning('loanAmount', warningMessages.loanAmountTooLarge);
        }

        if (!termRaw || !Number.isInteger(inputs.loanTerm) || inputs.loanTerm <= 0 || inputs.loanTerm > 600) {
            this.showError('loanTerm', errorMessages.loanTerm);
            isValid = false;
        }

        if (!feeRaw || !Number.isFinite(inputs.serviceFeeRate) || inputs.serviceFeeRate < 0) {
            this.showError('serviceFee', errorMessages.serviceFee);
            isValid = false;
        } else if (inputs.serviceFeeRate > 0 && inputs.serviceFeeRate < 0.01) {
            this.showWarning('serviceFee', warningMessages.serviceFeeTooSmall);
        } else if (inputs.serviceFeeRate > 100) {
            this.showWarning('serviceFee', warningMessages.serviceFeeTooLarge);
        }

        return isValid ? inputs : null;
    }
};

// Horner 形式与逐项折现数学等价，但避免在每个现金流上重复调用 Math.pow。
function npv(cashFlows, rate) {
    const divisor = 1 + rate;
    let total = cashFlows[cashFlows.length - 1];
    for (let i = cashFlows.length - 2; i >= 0; i--) {
        total = cashFlows[i] + total / divisor;
    }
    return total;
}

// 本工具现金流固定为“首期一笔借款、后续均为还款”，NPV 对非负利率单调递减。
// 使用带动态上界的二分法，比牛顿法更稳定，也更容易验证。
function IRR(cashFlows) {
    if (!Array.isArray(cashFlows) || cashFlows.length < 2) return NaN;

    const maxAbsFlow = Math.max(...cashFlows.map(flow => Math.abs(flow)));
    if (!Number.isFinite(maxAbsFlow) || maxAbsFlow === 0) return NaN;

    const normalizedFlows = cashFlows.map(flow => flow / maxAbsFlow);
    const tolerance = 1e-12;
    const atZero = npv(normalizedFlows, 0);

    if (Math.abs(atZero) <= tolerance) return 0;
    if (atZero < 0) return NaN;

    let left = 0;
    let right = 0.01;
    while (npv(normalizedFlows, right) > 0 && right < 1024) {
        right *= 2;
    }

    if (npv(normalizedFlows, right) > 0) return NaN;

    for (let i = 0; i < 120; i++) {
        const mid = (left + right) / 2;
        const value = npv(normalizedFlows, mid);

        if (Math.abs(value) <= tolerance || right - left <= tolerance) {
            return mid;
        }

        if (value > 0) left = mid;
        else right = mid;
    }

    return (left + right) / 2;
}

function annualizeMonthlyIRR(monthlyRate) {
    if (!Number.isFinite(monthlyRate) || monthlyRate <= -1) return NaN;
    return (Math.pow(1 + monthlyRate, 12) - 1) * 100;
}

function exportToCSV(schedule, totals) {
    const BOM = '\uFEFF';
    const headers = ['期数', '月还款总额', '应还本金', '手续费', '剩余本金', '累计已还本金', '当期手续费折年（单利）', '提前还款年化利率（复利IRR）'];
    let csvContent = BOM + headers.join(',') + '\n';

    schedule.forEach(row => {
        const rowData = [
            row.month,
            `"¥${numberUtils.formatMoney(row.payment)}"`,
            `"¥${numberUtils.formatMoney(row.principal)}"`,
            `"¥${numberUtils.formatMoney(row.serviceFee)}"`,
            `"¥${numberUtils.formatMoney(row.remainingPrincipal)}"`,
            `"¥${numberUtils.formatMoney(row.totalPaidPrincipal)}"`,
            `"${numberUtils.formatPercent(row.annualizedFeeRate)}%"`,
            `"${numberUtils.formatPercent(row.earlyRepaymentAPR)}%"`
        ];
        csvContent += rowData.join(',') + '\n';
    });

    csvContent += [
        '总计',
        `"¥${numberUtils.formatMoney(totals.totalPayment)}"`,
        `"¥${numberUtils.formatMoney(totals.totalPrincipal)}"`,
        `"¥${numberUtils.formatMoney(totals.totalServiceFee)}"`,
        '-', '-', '-', '-'
    ].join(',') + '\n';

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '装修贷款还款明细表.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
}

function renderTable(schedule, totals, apr) {
    return `
        <div class="summary-grid">
            <div class="summary-card">
                <div>实际年化利率（复利 IRR）</div>
                <div>${numberUtils.formatPercent(apr)}%</div>
            </div>
            <div class="summary-card">
                <div>首月还款总额</div>
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
            <h3 class="table-title">装修贷款还款明细表 - <a href="#" onclick="window.lastExportData && exportToCSV(window.lastExportData.schedule, window.lastExportData.totals); return false;" class="export-link">导出</a></h3>
            <table>
                <thead>
                    <tr>
                        <th>期数</th>
                        <th>月还款总额</th>
                        <th>应还本金</th>
                        <th>手续费</th>
                        <th>剩余本金</th>
                        <th>累计已还本金</th>
                        <th>当期手续费折年（单利）</th>
                        <th>提前还款年化利率（复利 IRR）</th>
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
                            <td>${numberUtils.formatPercent(row.annualizedFeeRate)}%</td>
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
                <button class="export-btn" onclick="window.lastExportData && exportToCSV(window.lastExportData.schedule, window.lastExportData.totals)">导出还款明细表</button>
            </div>
        </div>
    `;
}

function generateSchedule(inputs) {
    const schedule = [];
    const monthlyFee = numberUtils.toFixed2(inputs.loanAmount * inputs.serviceFeeRate / 100);
    let totalPaidPrincipal = 0;

    for (let month = 1; month <= inputs.loanTerm; month++) {
        const openingPrincipal = Math.max(0, numberUtils.toFixed2(inputs.loanAmount - totalPaidPrincipal));
        // 按累计目标分摊本金，而不是固定四舍五入后的“月本金”，避免长周期尾期出现负本金。
        const targetPaidPrincipal = month === inputs.loanTerm
            ? inputs.loanAmount
            : numberUtils.toFixed2(inputs.loanAmount * month / inputs.loanTerm);
        const principal = Math.max(0, numberUtils.toFixed2(targetPaidPrincipal - totalPaidPrincipal));
        const payment = numberUtils.toFixed2(principal + monthlyFee);

        totalPaidPrincipal = numberUtils.toFixed2(totalPaidPrincipal + principal);
        const remainingPrincipal = Math.max(0, numberUtils.toFixed2(inputs.loanAmount - totalPaidPrincipal));
        const annualizedFeeRate = openingPrincipal > 0
            ? monthlyFee * 12 / openingPrincipal * 100
            : 0;

        schedule.push({
            month,
            payment,
            principal,
            serviceFee: monthlyFee,
            remainingPrincipal,
            totalPaidPrincipal,
            annualizedFeeRate,
            earlyRepaymentAPR: 0
        });
    }

    // 用页面真实展示的逐期还款额构造现金流，包含逐期分厘修正。
    const totalCashFlows = [-inputs.loanAmount, ...schedule.map(row => row.payment)];
    const monthlyRate = IRR(totalCashFlows);
    const apr = annualizeMonthlyIRR(monthlyRate);
    if (!Number.isFinite(apr)) throw new Error(errorMessages.irrDiverge);

    schedule.forEach((row, index) => {
        if (index === schedule.length - 1) {
            row.earlyRepaymentAPR = apr;
            return;
        }

        const cashFlows = [-inputs.loanAmount];
        for (let i = 0; i < index; i++) {
            cashFlows.push(schedule[i].payment);
        }
        cashFlows.push(numberUtils.toFixed2(row.payment + row.remainingPrincipal));

        const earlyMonthlyRate = IRR(cashFlows);
        const earlyAnnualRate = annualizeMonthlyIRR(earlyMonthlyRate);
        if (!Number.isFinite(earlyAnnualRate)) throw new Error(errorMessages.irrDiverge);
        row.earlyRepaymentAPR = earlyAnnualRate;
    });

    const totals = schedule.reduce((acc, row) => ({
        totalPayment: numberUtils.toFixed2(acc.totalPayment + row.payment),
        totalPrincipal: numberUtils.toFixed2(acc.totalPrincipal + row.principal),
        totalServiceFee: numberUtils.toFixed2(acc.totalServiceFee + row.serviceFee)
    }), {
        totalPayment: 0,
        totalPrincipal: 0,
        totalServiceFee: 0
    });

    return { schedule, apr, totals };
}

document.addEventListener('DOMContentLoaded', () => {
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

    [
        { container: '.quick-amounts', inputId: 'loanAmount' },
        { container: '.quick-terms', inputId: 'loanTerm' },
        { container: '.quick-fees', inputId: 'serviceFee' }
    ].forEach(({ container, inputId }) => {
        setupQuickSelectButtons(document.querySelector(container), inputId);
    });

    const inputIds = ['loanAmount', 'loanTerm', 'serviceFee'];
    inputIds.forEach((inputId, index) => {
        document.getElementById(inputId).addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (index < inputIds.length - 1) {
                document.getElementById(inputIds[index + 1]).focus();
            } else {
                document.getElementById('calculateBtn').click();
            }
        });
    });

    document.getElementById('calculateBtn').addEventListener('click', () => {
        const resultElement = document.getElementById('result');
        resultElement.innerHTML = '';
        resultElement.classList.remove('show');
        const inputs = validationUtils.validateInputs();
        if (!inputs) return;

        try {
            const result = generateSchedule(inputs);
            window.lastExportData = result;
            resultElement.innerHTML = renderTable(result.schedule, result.totals, result.apr);
            resultElement.classList.add('show');
        } catch (error) {
            resultElement.innerHTML = `<div class="empty-placeholder">${error instanceof Error ? error.message : errorMessages.irrDiverge}</div>`;
            resultElement.classList.add('show');
        }
    });
});
