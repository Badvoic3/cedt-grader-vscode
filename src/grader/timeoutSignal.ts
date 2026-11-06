/**
 * A signal that aborts after `ms`, or as soon as `parent` does. Stands in for
 * combining `AbortSignal.timeout` with `AbortSignal.any`, which VS Code 1.82's
 * Node 18.15 lacks. Stays active until it fires, so it also limits reading a
 * response body after the headers arrived. The timer never keeps the process
 * alive, and the listener on `parent` lasts `ms` at most, so nothing needs
 * disposing.
 */
export function withTimeoutSignal(ms: number, parent?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  if (parent?.aborted) {
    controller.abort(parent.reason);
    return controller.signal;
  }
  const onParentAbort = () => {
    clearTimeout(timer);
    controller.abort(parent?.reason);
  };
  const timer = setTimeout(() => {
    parent?.removeEventListener('abort', onParentAbort);
    // The name `networkErrorFrom` reads to tell a timeout from other failures.
    controller.abort(new DOMException('The request timed out.', 'TimeoutError'));
  }, ms);
  timer.unref?.();
  parent?.addEventListener('abort', onParentAbort, { once: true });
  return controller.signal;
}
