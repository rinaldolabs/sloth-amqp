import amqp, { type ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { SlothValidationError } from './errors.js';
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
  /**
   * Human-readable name shown in RabbitMQ's management UI and
   * `rabbitmqctl list_connections`. Sent as `clientProperties.connection_name`.
   * Use it to identify which service/pod/version owns a connection. Avoid PII;
   * `slothClientProperties` builds a sensible `<serviceName>:sloth-amqp@<host>`
   * default. Takes precedence over a `connection_name` in `clientProperties`.
   */
  connectionName?: string;
  /**
   * Extra AMQP client properties merged into the connection's
   * `clientProperties` (advertised to the broker on handshake). Do not put the
   * AMQP URL, credentials, or other secrets here — these are visible in the
   * broker's management UI.
   */
  clientProperties?: Record<string, unknown>;
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
    throw new SlothValidationError('AMQP URL must not be empty');
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

  // Merge connection_name into clientProperties so the connection is
  // identifiable in RabbitMQ's management UI. Only build socketOptions when the
  // caller asked for something — otherwise pass nothing and keep the bare
  // connect path unchanged.
  const clientProperties: Record<string, unknown> = { ...options.clientProperties };
  if (options.connectionName !== undefined) {
    clientProperties['connection_name'] = options.connectionName;
  }
  const socketOptions = Object.keys(clientProperties).length > 0 ? { clientProperties } : undefined;

  // amqplib has no native AbortSignal support, so we race. If the signal
  // wins, the connect promise may still resolve later with an open socket;
  // `safeClose` ensures it gets closed instead of leaking.
  const client = await raceWithAbort(
    socketOptions ? amqp.connect(url, socketOptions) : amqp.connect(url),
    signal,
    safeClose,
  );

  // Run setups sequentially in argument order. They share one ChannelModel,
  // so a later setup may depend on a resource an earlier one declared (e.g.
  // bind a queue an earlier setup asserted); amqplib serialises RPCs per
  // channel but gives no cross-setup ordering guarantee, so Promise.all could
  // race a bindQueue ahead of its assertQueue. Sequential awaits are cheap
  // (a handful of calls at connect time) and match amqp-connection-manager /
  // rascal. If the signal aborts mid-setup, close the connection we just
  // opened so it doesn't leak, then propagate the abort reason.
  const runSetups = async (): Promise<void> => {
    for (const fn of setups) await fn(client);
  };
  try {
    await raceWithAbort(runSetups(), signal);
  } catch (error) {
    await safeClose(client);
    throw error;
  }

  return client;
}

export const slothClose = (client: ChannelModel): Promise<void> => client.close();
