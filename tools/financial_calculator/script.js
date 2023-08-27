// 获取所有选项卡和内容区域的元素
const tabs = document.querySelectorAll('.tab');
const content = document.getElementById('content');

// 默认显示第一个功能内容
tabs[0].classList.add('active');
document.getElementById('content1').style.display = 'block';

// 为每个选项卡添加点击事件监听器
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        // 移除所有选项卡的“active”类，添加到当前点击的选项卡
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // 获取选项卡对应的内容区域的ID，并根据ID显示对应的内容
        const tabId = tab.id.replace('tab', 'content');
        document.querySelectorAll('.function-content').forEach(content => {
            content.style.display = 'none';
        });
        document.getElementById(tabId).style.display = 'block';
    });
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

    // 计算年化收益率，收益/本金/投资天数*365(360)*100%
    const annualizedReturn = (interest1 / principal1 / days1) * rateType1 * 100;

    // 在页面上显示计算结果
    resultDiv1.innerHTML = `年化收益率：${annualizedReturn.toFixed(2)}%`;
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

    // 计算利息收益，收益 = （本金 × 年化收益率） × （天数 / 365（360））
    const interestEarnings = (principal2 * annualRate2 / 100) * (days2 / rateType2);

    // 在页面上显示计算结果
    resultDiv2.innerHTML = `利息收益：${interestEarnings.toFixed(2)}`;
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

    // 计算天数和净值变化
    const days = (endDate - startDate) / (1000 * 60 * 60 * 24);
    const netValueChange = endNetValue - startNetValue;

    // 计算净值收益率，年化收益率 =（结束净值 - 初始净值）/ 初始净值 / 已成立天数 ×365(360)
    const netValueReturn = (netValueChange / startNetValue) / days * rateType3 * 100;

    // 在页面上显示计算结果
    resultDiv3.innerHTML = `年化收益率：${netValueReturn.toFixed(2)}%`;
});






// 获取第四个功能的计算按钮和结果显示区域的元素


// 在计算按钮点击事件处理程序中
document.getElementById("calculate4").addEventListener("click", function() {
    // 获取用户输入的值
    const principal = parseFloat(document.getElementById("principal3").value);  // 获取本金
    const compoundingFrequency = document.getElementById("compoundingFrequency").value;  // 获取复利方式
    const depositPeriod = parseFloat(document.getElementById("depositPeriod").value);  // 获取存期
    const annualRate = parseFloat(document.getElementById("annualRate3").value);  // 获取年化收益率
    const rateType = parseInt(document.getElementById("rateType4").value);  // 获取年化收益率类型

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
    let detailsTable = `<table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                        <thead>
                            <tr>
                                <th style="width: 20%;">期数（${compoundingFrequency}）</th>
                                <th style="width: 20%;">本金</th>
                                <th style="width: 20%;">利息</th>
                                <th style="width: 20%;">利息总计</th>
                                <th style="width: 20%;">本金利息总计</th>
                            </tr>
                        </thead>
                        <tbody>`;

    // 计算并构建每期的明细
    for (let period = 1; period <= depositPeriod; period++) {
        const interest = totalPrincipal * i;
        totalInterest += interest;
        totalPrincipal += interest;

        detailsTable += `<tr>
                            <td>${period}</td>
                            <td>${principal.toFixed(2)}</td>
                            <td>${interest.toFixed(2)}</td>
                            <td>${totalInterest.toFixed(2)}</td>
                            <td>${totalPrincipal.toFixed(2)}</td>
                        </tr>`;
    }

    // 关闭明细表格
    detailsTable += `</tbody></table>`;

    // 计算本息总额和利息
    const futureValue = totalPrincipal;
    const totalInterestAmount = totalInterest;

    // 显示结果和明细
    const resultElement = document.getElementById("result4");
    resultElement.innerHTML = `<div style="margin-bottom: 10px;">本息总额：${futureValue.toFixed(2)}</div>
                                <div style="margin-bottom: 10px;">利息：${totalInterestAmount.toFixed(2)}</div>
                                ${detailsTable}`;
});
