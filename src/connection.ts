import amqp, { type ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import type { SlothSetup } from './types.js';

/**
 * Optional per-call cancellation knobs. Either is sufficient on its own;
 * if both are provided, whichever fires first wins and its `reason`
 * (`AbortError` or `TimeoutError`) is what the rejection carries.
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
  ...rest: (SlothConnectOptions | SlothSetup)[]
): Promise<ChannelModel> {
  if (!url) {
    throw new Error('AMQP URL must not be empty');
  }
  const [first, ...remaining] = rest;
  const options: SlothConnectOptions = isOptions(first) ? first : {};
  // After the discriminator: anything remaining must be a SlothSetup. The
  // type-narrowing keeps the public overload signatures honest.
  const setups: SlothSetup[] = isOptions(first)
    ? (remaining as SlothSetup[])
    : first !== undefined
      ? [first, ...(remaining as SlothSetup[])]
      : [];

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
