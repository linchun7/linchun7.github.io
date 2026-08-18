'use strict';

importScripts('core.js?v=20260818-1');

self.onmessage = function (event) {
    if (event.data.type !== 'start') return;

    try {
        const { input, validDigits, limit } = event.data;
        const result = self.CardNumberCore.calculate({
            input,
            validDigits,
            limit,
            chunkSize: 2000,
            onMeta(expectedCount) {
                postMessage({ type: 'meta', expectedCount });
            },
            onChunk(data, count) {
                postMessage({ type: 'chunk', data, count });
            }
        });

        postMessage({
            type: 'done',
            count: result.count,
            truncated: result.truncated
        });
    } catch (error) {
        postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
    }
};
