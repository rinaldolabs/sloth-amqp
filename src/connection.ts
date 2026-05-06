import amqp, { type ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import type { SlothSetup } from './types.js';

/**
 * Optional per-call cancellation knobs. Either is sufficient on its own;
 * if both are provided, whichever fires first wins and its `reason`
 * propagates verbatim to the rejection.
 *
 * The reason follows WHATWG semantics:
 * - `AbortSignal.timeout(ms)` rejects with a `DOMException` whose `name` is
 *   `'TimeoutError'`.
 * - `controller.abort()` (no argument) rejects with a `DOMException` whose
 *   `name` is `'AbortError'`.
 * - `controller.abort(reason)` rejects with `reason` as-is — could be an
 *   `Error`, a `DOMException`, a string, or anything else the caller passes.
 *   This package never wraps; whatever you pass is what callers catch.
 */
export interface SlothConnectOptions {
  /** Caller-supplied AbortSignal — useful when one signal scopes many ops. */
  signal?: AbortSignal;
  /** Convenience timeout — equivalent to passing `AbortSignal.timeout(ms)`. */
  timeoutMs?: number;
}

const isOptions = (v: unknown): v is SlothConnectOptions =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export async function slothConnect(url: string, ...setups: SlothSetup[]): Promise<ChannelModel>;
export async function slothConnect(
  url: string,
  options: SlothConnectOptions,
  ...setups: SlothSetup[]
): Promise<ChannelModel>;
export async function slothConnect(
  url: string,
  ...rest: (SlothConnectOptions | SlothSetup | undefined)[]
): Promise<ChannelModel> {
  if (!url) {
    throw new Error('AMQP URL must not be empty');
  }
  const [first, ...remaining] = rest;
  const firstIsOptions = isOptions(first);
  const options: SlothConnectOptions = firstIsOptions ? first : {};
  // Discriminator semantics:
  // - `first` is an options bag → setups are the remaining args.
  // - `first` is a setup function → it plus remaining args are setups.
  // - `first` is `undefined` → treat as "no options provided", use remaining
  //   args as setups. This matters when a caller passes
  //   `slothConnect(url, maybeOptions, setupFn)` with `maybeOptions` being
  //   an optional variable that happens to be `undefined`.
  const restSetups = remaining.filter((v): v is SlothSetup => v !== undefined);
  const setups: SlothSetup[] = firstIsOptions
    ? restSetups
    : first === undefined
      ? restSetups
      : [first, ...restSetups];

  const signal = combineAbort(options.signal, options.timeoutMs);

  // Fail fast if the caller-supplied signal already aborted — don't open a
  // socket only to tear it down.
  if (signal?.aborted) throw signal.reason as unknown;

  // amqplib has no native AbortSignal support, so we race. If the signal
  // wins, the connect promise may still resolve later with an open socket;
  // `safeClose` ensures it gets closed instead of leaking.
  const client = await raceWithAbort(amqp.connect(url), signal, safeClose);

  // If the signal aborts during setups, close the connection we just opened
  // so it doesn't leak, then propagate the abort reason.
  try {
    await raceWithAbort(
      Promise.all(setups.map((fn) => fn(client))).then(() => undefined),
      signal,
    );
  } catch (error) {
    await safeClose(client);
    throw error;
  }

  return client;
}

export const slothClose = (client: ChannelModel): Promise<void> => client.close();
