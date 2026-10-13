(() => {
    'use strict';

    // Only insert U+0020 at Han/ASCII boundaries. URLs and complete backtick
    // code stay intact; punctuation, whitespace and line endings are never normalized.
    // Keep the original prose boundaries outside URLs. Parentheses within a
    // URL may contain nested pairs and fullwidth punctuation.
    const urlStart = /<?[hH][tT][tT][pP][sS]?:\/\//g;
    const hardUrlBoundary = /[\s<>"`]/u;
    // Unicode blocks contain letters, numbers and currency as well as punctuation.
    const bareUrlBoundary = /(?:[\u2018\u2019\u201c\u201d\u2026]|(?=[\u3000-\u303f\uff00-\uffef])\p{P})/u;
    const hanAsciiBoundary = /(\p{Script=Han})(?=[A-Za-z0-9(\[{])|([A-Za-z0-9)\]}])(?=\p{Script=Han})/gu;
    const fenceLine = /^ {0,3}(`{3,})([^`\r\n]*)(?=\r\n|\r|\n|$)/gm;
    const spaceBoundaries = (text) => text.replace(hanAsciiBoundary, (match) => `${match} `);

    function fullwidthParenthesisPairs(text) {
        const pairs = new Map();
        const openings = [];
        for (let i = 0; i < text.length; i++) {
            const character = text[i];
            // A raw URL cannot bridge whitespace, markup delimiters or code.
            if (hardUrlBoundary.test(character)) openings.length = 0;
            else if (character === '（') openings.push(i);
            else if (character === '）' && openings.length) pairs.set(openings.pop(), i);
        }
        return pairs;
    }

    function explicitUrlEnd(text, start) {
        for (let i = start; i < text.length; i++) {
            if (text[i] === '>') return i > start ? i + 1 : start;
            if (hardUrlBoundary.test(text[i])) break;
        }
        return start;
    }

    function bareUrlEnd(text, start, pairs) {
        let end = start;
        let asciiParenthesisDepth = 0;
        while (end < text.length) {
            const character = text[end];
            if (hardUrlBoundary.test(character)) break;
            // A closing prose/Markdown parenthesis cannot belong to this URL.
            // Balanced ASCII pairs inside its path/query remain byte-identical.
            if (character === '(') asciiParenthesisDepth += 1;
            else if (character === ')') {
                if (asciiParenthesisDepth === 0) break;
                asciiParenthesisDepth -= 1;
            }
            if (character === '（') {
                const closing = pairs.get(end);
                // Do not hide prose following an unclosed URL parenthesis.
                if (closing === undefined) break;
                // A fullwidth group can cross an ASCII pair. Count its ASCII
                // delimiters while preserving all content in the group. Each
                // jumped group is disjoint, so this is still a linear scan.
                for (let i = end + 1; i < closing; i++) {
                    if (text[i] === '(') asciiParenthesisDepth += 1;
                    else if (text[i] === ')' && asciiParenthesisDepth > 0) asciiParenthesisDepth -= 1;
                }
                end = closing + 1;
            } else {
                if (bareUrlBoundary.test(character)) break;
                end += 1;
            }
        }
        return end;
    }

    function spacePlainText(text) {
        // Pair once, then jump over each complete group. Repeated nested or
        // unclosed parentheses never trigger rescans of the remaining input.
        const pairs = fullwidthParenthesisPairs(text);
        const parts = [];
        let end = 0;
        for (const match of text.matchAll(urlStart)) {
            if (match.index < end) continue;
            const schemeEnd = match.index + match[0].length;
            const hasAngle = match[0][0] === '<';
            let start = match.index;
            let finish = hasAngle ? explicitUrlEnd(text, schemeEnd) : schemeEnd;
            if (finish === schemeEnd) {
                if (hasAngle) start += 1;
                finish = bareUrlEnd(text, schemeEnd, pairs);
            }
            if (finish === schemeEnd) continue;
            const plain = text.slice(end, start);
            parts.push(spaceBoundaries(plain));
            // Preserve the Han/ASCII boundary immediately before a bare URL.
            if (text[start] !== '<' && /\p{Script=Han}$/u.test(plain)) parts.push(' ');
            parts.push(text.slice(start, finish));
            end = finish;
        }
        parts.push(spaceBoundaries(text.slice(end)));
        return parts.join('');
    }

    function spaceOutsideInlineCode(text) {
        const runs = Array.from(text.matchAll(/`+/g));
        const nextSameLength = new Array(runs.length);
        const nextByLength = new Map();
        // Index the next whole run of each length once, rather than searching
        // the remaining text again for every unmatched opening delimiter.
        for (let i = runs.length - 1; i >= 0; i--) {
            const length = runs[i][0].length;
            nextSameLength[i] = nextByLength.get(length);
            nextByLength.set(length, i);
        }

        const parts = [];
        let end = 0;
        for (let i = 0; i < runs.length; i++) {
            const closing = nextSameLength[i];
            if (closing === undefined) continue;
            const finish = runs[closing].index + runs[closing][0].length;
            parts.push(spacePlainText(text.slice(end, runs[i].index)), text.slice(runs[i].index, finish));
            end = finish;
            i = closing;
        }
        parts.push(spacePlainText(text.slice(end)));
        return parts.join('');
    }

    // Protect complete blocks first, so their template literals cannot pair
    // with prose backticks. A closing fence may be longer than its opener.
    window.spaceTextPreservingContent = (text) => {
        const lines = Array.from(text.matchAll(fenceLine));
        const laterMaxClosingLength = new Array(lines.length);
        let maxClosingLength = 0;
        // Skip unclosable openers without rescanning the remaining text.
        for (let i = lines.length - 1; i >= 0; i--) {
            laterMaxClosingLength[i] = maxClosingLength;
            if (/^[ \t]*$/.test(lines[i][2])) {
                maxClosingLength = Math.max(maxClosingLength, lines[i][1].length);
            }
        }

        const parts = [];
        let opening;
        let end = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!opening) {
                const afterLine = text[line.index + line[0].length];
                if (laterMaxClosingLength[i] < line[1].length || (afterLine !== '\r' && afterLine !== '\n')) continue;
                opening = line;
                continue;
            }
            if (line[1].length < opening[1].length || !/^[ \t]*$/.test(line[2])) continue;
            const finish = line.index + line[0].length;
            parts.push(spaceOutsideInlineCode(text.slice(end, opening.index)), text.slice(opening.index, finish));
            end = finish;
            opening = undefined;
        }
        // Unclosed delimiters are ordinary text and retain the existing spacing behavior.
        parts.push(spaceOutsideInlineCode(text.slice(end)));
        return parts.join('');
    };
})();
