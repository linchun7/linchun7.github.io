# Apple page snapshots

Each Apple `Published Date` has one index record. A record can contain multiple validated revisions when Apple changes pricing without changing the published date.

Archived pages are imported offline only after two independent parser paths agree and the normal data-integrity checks pass. Future live pages are saved only after parsing, completeness, exchange-rate, and price-anomaly validation succeeds.

The `.html` file is the original page evidence. The matching `.json` file contains only normalized tiers, regions, currencies, and prices. `firstConfirmedDate` is the date this project first validated that revision; precise download timestamps are intentionally not stored.
