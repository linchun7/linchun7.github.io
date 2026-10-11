(() => {
    'use strict';

    // Only insert U+0020 at Han/ASCII boundaries. URLs and backtick contents are
    // kept intact; unlike Pangu.spacing, this never normalizes punctuation or whitespace.
    const protectedOrBoundary = /https?:\/\/[^\s<>"`\u3000-\u303f\uff00-\uffef\u2018\u2019\u201c\u201d\u2026]+|`[^`]*`|(\p{Script=Han})(?=[A-Za-z0-9(\[{])|([A-Za-z0-9)\]}])(?=\p{Script=Han})/gu;

    window.spaceTextPreservingContent = (text) => text.replace(
        protectedOrBoundary,
        (match, hanBoundary, asciiBoundary) => (hanBoundary || asciiBoundary) ? `${match} ` : match
    );
})();
