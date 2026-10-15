# Renovation calculator boundaries

- `core.js` owns decimal half-up money rounding, the existing Horner NPV / bounded bisection IRR, annualization, and complete repayment schedules. It takes the same already-validated, cent-normalized numeric inputs as before. It does not read or write the DOM, format display text, download files, or mutate its input.
- `script.js` owns input validation and warnings, formatting, synchronous UI updates, result invalidation, and CSV downloads. It delegates calculation to the core; the full schedule and every early-settlement APR are still ready when calculation returns.
- `index.html` loads the versioned core immediately before the UI. Both scripts opt out of Rocket Loader. No worker, asynchronous scheduling, lazy result calculation, or product-rule change is introduced.

## GitHub Actions acceptance

The existing `Validate static tools` three-browser matrix runs `tools/browser-tests/renovation-rounding-regression.mjs`. That entry imports `test/core-regression.mjs` before exercising the real page and CSV export. No separate workflow is needed.

The core checks compare every result field exactly against the script at fixed pre-extraction commit `657959ff0865ff609cedf729c97aa04129d8265f`, using the workflow's full Git history. They also cover independent integer-cent principal conservation, decimal half-cent boundaries, zero fees, 600-month inputs, direct-discounted full/early-settlement APR, input immutability, and native startup ordering.

The Actions log includes paired compute-only timings at 12, 60, 360, and 600 months. Both implementations use isolated VM contexts and alternating order. Timings are diagnostics with no pass/fail speed threshold: extraction improves separation and direct testability; it does not establish a user-visible performance improvement. DOM rendering and CSV work are intentionally unchanged.

## Removed duplication

The former inline `decimalFraction`, `roundMoney`, `npv`, `IRR`, `annualizeMonthlyIRR`, and `generateSchedule` implementations were removed from `script.js`; the core is the single shipped numerical source. The UI retains aliases for existing page callers. A regression assertion rejects duplicate function declarations in the UI. The fixed Git-history oracle and independent regression references remain test-only. No historical data or unrelated tool files were removed.
