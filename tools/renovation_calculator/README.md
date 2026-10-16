# Renovation calculator boundaries

- `core.js` owns decimal half-up money rounding, the existing Horner NPV / bounded bisection IRR, annualization, and complete repayment schedules. It takes the same already-validated, cent-normalized numeric inputs as before. It does not read or write the DOM, format display text, download files, or mutate its input.
- `script.js` owns input validation and warnings, formatting, synchronous UI updates, result invalidation, and CSV downloads. It delegates calculation to the core; the full schedule and every early-settlement APR are still ready when calculation returns.
- `index.html` loads the versioned core immediately before the UI. Both scripts opt out of Rocket Loader. No worker, asynchronous scheduling, lazy result calculation, or product-rule change is introduced.

## GitHub Actions acceptance

The existing `Validate static tools` three-browser matrix runs `tools/browser-tests/renovation-rounding-regression.mjs`. That entry imports `test/core-regression.mjs` before exercising the real page and CSV export, then runs the dedicated `test/render-regression.mjs` browser acceptance. No separate workflow is needed.

The core checks compare every result field exactly against the script at fixed pre-extraction commit `657959ff0865ff609cedf729c97aa04129d8265f`, using the workflow's full Git history. They also cover independent integer-cent principal conservation, decimal half-cent boundaries, zero fees, 600-month inputs, direct-discounted full/early-settlement APR, input immutability, and native startup ordering.

The Actions log includes paired compute-only timings at 12, 60, 360, and 600 months. Both implementations use isolated VM contexts and alternating order. Timings are diagnostics with no pass/fail speed threshold: extraction improves separation and direct testability; it does not establish a user-visible performance improvement. That numerical extraction left DOM rendering and CSV work unchanged.

## Reuse the fixed money formatter

The UI now creates one `Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })` and reuses it for table and CSV money cells. Every call still applies the exact same `roundMoney` first. The solver, validation, synchronous update flow, all numeric fields, display text, CSV quoting/BOM/filename, and export lifetime are unchanged. Only the UI script cache version changes; there is no new runtime dependency or shared formatting framework.

The dedicated browser regression serves the same committed HTML to both implementations, even with a remote `BASE_URL`. This isolates the formatter comparison from edge-injected readiness replay without relaxing numeric, rendering, CSV or formatter-count assertions. The independent `startup-replay-regression.mjs` runs against the untouched page, including production when requested, and verifies single binding, single click/Enter execution and unchanged results after repeated readiness events. Initialization listeners are one-shot; numerical code is unchanged.

The dedicated browser regression uses fixed pre-cache commit `0101f1db88602380c45290449bb4743a35db8333` as the shipped-source oracle and reads the actual candidate UI from disk. At 12, 60 and 600 months it compares the complete numerical result, rendered HTML and CSV bytes exactly, and counts formatter construction separately. A baseline render creates `5N + 6` formatters and its CSV creates `5N + 3`; the candidate creates one per page across repeated calculations and exports.

Paired real-browser timings include the complete table formatting, DOM insertion and synchronous layout, or the real CSV export handler with its Blob/object-URL lifecycle. Both use the same precomputed schedule, three warmups and twelve alternating-order rounds. Constructor-count instrumentation is disabled for timed samples. Actions reports every sample plus median/min/max. The initial [test-only candidate run](https://github.com/linchun7/linchun7.github.io/actions/runs/38670207686) established a benefit before production changed; final acceptance measures the shipped implementation. Timings are diagnostics, with no fragile speed threshold or claim about numerical solving, end-to-end calculation latency, or every user's device.

## Removed duplication

The former inline `decimalFraction`, `roundMoney`, `npv`, `IRR`, `annualizeMonthlyIRR`, and `generateSchedule` implementations were removed from `script.js`; the core is the single shipped numerical source. The UI retains aliases for existing page callers. A regression assertion rejects duplicate function declarations in the UI. The fixed Git-history oracle and independent regression references remain test-only. No historical data or unrelated tool files were removed.
