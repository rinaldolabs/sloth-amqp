import { errMessage, SlothValidationError } from './errors.js';
import type { SlothLogger } from './logger.js';
import type { OnWireMessage, SlothWireEvent } from './types.js';

/**
 * Builds a wire-tap emitter that never lets the caller's hook break the data
 * path. Returns a no-op when no hook is supplied — the `produce` thunk is only
 * called when there's a hook, so callers pay nothing (no event object, no field
 * reads) on the common no-hook path. The hook is invoked synchronously and not
 * awaited; if it throws, the error is swallowed and logged as
 * `sloth.wire.hook_failed` via the injected logger. The library itself logs no
 * payloads — this hook is the only opt-in path message bytes leave.
 *
 * Throws `SlothValidationError` at construction if `onWireMessage` is provided
 * but isn't a function (a JS-caller guard; TS already enforces the type).
 */
export const makeWireEmitter = (
  onWireMessage: OnWireMessage | undefined,
  logger: SlothLogger,
): ((produce: () => SlothWireEvent) => void) => {
  if (onWireMessage !== undefined && typeof onWireMessage !== 'function') {
    throw new SlothValidationError('onWireMessage must be a function');
  }
  return (produce: () => SlothWireEvent): void => {
    if (!onWireMessage) return;
    const event = produce();
    try {
      onWireMessage(event);
    } catch (err) {
      logger.warn(`sloth: onWireMessage hook threw: ${errMessage(err)}`, {
        event: 'sloth.wire.hook_failed',
        direction: event.direction,
        reason: errMessage(err),
      });
    }
  };
};
