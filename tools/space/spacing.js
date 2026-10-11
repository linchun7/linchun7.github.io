(() => {
    'use strict';

    // Only insert U+0020 at Han/ASCII boundaries. URLs and complete backtick
    // code stay intact; punctuation, whitespace and line endings are never normalized.
    const protectedOrBoundary = /[hH][tT][tT][pP][sS]?:\/\/[^\s<>"`\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026]+|(\p{Script=Han})(?=[A-Za-z0-9(\[{])|([A-Za-z0-9)\]}])(?=\p{Script=Han})/gu;
    const fenceLine = /^ {0,3}(`{3,})([^`\r\n]*)(?=\r\n|\r|\n|$)/gm;
    const spacePlainText = (text) => text.replace(
        protectedOrBoundary,
        (match, hanBoundary, asciiBoundary) => (hanBoundary || asciiBoundary) ? `${match} ` : match
    );

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
