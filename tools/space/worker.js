'use strict';

// Load exactly the same on-disk candidate bundle that the updater publishes.
// No copied upstream regexes or fallback implementation live in this worker.
importScripts('dist/browser/pangu.min.js', 'format.js?v=20261015-pangu');

self.onmessage = ({ data }) => {
    const { id, text } = data ?? {};
    try {
        if (typeof text !== 'string' || text.length > 200000) throw new Error('单次最多处理 20 万字符，请分段处理');
        // Upstream uses these six exact numbered placeholder namespaces. The
        // backtick collision was reproduced in GitHub run 38668460771; all six
        // share the same restore mechanism. Ordinary private-use glyphs are valid.
        const reservedMarker = /\uE000BACKTICK_CONTENT_\d+\uE001|\uE002HTML_TAG_PLACEHOLDER_\d+\uE003|\uE004HTML_TAG_MENTION_\d+\uE005|\uE006SINGLE_QUOTE_CJK_PLACEHOLDER_\d+\uE007|\uE008COMPOUND_WORD_PLACEHOLDER_\d+\uE009|\uE00AHTTP_URL_PLACEHOLDER_\d+\uE00B/;
        if (reservedMarker.test(text)) throw new Error('输入含 Pangu 保留标记，无法安全排版；原文保留');
        if (typeof self.pangu?.spaceText !== 'function') throw new Error('排版组件加载失败');
        const result = self.spaceTextWithUrls(text, self.pangu.spaceText.bind(self.pangu));
        self.postMessage({ id, result });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : '排版失败' });
    }
};
