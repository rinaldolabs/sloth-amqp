export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Stable, machine-readable discriminant on every {@link SlothError}. Lets
 * callers branch on failure kind without matching message strings:
 *
 * ```ts
 * catch (e) {
 *   if (e instanceof SlothTimeoutError) retry();
 *   else if (e instanceof SlothValidationError) throw e; // caller bug
 * }
 * ```
 */
export type SlothErrorCode =
  'SLOTH_VALIDATION' | 'SLOTH_PUBLISH' | 'SLOTH_TIMEOUT' | 'SLOTH_CONNECT';

/**
 * Base class for every error this library throws. Carries a readonly {@link code}
 * discriminant. Subclassing `Error` is safe without `setPrototypeOf` because the
 * package compiles to ES2024 (no down-level), so `instanceof` works natively.
 * Note: abort/timeout from a caller's own `AbortSignal` still surfaces as the
 * WHATWG `DOMException` (`AbortError`/`TimeoutError`) — this hierarchy covers the
 * library's own failures, not the platform's abort reasons.
 */
export abstract class SlothError extends Error {
  abstract readonly code: SlothErrorCode;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Invalid input caught at a boundary before any AMQP work (delay spec, config, URL, etc.). */
export class SlothValidationError extends SlothError {
  readonly code = 'SLOTH_VALIDATION';
}

/** A publish failed — broker nack, channel error, or non-serializable payload. */
export class SlothPublishError extends SlothError {
  readonly code = 'SLOTH_PUBLISH';
}

/** An operation exceeded its `timeoutMs` / `signal` deadline (publish confirm, etc.). */
export class SlothTimeoutError extends SlothError {
  readonly code = 'SLOTH_TIMEOUT';
}

/** Connection or listener setup failed. */
export class SlothConnectError extends SlothError {
  readonly code = 'SLOTH_CONNECT';
}
