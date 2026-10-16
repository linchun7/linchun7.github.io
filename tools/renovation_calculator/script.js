// Numerical behavior lives in the DOM-free core; retain these names for existing page callers.
const { roundMoney, npv, IRR, annualizeMonthlyIRR, generateSchedule } = RenovationCore;

// 错误信息配置
const errorMessages = {
    loanAmount: '贷款金额必须大于 0，请重新输入',
    loanTerm: '贷款期限必须是 1-600 之间的整数，请重新输入',
    serviceFee: '月手续费率必须大于等于 0，请重新输入',
    irrDiverge: RenovationCore.CALCULATION_ERROR_MESSAGE
};

// 警告信息配置
const warningMessages = {
    loanAmountTooSmall: '当前贷款金额较小，计算结果可能存在误差',
    loanAmountTooLarge: '当前贷款金额较大，建议分多笔贷款办理',
    serviceFeeTooSmall: '当前月手续费率偏低，请确认是否准确',
    serviceFeeTooLarge: '当前月手续费率偏高，请确认是否准确'
};

// Locale and precision are fixed for every monetary display and CSV cell.
const moneyFormatter = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

const numberUtils = {
    toFixed2: (num) => roundMoney(num),
    formatMoney: (amount) => moneyFormatter.format(numberUtils.toFixed2(amount)),
    formatPercent: (value) => numberUtils.toFixed2(value).toFixed(2),
    formatFeeRate: (value) => value === null ? '—' : `${numberUtils.formatPercent(value)}%`
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
            `"${numberUtils.formatFeeRate(row.annualizedFeeRate)}"`,
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
                            <td>${numberUtils.formatFeeRate(row.annualizedFeeRate)}</td>
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

document.addEventListener('DOMContentLoaded', () => {
    const invalidateResult = () => {
        window.lastExportData = null;
        const resultElement = document.getElementById('result');
        resultElement.innerHTML = '<div class="empty-placeholder">参数已修改，请重新计算。</div>';
        resultElement.classList.add('show');
    };

    const setupQuickSelectButtons = (container, inputId) => {
        container.addEventListener('click', e => {
            const button = e.target.closest('[data-value]');
            if (!button) return;

            const input = document.getElementById(inputId);
            input.value = button.dataset.value;
            invalidateResult();

            container.querySelectorAll('[data-value]').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
        });

        const input = document.getElementById(inputId);
        input.addEventListener('change', invalidateResult);
        input.addEventListener('input', () => {
            invalidateResult();
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
        window.lastExportData = null;
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
}, { once: true });
