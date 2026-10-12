import assert from 'node:assert/strict';

// Keep independent adversarial probes in the existing three-browser CI path.
// A failed module must not prevent the remaining modules from reporting evidence.
const probes = [
    "hospital-adversarial-interaction-regression.mjs",
    "bank-dialog-close-regression.mjs",
    "card-number-input-regression.mjs",
    "card-number-worker-failure-regression.mjs",
    "card-number-pagination-regression.mjs",
    "calculator-state-regression.mjs",
    "navigation-breakpoint-regression.mjs",
    "myip-empty-location-regression.mjs",
    "pinyin-copy-focus-regression.mjs",
    "translation-load-regression.mjs"
];
const failures = [];
for (const probe of probes) {
    try {
        await import(`./${probe}`);
        console.log(JSON.stringify({ label: 'adversarial-interactions', probe, status: 'passed' }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ probe, message });
        console.error(JSON.stringify({ label: 'adversarial-interactions', probe, status: 'failed', message }));
    }
}
assert.deepEqual(failures, [], 'adversarial interaction regression failures');
