import assert from 'node:assert/strict';
import { load } from 'cheerio';

// Shared by the committed-page test and synthetic updater regression tests.
// The red candidate preserves the original production assertions verbatim.
export function assertPublishedDateProjection(html, payload, history) {
  const $ = load(html);
  assert.equal($('#applePublishedDate').text(), '2026/09/15');
  assert.equal(payload.source.publishedDate, 'September 16, 2026', 'raw Apple observation remains preserved');
}
