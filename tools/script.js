// script.js
const ul = document.getElementById("toolList");
const searchInput = document.getElementById("searchInput");
const noResults = document.getElementById("noResults");

function displayToolList(tools, keyword) {
    ul.innerHTML = "";
    tools.forEach(tool => {
        const li = document.createElement("li");
        const link = document.createElement("a");
        link.className = "tool-link";
        link.href = tool.link;
        link.innerHTML = highlightSearchKeyword(tool.name, keyword); // 高亮搜索词
        li.appendChild(link);
        ul.appendChild(li);
    });
}

function highlightSearchKeyword(text, keyword) {
    const regex = new RegExp(keyword, "gi");
    return text.replace(regex, match => `<span class="highlight">${match}</span>`);
}

function filterToolsByKeyword(keyword) {
    return toolList.filter(tool => tool.name.toLowerCase().includes(keyword));
}

let toolList = [];
let currentKeyword = "";

// 获取所有工具链接
const toolElements = Array.from(ul.getElementsByTagName("a"));
toolList = toolElements.map(toolElement => ({ name: toolElement.textContent, link: toolElement.href }));

displayToolList(toolList, "");

searchInput.addEventListener("input", function() {
    const keyword = this.value.toLowerCase().trim();
    
    if (keyword === currentKeyword) {
        return; // 如果搜索词没有变化，则跳过处理
    }
    
    currentKeyword = keyword;
    
    if (keyword === "") {
        displayToolList(toolList, "");
        noResults.style.display = "none";
    } else {
        const filteredTools = filterToolsByKeyword(keyword);
        displayToolList(filteredTools, keyword);

        if (filteredTools.length === 0) {
            noResults.style.display = "block";
        } else {
            noResults.style.display = "none";
        }
    }
});
