(() => {
    'use strict';

    const DAY_MS = 24 * 60 * 60 * 1000;
    const MAX_DETAIL_PERIODS = 2000;

    const $ = (id) => document.getElementById(id);

    const numberFormatter = new Intl.NumberFormat('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });

    function formatNumber(value) {
        return Number.isFinite(value) ? numberFormatter.format(value) : '—';
    }

    function formatPercent(value) {
        return Number.isFinite(value) ? `${value.toFixed(2)}%` : '—';
    }

    function setResult(id, text, type = 'success') {
        const element = $(id);
        if (!element) return;
        element.textContent = text;
        element.classList.toggle('result-error', type === 'error');
        element.classList.toggle('result-success', type !== 'error');
    }

    function clearResult(id) {
        const element = $(id);
        if (!element) return;
        element.textContent = '';
        element.classList.remove('result-error', 'result-success');
    }

    function readFiniteNumber(id, label) {
        const element = $(id);
        const raw = element ? element.value.trim() : '';
        if (raw === '') throw new Error(`请输入${label}`);
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`${label}必须是有效数字`);
        return value;
    }

    function readPositiveNumber(id, label) {
        const value = readFiniteNumber(id, label);
        if (value <= 0) throw new Error(`${label}必须大于 0`);
        return value;
    }

    function readPositiveInteger(id, label) {
        const value = readFiniteNumber(id, label);
        if (!Number.isInteger(value) || value <= 0) throw new Error(`${label}必须是大于 0 的整数`);
        return value;
    }

    function readAnnualDays(id) {
        const value = Number($(id).value);
        if (value !== 360 && value !== 365) throw new Error('年化天数必须为 360 或 365');
        return value;
    }

    function parseDateUtc(id, label) {
        const raw = $(id).value;
        if (!raw) throw new Error(`请选择${label}`);

        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
        if (!match) throw new Error(`${label}格式无效`);

        const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        if (!Number.isFinite(timestamp)) throw new Error(`${label}格式无效`);
        return timestamp;
    }

    function runCalculation(resultId, calculator) {
        try {
            const message = calculator();
            setResult(resultId, message, 'success');
        } catch (error) {
            setResult(resultId, error instanceof Error ? error.message : '计算失败，请检查输入', 'error');
        }
    }

    function calculateAnnualizedReturn() {
        const principal = readPositiveNumber('principal1', '本金');
        const days = readPositiveInteger('days1', '天数');
        const earnings = readFiniteNumber('interest1', '收益');
        const annualDays = readAnnualDays('rateType1');

        const annualizedReturn = (earnings / principal / days) * annualDays * 100;
        if (!Number.isFinite(annualizedReturn)) throw new Error('计算结果异常，请检查输入');

        return `单利年化收益率：${formatPercent(annualizedReturn)}`;
    }

    function calculateInterest() {
        const principal = readPositiveNumber('principal2', '本金');
        const days = readPositiveInteger('days2', '天数');
        const annualRate = readFiniteNumber('annualRate2', '单利年化收益率');
        const annualDays = readAnnualDays('rateType2');

        const earnings = principal * (annualRate / 100) * (days / annualDays);
        if (!Number.isFinite(earnings)) throw new Error('计算结果异常，请检查输入');

        return `利息收益：${formatNumber(earnings)} 元`;
    }

    function calculateNetValueReturn() {
        const startDate = parseDateUtc('startDate', '起始日期');
        const endDate = parseDateUtc('endDate', '终止日期');
        const startValue = readPositiveNumber('startNetValue', '起始净值');
        const endValue = readPositiveNumber('endNetValue', '终止净值');
        const annualDays = readAnnualDays('rateType3');

        if (endDate <= startDate) throw new Error('终止日期必须晚于起始日期');

        const days = (endDate - startDate) / DAY_MS;
        const growthRatio = endValue / startValue;
        const annualizedReturn = (Math.pow(growthRatio, annualDays / days) - 1) * 100;

        if (!Number.isFinite(annualizedReturn)) throw new Error('计算结果异常，请检查输入');
        return `净值年化收益率（CAGR）：${formatPercent(annualizedReturn)}（持有 ${days} 天）`;
    }

    const frequencyConfig = {
        annually: { label: '年', divisor: 1 },
        'semi-annually': { label: '半年', divisor: 2 },
        quarterly: { label: '季', divisor: 4 },
        monthly: { label: '月', divisor: 12 },
        weekly: { label: '周', dayBased: 7 },
        daily: { label: '日', dayBased: 1 }
    };

    function getPeriodicRate(annualRatePercent, frequency, annualDays) {
        const config = frequencyConfig[frequency];
        if (!config) throw new Error('复利方式无效');

        const periodicPercent = config.dayBased
            ? annualRatePercent * config.dayBased / annualDays
            : annualRatePercent / config.divisor;

        const rate = periodicPercent / 100;
        if (!Number.isFinite(rate) || rate <= -1) {
            throw new Error('该名义年利率在当前复利方式下会使单期本金小于等于 0，请调整参数');
        }
        return rate;
    }

    function clearElement(element) {
        while (element && element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }

    function appendCell(row, text, tag = 'td') {
        const cell = document.createElement(tag);
        cell.textContent = text;
        row.appendChild(cell);
    }

    function renderCompoundDetails(principal, periods, periodicRate) {
        const container = $('result4-table');
        clearElement(container);

        if (periods > MAX_DETAIL_PERIODS) {
            const note = document.createElement('p');
            note.className = 'detail-limit-note';
            note.textContent = `存期共 ${periods} 期，为避免浏览器卡顿，仅显示汇总结果；明细最多展示 ${MAX_DETAIL_PERIODS} 期。`;
            container.appendChild(note);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'compound-table-wrap';

        const table = document.createElement('table');
        table.className = 'table table-sm compound-table';

        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        ['期数', '期初本金', '本期收益', '累计收益', '本息合计'].forEach((text) => appendCell(headRow, text, 'th'));
        thead.appendChild(headRow);

        const tbody = document.createElement('tbody');
        let balance = principal;
        let totalInterest = 0;

        for (let period = 1; period <= periods; period += 1) {
            const opening = balance;
            const interest = opening * periodicRate;
            totalInterest += interest;
            balance += interest;

            const row = document.createElement('tr');
            appendCell(row, String(period));
            appendCell(row, formatNumber(opening));
            appendCell(row, formatNumber(interest));
            appendCell(row, formatNumber(totalInterest));
            appendCell(row, formatNumber(balance));
            tbody.appendChild(row);
        }

        table.append(thead, tbody);
        wrapper.appendChild(table);
        container.appendChild(wrapper);
    }

    function calculateCompound() {
        const principal = readPositiveNumber('principal3', '本金');
        const periods = readPositiveInteger('depositPeriod', '存期');
        const annualRate = readFiniteNumber('annualRate3', '名义年利率');
        const frequency = $('compoundingFrequency').value;
        const config = frequencyConfig[frequency];
        if (!config) throw new Error('复利方式无效');

        // 360 / 365 天只参与按周、按日复利；其他频率完全忽略该选择。
        const annualDays = config.dayBased ? readAnnualDays('rateType4') : 365;
        const periodicRate = getPeriodicRate(annualRate, frequency, annualDays);
        const growthFactor = Math.pow(1 + periodicRate, periods);
        const futureValue = principal * growthFactor;
        const totalInterest = futureValue - principal;

        if (!Number.isFinite(futureValue) || !Number.isFinite(totalInterest)) {
            throw new Error('计算结果过大或无效，请缩短存期或调整收益率');
        }

        renderCompoundDetails(principal, periods, periodicRate);
        return `本息总计：${formatNumber(futureValue)} 元；利息总计：${formatNumber(totalInterest)} 元`;
    }

    function clearFields(ids, resultId, extraClear) {
        ids.forEach((id) => {
            const element = $(id);
            if (element) element.value = '';
        });
        clearResult(resultId);
        if (typeof extraClear === 'function') extraClear();
        const first = $(ids[0]);
        if (first) first.focus();
    }

    function activateTab(tab) {
        document.querySelectorAll('#myTabs .nav-link').forEach((button) => {
            const active = button === tab;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });

        document.querySelectorAll('#contents .tab-pane').forEach((panel) => {
            const active = panel.id === tab.dataset.target;
            panel.hidden = !active;
            panel.classList.toggle('show', active);
            panel.classList.toggle('active', active);
        });
    }

    function updateFrequencyLabel() {
        const config = frequencyConfig[$('compoundingFrequency').value] || frequencyConfig.annually;
        $('frequency').textContent = config.label;
    }

    function init() {
        document.querySelectorAll('#myTabs .nav-link').forEach((tab) => {
            tab.addEventListener('click', () => activateTab(tab));
        });

        $('calculate1').addEventListener('click', () => runCalculation('result1', calculateAnnualizedReturn));
        $('calculate2').addEventListener('click', () => runCalculation('result2', calculateInterest));
        $('calculate3').addEventListener('click', () => runCalculation('result3', calculateNetValueReturn));
        $('calculate4').addEventListener('click', () => {
            clearElement($('result4-table'));
            runCalculation('result4', calculateCompound);
        });

        $('empty1').addEventListener('click', () => clearFields(['principal1', 'days1', 'interest1'], 'result1'));
        $('empty2').addEventListener('click', () => clearFields(['principal2', 'days2', 'annualRate2'], 'result2'));
        $('empty3').addEventListener('click', () => clearFields(['startDate', 'startNetValue', 'endDate', 'endNetValue'], 'result3'));
        $('empty4').addEventListener('click', () => clearFields(
            ['principal3', 'depositPeriod', 'annualRate3'],
            'result4',
            () => clearElement($('result4-table'))
        ));

        $('compoundingFrequency').addEventListener('change', updateFrequencyLabel);
        updateFrequencyLabel();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
