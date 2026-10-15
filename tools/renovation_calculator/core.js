// Pure cash-flow core. Inputs are the same normalized, validated numbers used by the UI.
// Keep display formatting, input feedback, DOM work, and CSV downloads in script.js.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.RenovationCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

const CALCULATION_ERROR_MESSAGE = '计算结果异常，请检查输入的数据是否合理';

// 把已校验 Number 的十进制表示转为精确比例；支持普通小数和科学计数法。
function decimalFraction(value) {
    const [significand, exponent = '0'] = Math.abs(value).toString().split('e');
    const [whole, fraction = ''] = significand.split('.');
    const coefficient = BigInt(whole + fraction);
    const scale = fraction.length - Number(exponent);
    return scale >= 0
        ? { numerator: coefficient, denominator: 10n ** BigInt(scale) }
        : { numerator: coefficient * 10n ** BigInt(-scale), denominator: 1n };
}

// 金额按金融 half-up 取到分：恰好半分向绝对值较大的方向舍入。
// 先对十进制操作数精确相乘/相除，再取分，避免浮点乘法先丢失半分边界。
function roundMoney(left, right = 1, divisor = 1) {
    const value = left * right / divisor;
    if (!Number.isFinite(value)) return value;

    const leftFraction = decimalFraction(left);
    const rightFraction = decimalFraction(right);
    const numerator = leftFraction.numerator * rightFraction.numerator * 100n;
    const denominator = leftFraction.denominator * rightFraction.denominator * BigInt(divisor);
    const cents = numerator / denominator;
    const roundedCents = cents + (numerator % denominator * 2n >= denominator ? 1n : 0n);
    return Math.sign(value) * Number(roundedCents) / 100;
}

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

function generateSchedule(inputs) {
    const schedule = [];
    const monthlyFee = roundMoney(inputs.loanAmount, inputs.serviceFeeRate, 100);
    let totalPaidPrincipal = 0;

    for (let month = 1; month <= inputs.loanTerm; month++) {
        const openingPrincipal = Math.max(0, roundMoney(inputs.loanAmount - totalPaidPrincipal));
        // 按累计目标分摊本金，而不是固定四舍五入后的“月本金”，避免长周期尾期出现负本金。
        const targetPaidPrincipal = month === inputs.loanTerm
            ? inputs.loanAmount
            : roundMoney(inputs.loanAmount, month, inputs.loanTerm);
        const principal = Math.max(0, roundMoney(targetPaidPrincipal - totalPaidPrincipal));
        const payment = roundMoney(principal + monthlyFee);

        totalPaidPrincipal = roundMoney(totalPaidPrincipal + principal);
        const remainingPrincipal = Math.max(0, roundMoney(inputs.loanAmount - totalPaidPrincipal));
        const annualizedFeeRate = openingPrincipal > 0
            ? monthlyFee * 12 / openingPrincipal * 100
            : monthlyFee > 0 ? null : 0;

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
    if (!Number.isFinite(apr)) throw new Error(CALCULATION_ERROR_MESSAGE);

    schedule.forEach((row, index) => {
        if (index === schedule.length - 1) {
            row.earlyRepaymentAPR = apr;
            return;
        }

        const cashFlows = [-inputs.loanAmount];
        for (let i = 0; i < index; i++) {
            cashFlows.push(schedule[i].payment);
        }
        cashFlows.push(roundMoney(row.payment + row.remainingPrincipal));

        const earlyMonthlyRate = IRR(cashFlows);
        const earlyAnnualRate = annualizeMonthlyIRR(earlyMonthlyRate);
        if (!Number.isFinite(earlyAnnualRate)) throw new Error(CALCULATION_ERROR_MESSAGE);
        row.earlyRepaymentAPR = earlyAnnualRate;
    });

    const totals = schedule.reduce((acc, row) => ({
        totalPayment: roundMoney(acc.totalPayment + row.payment),
        totalPrincipal: roundMoney(acc.totalPrincipal + row.principal),
        totalServiceFee: roundMoney(acc.totalServiceFee + row.serviceFee)
    }), {
        totalPayment: 0,
        totalPrincipal: 0,
        totalServiceFee: 0
    });

    return { schedule, apr, totals };
}


return Object.freeze({
    CALCULATION_ERROR_MESSAGE,
    roundMoney,
    npv,
    IRR,
    annualizeMonthlyIRR,
    generateSchedule
});
});
