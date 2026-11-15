import assert from 'node:assert/strict';

// Keep failures across reloads: a later successful page must not erase an
// uncaught exception from an earlier interaction. Bound diagnostics, not count.
export function createRuntimeExceptionGuard() {
  let count = 0;
  const samples = [];
  return {
    record(message) {
      if (message?.method !== 'Runtime.exceptionThrown') return;
      count += 1;
      if (samples.length < 10) {
        const details = message.params?.exceptionDetails;
        samples.push(String(details?.exception?.description || details?.text || 'Unknown page exception').slice(0, 2000));
      }
    },
    assertClean() {
      assert.equal(count, 0, 'Uncaught page exceptions (' + count + '):\n' + samples.join('\n'));
    },
  };
}
