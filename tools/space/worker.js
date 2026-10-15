'use strict';

// Load exactly the same on-disk candidate bundle that the updater publishes.
// No copied upstream regexes or fallback implementation live in this worker.
importScripts('dist/browser/pangu.min.js', 'format.js?v=20261015-pangu');

self.onmessage = ({ data }) => {
    const { id, text } = data ?? {};
    try {
        if (typeof text !== 'string' || text.length > 200000) throw new Error('单次最多处理 20 万字符，请分段处理');
        if (typeof self.pangu?.spaceText !== 'function') throw new Error('排版组件加载失败');
        const result = self.spaceTextWithUrls(text, self.pangu.spaceText.bind(self.pangu));
        self.postMessage({ id, result });
    } catch (error) {
        self.postMessage({ id, error: error instanceof Error ? error.message : '排版失败' });
    }
};
