import assert from 'node:assert/strict';
import test from 'node:test';
import { runBrowserStage } from './helpers/browser-stage.mjs';

test('never-resolving startup fails with its stage rather than the outer test timer', async () => {
  await assert.rejects(runBrowserStage('browser launch', () => new Promise(() => {}), {timeoutMs: 15}), /browser launch/);
});
test('parent cancellation rejects and disposes a late-created page exactly once', async () => {
  const controller = new AbortController();
  let finish; let cleaned = 0;
  const stage = runBrowserStage('page creation', () => new Promise(resolve => { finish = resolve; }),
    {signal: controller.signal, dispose: async page => { assert.equal(page.id, 1); cleaned += 1; }});
  await Promise.resolve();
  controller.abort(new Error('test cancelled'));
  await assert.rejects(stage, /page creation/);
  finish({id: 1});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, 1);
});
test('successful resources remain owned by the caller and timers are cleared', async () => {
  let cleaned = 0;
  const value = await runBrowserStage('context', async () => 42, {dispose: async () => { cleaned += 1; }});
  assert.equal(value, 42); assert.equal(cleaned, 0);
});
test('already aborted tests cannot begin another browser action', async () => {
  const controller = new AbortController(); controller.abort();
  let called = false;
  await assert.rejects(runBrowserStage('navigation', () => {called = true;}, {signal: controller.signal}), /navigation/);
  assert.equal(called, false);
});
test('operation failures keep the original error as cause', async () => {
  const original = new Error('page closed');
  await assert.rejects(runBrowserStage('error-state wait', async () => {throw original;}),
    error => /error-state wait/.test(error.message) && error.cause === original);
});
test('cleanup has its own bounded deadline', async () => {
  await assert.rejects(runBrowserStage('cleanup', () => new Promise(() => {}), {timeoutMs: 15}), /cleanup/);
});
