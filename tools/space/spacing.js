(() => {
    'use strict';

    // Only insert U+0020 at Han/ASCII boundaries. URLs and complete backtick
    // code stay intact; punctuation, whitespace and line endings are never normalized.
    const protectedOrBoundary = /https?:\/\/[^\s<>"`\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026]+|(\p{Script=Han})(?=[A-Za-z0-9(\[{])|([A-Za-z0-9)\]}])(?=\p{Script=Han})/gu;
    // Closing fences may be longer; shorter runs inside the block are content.
    const fencedCode = /^ {0,3}(`{3,})[^`\r\n]*(?:\r\n|\r|\n)[\s\S]*?^ {0,3}\1`*[ \t]*(?=\r\n|\r|\n|$)/gm;
    // Inline delimiters must be whole runs of exactly the same length.
    const inlineCode = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

    const spacePlainText = (text) => text.replace(
        protectedOrBoundary,
        (match, hanBoundary, asciiBoundary) => (hanBoundary || asciiBoundary) ? `${match} ` : match
    );

    function preserveMatches(text, pattern, format) {
        let end = 0;
        let output = '';
        for (const match of text.matchAll(pattern)) {
            output += format(text.slice(end, match.index)) + match[0];
            end = match.index + match[0].length;
        }
        return output + format(text.slice(end));
    }

    // Protect blocks first, so their template literals cannot pair with prose backticks.
    // Unclosed delimiters are ordinary text and keep the existing spacing behavior.
    window.spaceTextPreservingContent = (text) => preserveMatches(text, fencedCode,
        (outsideFence) => preserveMatches(outsideFence, inlineCode, spacePlainText)
    );
})();
