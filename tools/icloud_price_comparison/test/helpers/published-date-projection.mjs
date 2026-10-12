import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { displayedPublishedDate, publicationDateKey } from '../../data-contract.js';

// Shared by the committed-page test and synthetic updater regression tests.
export function assertPublishedDateProjection(html, payload, history) {
  const $ = load(html);
  const publishedDate = displayedPublishedDate(history, payload.source.publishedDate);
  const expectedDate = /^[A-Za-z]+ \d{1,2}, \d{4}$/.test(publishedDate)
    ? publicationDateKey(publishedDate).replaceAll('-', '/')
    : publishedDate;
  assert.equal($('#applePublishedDate').text(), expectedDate);
  assert.equal(
    JSON.parse($('#icloud-price-data').text()).prices.source.publishedDate,
    payload.source.publishedDate,
    'raw Apple observation remains preserved'
  );
}
