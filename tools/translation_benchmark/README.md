# Browser translation benchmark

Six independent language pages each contain 16 categories and 48 fixed samples in their initial HTML response. The pages work without JavaScript and do not fetch the six-language corpus, run a renderer, or call a translation API. The original wording and CSS hooks are preserved for browser-translation comparisons.

## Corpus and generated pages

- Edit only the sample text in `scripts/corpus.mjs` (the single build-time source).
- The six language HTML shells remain hand-maintained outside the clearly marked generated regions.
- Generate the six marked regions with `node tools/translation_benchmark/scripts/render-pages.mjs --write`.
- Commit the generated HTML alongside the corpus changes.
- The generator escapes corpus text, preserves Unicode, and gives each category an accessible heading and correctly numbered ordered list.
- These scripts are development tools only. No language page imports them.

## Verification

All generation and test execution for this change takes place in GitHub Actions, using the existing Validate static tools workflow. No local test run is required or claimed.

- `node tools/translation_benchmark/scripts/render-pages.mjs --check` rejects stale checked-in HTML.
- `node --test tools/translation_benchmark/test/*.test.mjs` checks corpus shape, exact generated-region consistency, idempotence, escaping, markup injection, language isolation and invalid inputs.
- `node tools/browser-tests/translation-load-regression.mjs` runs in the existing Chromium / Firefox / WebKit matrix. It verifies all 48 exact samples at the document-response and DOM levels with JavaScript enabled, disabled and all script requests blocked; it also covers reload, language navigation, Back / Forward, narrow screens and decoded hostile text.

The retained translation-test hooks are `body[data-language]`, `#categoryList`, `.category-section`, `.sample-item`, `.sample-index`, `.sample-text`, the source `lang`, and the current-page navigation state.
