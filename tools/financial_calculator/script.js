
document.addEventListener('DOMContentLoaded', function() {
    const tabs = document.querySelectorAll('.nav-link');
    const contents = document.querySelectorAll('.tab-pane');

    function showContent(targetId) {
        contents.forEach(content => {
            content.classList.remove('show', 'active');
        });
        document.getElementById(targetId).classList.add('show', 'active');
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const targetId = tab.getAttribute('data-bs-target').replace('#', '');

            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            
            showContent(targetId);
        });
    });

    tabs[0].classList.add('active');
    showContent(tabs[0].getAttribute('data-bs-target').replace('#', ''));
});



// 获取第一个功能的计算按钮和结果显示区域的元素
const calculateButton1 = document.getElementById('calculate1');
const resultDiv1 = document.getElementById('result1');

// 添加点击事件监听器，当点击计算按钮时执行计算
calculateButton1.addEventListener('click', () => {
    // 获取用户输入的值
    const principal1 = parseFloat(document.getElementById('principal1').value);
    const days1 = parseInt(document.getElementById('days1').value);
    const interest1 = parseFloat(document.getElementById('interest1').value);
    const rateType1 = parseInt(document.getElementById('rateType1').value);

    // 检查输入值是否为空
    if (isNaN(principal1) || isNaN(days1) || isNaN(interest1)) {
        resultDiv1.innerHTML = '请输入有效的值';
    } else {
        // 计算年化收益率，收益/本金/投资天数*365(360)*100%
        const annualizedReturn = (interest1 / principal1 / days1) * rateType1 * 100;

        // 在页面上显示计算结果
        resultDiv1.innerHTML = `年化收益率：<span style='color: red'>${annualizedReturn.toFixed(2)}%</span>`;
    }
});




// 获取第二个功能的计算按钮和结果显示区域的元素
const calculateButton2 = document.getElementById('calculate2');
const resultDiv2 = document.getElementById('result2');

// 添加点击事件监听器，当点击计算按钮时执行计算
calculateButton2.addEventListener('click', () => {
    // 获取用户输入的值
    const principal2 = parseFloat(document.getElementById('principal2').value);
    const days2 = parseInt(document.getElementById('days2').value);
    const annualRate2 = parseFloat(document.getElementById('annualRate2').value);
    const rateType2 = parseInt(document.getElementById('rateType2').value);

    // 检查输入值是否为空
    if (isNaN(principal2) || isNaN(days2) || isNaN(annualRate2)) {
        resultDiv2.innerHTML = '请输入有效的值';
    } else {
        // 计算利息收益，收益 = （本金 × 年化收益率） × （天数 / 365（360））
        const interestEarnings = (principal2 * annualRate2 / 100) * (days2 / rateType2);

        // 在页面上显示计算结果
        resultDiv2.innerHTML = `利息收益：<span style='color: red'>${interestEarnings.toFixed(2)}</span>`;
    }
});

// 获取第三个功能的计算按钮和结果显示区域的元素
const calculateButton3 = document.getElementById('calculate3');
const resultDiv3 = document.getElementById('result3');

// 添加点击事件监听器，当点击计算按钮时执行计算
calculateButton3.addEventListener('click', () => {
    // 获取用户输入的值
    const startDate = new Date(document.getElementById('startDate').value);
    const startNetValue = parseFloat(document.getElementById('startNetValue').value);
    const endDate = new Date(document.getElementById('endDate').value);
    const endNetValue = parseFloat(document.getElementById('endNetValue').value);
    const rateType3 = parseInt(document.getElementById('rateType3').value);

    // 检查输入值是否为空
    if (isNaN(startNetValue) || isNaN(endNetValue) || isNaN(rateType3) || isNaN(startDate) || isNaN(endDate) ) {
        resultDiv3.innerHTML = '请输入有效的值';
    } else {
        // 计算天数和净值变化
        const days = (endDate - startDate) / (1000 * 60 * 60 * 24);
        const netValueChange = endNetValue - startNetValue;
		
		if (days === 0) {
            resultDiv3.innerHTML = '终止日期应大于起始日期';
        } else {

        // 计算净值收益率，年化收益率 =（结束净值 - 初始净值）/ 初始净值 / 已成立天数 ×365(360)
        const netValueReturn = (netValueChange / startNetValue) / days * rateType3 * 100;

        // 在页面上显示计算结果
        resultDiv3.innerHTML = `年化收益率：<span style='color: red'>${netValueReturn.toFixed(2)}%</span>`;
    	}
	}
});



// 获取第四个功能的计算按钮和结果显示区域的元素
document.getElementById("calculate4").addEventListener("click", function() {
    // 获取用户输入的值
    const principal = parseFloat(document.getElementById("principal3").value);  // 获取本金
    const compoundingFrequency = document.getElementById("compoundingFrequency").value;  // 获取复利方式
    const depositPeriod = parseFloat(document.getElementById("depositPeriod").value);  // 获取存期
    const annualRate = parseFloat(document.getElementById("annualRate3").value);  // 获取年化收益率
    const rateType = parseInt(document.getElementById("rateType4").value);  // 获取年化收益率类型

    // 检测输入值是否为空
    if (isNaN(principal) || isNaN(depositPeriod) || isNaN(annualRate) || isNaN(rateType)) {
        const resultElement = document.getElementById("result4");
        resultElement.innerHTML = '请输入有效的值';
    } else {
        // 将年化收益率转换为对应复利方式的利率
        let rate;
        if (compoundingFrequency === "daily") {
            rate = annualRate / rateType;  // 日利率
        } else if (compoundingFrequency === "weekly") {
            rate = annualRate / rateType * 7; //日利率*7=周利率
        } else if (compoundingFrequency === "monthly") {
            rate = annualRate / 12;  // 月
        } else if (compoundingFrequency === "quarterly") {
            rate = annualRate / 4;  // 季
        } else if (compoundingFrequency === "semi-annually") {
            rate = annualRate / 2;  // 半年
        } else if (compoundingFrequency === "annually") {
            rate = annualRate;  // 年
        }

        // 计算复利收益和明细
        const n = depositPeriod;  // 计息期数
        const i = rate / 100;  // 将利率转为小数
        let totalPrincipal = principal;
        let totalInterest = 0;

        // 构建明细表格的表头
        // 构建明细表格
        let detailsTable = `<div style="overflow-x: auto;">
                                <table style="width: auto; border-collapse: collapse; margin-top: 10px;">
                                    <thead>
                                        <tr>
                                            <th style="min-width: 100px;">期  数</th>
                                            <th style="min-width: 100px;">本  金</th>
                                            <th style="min-width: 100px;">利  息</th>
                                            <th style="min-width: 100px;">利息总计</th>
                                            <th style="min-width: 150px;">本息总计</th>
                                        </tr>
                                    </thead>
                                    <tbody>`;

        // 计算并构建每期的明细
// 计算并构建每期的明细
for (let period = 1; period <= depositPeriod; period++) {
    const interest = totalPrincipal * i;
    totalInterest += interest;

    // 本期本金总计为初始本金 + 累计的总利息
    const totalAmount = principal + totalInterest;

    detailsTable += `<tr>
                        <td>${period}</td>
                        <td>${totalPrincipal.toFixed(2)}</td>
                        <td>${interest.toFixed(2)}</td>
                        <td>${totalInterest.toFixed(2)}</td>
                        <td>${totalAmount.toFixed(2)}</td>
                    </tr>`;

    // 更新总本金为本金总计，以便下一期使用
    totalPrincipal = totalAmount;
}

        // 关闭明细表格
        detailsTable += `</tbody></table></div>`;

        // 计算本息总额和利息
        const futureValue = totalPrincipal;
        const totalInterestAmount = totalInterest;

        // 显示结果和明细
        const result4 = document.getElementById("result4");
		const resultElement = document.getElementById("result4-table");
        result4.innerHTML = `<div>本息总计：<span style='color: red'>${futureValue.toFixed(2)}</span></div>
                                    <div>利息总计：<span style='color: red'>${totalInterest.toFixed(2)}</span></div>`;
		 resultElement.innerHTML = `${detailsTable}`;
		
    }
});




// 清空1的点击事件监听器
document.getElementById('empty1').addEventListener('click', () => {
    // 清空输入字段的值
    document.getElementById('principal1').value = '';
    document.getElementById('days1').value = '';
    document.getElementById('interest1').value = '';

    // 清空结果显示区域
    resultDiv1.innerHTML = '';
});

// 清空2的点击事件监听器
document.getElementById('empty2').addEventListener('click', () => {
    // 清空输入字段的值
    document.getElementById('principal2').value = '';
    document.getElementById('days2').value = '';
    document.getElementById('annualRate2').value = '';

    // 清空结果显示区域
    resultDiv2.innerHTML = '';
});

// 清空3的点击事件监听器
document.getElementById('empty3').addEventListener('click', () => {
    // 清空输入字段的值
    document.getElementById('startDate').value = '';
    document.getElementById('startNetValue').value = '';
    document.getElementById('endDate').value = '';
	    document.getElementById('endNetValue').value = '';


    // 清空结果显示区域
    resultDiv3.innerHTML = '';
});

// 清空4的点击事件监听器
document.getElementById('empty4').addEventListener('click', () => {
    // 清空输入字段的值
    document.getElementById('principal3').value = '';
    document.getElementById('depositPeriod').value = '';
    document.getElementById('annualRate3').value = '';

    // 清空结果显示区域
	const result4 = document.getElementById("result4");
	const resultElement = document.getElementById("result4-table");
	result4.innerHTML = '';
    resultElement.innerHTML = '';
});

