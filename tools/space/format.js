(() => {
    'use strict';

    // URL safety only. Typography and simple inline code belong to upstream Pangu.
    // This is deliberately not a Markdown or general URL parser. Ambiguous URLs
    // containing raw []{} or sentence punctuation should use <https://...>.
    const urlToken = /<https?:\/\/[^\s<>]+>|https?:\/\/(?:\[[0-9a-f:.%_-]+\][^\s<>"'`\[\]{}]*|[^\s<>"'`\[\]{}]+)/gi;
    const sentenceBoundary = /(?:[\u2018\u2019\u201c\u201d\u2026]|(?=[\u3000-\u303f\uff00-\uffef])\p{P})/u;

    function bareUrlLength(token) {
        const openings = [];
        let end = token.length;
        for (let index = token.indexOf('://') + 3; index < token.length; index += 1) {
            const character = token[index];
            if (character === '(' || character === '（') openings.push({ character, index });
            else if (character === ')' || character === '）') {
                const expected = character === ')' ? '(' : '（';
                if (openings.at(-1)?.character !== expected) { end = index; break; }
                openings.pop();
            } else if (openings.length === 0 && sentenceBoundary.test(character)) {
                end = index;
                break;
            }
        }
        // An unfinished parenthesis is prose, not an instruction to hide the tail.
        return openings.length ? Math.min(end, openings[0].index) : end;
    }

    globalThis.spaceTextWithUrls = (text, spaceText) => {
        if (typeof text !== 'string' || typeof spaceText !== 'function') throw new Error('排版组件加载失败');
        const existing = new Set(text.match(/PANGUURLTOKEN\d+X/g) ?? []);
        let sequence = 0;
        while (existing.has(`PANGUURLTOKEN${sequence}X`)) sequence += 1;
        const prefix = `PANGUURLTOKEN${sequence}X`;
        const urls = [];
        const protectedText = text.replace(urlToken, (token) => {
            const length = token.startsWith('<') ? token.length : bareUrlLength(token);
            const url = token.slice(0, length);
            const placeholder = `${prefix}${urls.length}END`;
            urls.push(url);
            return placeholder + token.slice(length);
        });
        const formatted = spaceText(protectedText);
        if (typeof formatted !== 'string') throw new Error('排版组件返回异常');
        let restored = 0;
        const result = formatted.replace(new RegExp(`${prefix}(\\d+)END`, 'g'), (placeholder, index) => {
            if (index !== String(restored) || !urls[index]) throw new Error('URL 保护校验失败');
            restored += 1;
            return urls[index];
        });
        if (restored !== urls.length) throw new Error('URL 保护校验失败');
        return result;
    };
})();
