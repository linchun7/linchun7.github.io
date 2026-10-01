// A deadline must reject promptly, even when a browser resource is created late.
// Late resources are disposed instead of leaking into the next test.
export async function runBrowserStage(name, operation, { signal, timeoutMs = 8000, dispose = async () => {} } = {}) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('UI stage timed out: ' + name)), timeoutMs);
  let settled = false;
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => {
        if (settled) return;
        settled = true;
        reject(new Error('UI stage aborted: ' + name, { cause: controller.signal.reason }));
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) { abort(); return; }
      Promise.resolve().then(() => operation(controller.signal)).then(async value => {
        if (settled) {
          try { await dispose(value); } catch (error) { console.error('Late UI resource cleanup failed:', name, error.message); }
          return;
        }
        settled = true;
        resolve(value);
      }, error => {
        if (!settled) { settled = true; reject(new Error('UI stage failed: ' + name, { cause: error })); }
      });
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abort);
  }
}
