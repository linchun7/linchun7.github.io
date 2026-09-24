(() => {
    'use strict';

    const input = document.getElementById('inputInfo');
    const clearButton = document.getElementById('clearBtn');
    const toast = document.getElementById('toast');
    const outputIds = ['result1', 'result2', 'result3', 'result4', 'result5'];
    const outputs = Object.fromEntries(outputIds.map((id) => [id, document.getElementById(id)]));
    const copyButtons = [...document.querySelectorAll('.copy-button')];

    let composing = false;
    let toastTimer = null;

    function showToast(message) {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.classList.add('show');
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    function setResult(id, value, emptyMessage = '等待输入') {
        const element = outputs[id];
        const button = document.querySelector(`.copy-button[data-result="${id}"]`);
        element.replaceChildren();

        if (value) {
            element.textContent = value;
            button.disabled = false;
            return;
        }

        const placeholder = document.createElement('span');
        placeholder.className = 'empty-text';
        placeholder.textContent = emptyMessage;
        element.appendChild(placeholder);
        button.disabled = true;
    }

    function isSingleHanCharacter(text) {
        const characters = Array.from(text.trim());
        return characters.length === 1 && /^\p{Script=Han}$/u.test(characters[0]);
    }

    function render() {
        if (!window.pinyinPro?.pinyin) {
            showToast('拼音组件加载失败，请刷新后重试');
            return;
        }

        const text = input.value;
        if (!text) {
            setResult('result1', '');
            setResult('result2', '');
            setResult('result3', '');
            setResult('result4', '');
            setResult('result5', '', '仅单个汉字时显示');
            return;
        }

        const { pinyin } = window.pinyinPro;
        const commonOptions = { pattern: 'pinyin', nonZh: 'removed' };

        setResult('result1', pinyin(text, { ...commonOptions, toneType: 'none' }), '未识别到汉字');
        setResult('result2', pinyin(text, { ...commonOptions, toneType: 'symbol' }), '未识别到汉字');
        setResult('result3', pinyin(text, { ...commonOptions, toneType: 'num' }), '未识别到汉字');
        setResult('result4', pinyin(text, { pattern: 'first', toneType: 'none', nonZh: 'removed', separator: '' }), '未识别到汉字');

        const trimmed = text.trim();
        if (isSingleHanCharacter(trimmed)) {
            setResult('result5', pinyin(trimmed, { multiple: true }), '未识别到读音');
        } else {
            setResult('result5', '', '仅单个汉字时显示');
        }
    }

    function fallbackCopy(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        textArea.setSelectionRange(0, text.length);

        let copied = false;
        try {
            copied = document.execCommand('copy');
        } catch {
            copied = false;
        } finally {
            textArea.remove();
        }
        return copied;
    }

    async function copyText(text) {
        if (window.isSecureContext && navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch {
                // Fall back for browsers or permission states where Clipboard API is unavailable.
            }
        }
        return fallbackCopy(text);
    }

    input.addEventListener('compositionstart', () => {
        composing = true;
    });

    input.addEventListener('compositionend', () => {
        composing = false;
        render();
    });

    input.addEventListener('input', () => {
        if (!composing) render();
    });

    clearButton.addEventListener('click', () => {
        input.value = '';
        render();
        input.focus();
    });

    copyButtons.forEach((button) => {
        button.addEventListener('click', async () => {
            const result = outputs[button.dataset.result];
            if (!result || button.disabled) {
                showToast('无内容');
                return;
            }

            const value = result.textContent.trim();
            const copied = await copyText(value);
            showToast(copied ? '已复制' : '复制失败，请手动复制');
        });
    });

    window.addEventListener('load', render, { once: true });
})();
