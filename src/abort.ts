/**
 * Best-effort close: invokes `.close()` on a resource (channel, connection,
 * etc.) and swallows any rejection. Used as the `onLoserSettle` callback
 * for `raceWithAbort` so a connection that resolves *after* the abort
 * doesn't leak. The `.catch` is intentional — at this point the operation
 * has already failed; close errors are best logged elsewhere, not raised.
 */
export const safeClose = (resource: { close: () => Promise<unknown> }): Promise<void> =>
  resource.close().then(
    () => undefined,
    () => undefined,
  );

/**
 * Composes a caller-supplied `AbortSignal` with an optional internal
 * `timeoutMs` into a single signal. Returns `undefined` for the signal
 * when neither input is provided so callers can short-circuit.
 *
 * The composite uses `AbortSignal.any([...])` (Node 20+/24 native) so
 * whichever source aborts first wins — and `signal.reason` carries the
 * correct WHATWG DOMException by reference: `TimeoutError` from
 * `AbortSignal.timeout`, `AbortError` from `AbortController.abort()`.
 *
 * Validates `timeoutMs` upfront so consumers get a clear error before any
 * I/O is attempted.
 */
export const combineAbort = (
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined => {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error('timeoutMs must be a positive finite number');
  }
  const parts: AbortSignal[] = [];
  if (signal) parts.push(signal);
  if (timeoutMs !== undefined) parts.push(AbortSignal.timeout(timeoutMs));
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
};

/**
 * Races a promise against an `AbortSignal`. If the signal aborts before the
 * promise settles, rejects with `signal.reason`.
 *
 * Three properties enforced:
 * 1. **Listener cleanup.** `{ once: true }` covers the abort-fires path;
 *    `removeEventListener` in `finally` covers the promise-wins path. Both
 *    are required — long-lived signals would otherwise accumulate listeners.
 * 2. **Loser-promise containment.** When abort wins, the input promise is
 *    still pending. We attach `.catch(() => {})` so a later rejection does
 *    not surface as `unhandledRejection`. Callers responsible for a
 *    *resource* (e.g. an open connection) must pass `onLoserSettle` to be
 *    invoked with the resolved value so they can clean it up.
 * 3. **Reason fidelity.** Whatever `signal.reason` is gets rethrown as-is
 *    (matches WHATWG `fetch`/undici behaviour). `controller.abort('str')`
 *    surfaces the string verbatim; `AbortSignal.timeout` surfaces the
 *    standard `DOMException('TimeoutError')`.
 */
export const raceWithAbort = async <T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLoserSettle?: (value: T) => void | Promise<void>,
): Promise<T> => {
  if (!signal) return promise;
  if (signal.aborted) {
    // Swallow loser so a later rejection doesn't surface as unhandled.
    promise
      .then((value) => onLoserSettle?.(value))
      .catch(() => undefined);
    throw signal.reason as unknown;
  }

  // Construct the listener synchronously so `finally` always has something
  // to remove — keeps the cleanup path branch-free.
  const onAbort = (reject: (reason: unknown) => void) => (): void => {
    reject(signal.reason as unknown);
  };
  let listener!: () => void;
  const abortPromise = new Promise<never>((_, reject) => {
    listener = onAbort(reject);
    signal.addEventListener('abort', listener, { once: true });
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } catch (error) {
    // Abort won: the input promise is still pending. Swallow its eventual
    // rejection (no unhandledRejection) and hand a successful resolution to
    // the caller's cleanup hook so any acquired resource can be released.
    promise
      .then((value) => onLoserSettle?.(value))
      .catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', listener);
  }
};
