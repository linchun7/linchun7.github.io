import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeExceptionGuard } from './runtime-exception-guard.mjs';

test('normal protocol traffic and caught evaluation errors do not count as uncaught', () => {
  const guard = createRuntimeExceptionGuard();
  guard.record({ id: 1, result: { exceptionDetails: { text: 'caught by evaluate' } } });
  guard.record({ method: 'Runtime.consoleAPICalled', params: {} });
  guard.record({ method: 'Page.loadEventFired' });
  guard.assertClean();
});
test('uncaught errors fail acceptance even after a later navigation succeeds', () => {
  const guard = createRuntimeExceptionGuard();
  guard.record({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { exception: { description: 'Error: injected page failure' } } } });
  guard.record({ method: 'Page.loadEventFired' });
  assert.throws(() => guard.assertClean(), /Uncaught page exceptions \(1\):[\s\S]*injected page failure/);
});
test('malformed exception events still fail and diagnostics stay bounded', () => {
  const guard = createRuntimeExceptionGuard();
  for (let i = 0; i < 12; i++) guard.record({ method: 'Runtime.exceptionThrown' });
  assert.throws(() => guard.assertClean(), /Uncaught page exceptions \(12\)/);
});
