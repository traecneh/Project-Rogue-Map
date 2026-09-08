// Lazy worker: ordinary map use never downloads navigation data or allocates
// search memory. Cancellation resolves the caller as well as stopping old work.
export function createSmartMeasureClient() {
  let worker = null, pending = null, sequence = 0;
  function cancel() {
    if (!pending) return;
    worker?.postMessage({ type: 'cancel', id: pending.id });
    pending.resolve({ status: 'cancelled' });
    pending = null;
  }
  function request(floor, points) {
    cancel();
    return new Promise(resolve => {
      try {
        if (!worker) {
          worker = new Worker(new URL('./smart-measure-worker.js', import.meta.url), { type: 'module' });
          worker.onmessage = ({ data }) => {
            if (data.id !== pending?.id) return;
            const done = pending.resolve; pending = null; done(data);
          };
          worker.onerror = () => {
            const done = pending?.resolve;
            pending = null; worker.terminate(); worker = null;
            done?.({ status: 'unavailable' });
          };
        }
        const id = ++sequence;
        pending = { id, resolve };
        worker.postMessage({ type: 'route', id, floor, points });
      } catch {
        pending = null;
        worker?.terminate(); worker = null;
        resolve({ status: 'unavailable' });
      }
    });
  }
  return { request, cancel };
}
