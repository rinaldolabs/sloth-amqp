import type { ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { errMessage, SlothConnectError, toSlothError } from './errors.js';
import { NoOpLogger, resolveLogger, type SlothLogger, type SlothLogLevel } from './logger.js';
import { slothRequestExchangeName } from './utils.js';

export interface PingOptions {
  /** Caller-supplied AbortSignal — same semantics as on slothConnect. */
  signal?: AbortSignal;
  /** Convenience timeout — equivalent to passing AbortSignal.timeout(ms). */
  timeoutMs?: number;
  /** Optional logger; defaults to NoOpLogger. */
  logger?: SlothLogger;
  /** Optional minimum level for this library's log calls. */
  logLevel?: SlothLogLevel;
}

/**
 * Liveness probe for the Sloth broker.
 *
 * Opens a temporary AMQP channel, asserts that the Sloth request exchange
 * is reachable via passive `checkExchange`, then closes the channel. The
 * probe completes if and only if:
 *   1. the broker accepts a new channel on the existing connection, and
 *   2. the Sloth request exchange (`sloth.direct.exchange.request`) exists.
 *
 * Suitable for Kubernetes readiness/liveness probes and graceful-startup
 * health checks. Throws on broker unreachability, missing exchange, or
 * timeout/abort.
 *
 * @example
 *   try {
 *     await ping(client, { timeoutMs: 2_000 });
 *     // healthy
 *   } catch (err) {
 *     // unhealthy: broker down, Sloth not deployed, or timeout
 *   }
 */
export const ping = async (client: ChannelModel, opts: PingOptions = {}): Promise<void> => {
  const signal = combineAbort(opts.signal, opts.timeoutMs);
  if (signal?.aborted) throw signal.reason as unknown;
  const logger = resolveLogger(opts.logger ?? new NoOpLogger(), opts.logLevel);

  try {
    const channel = await raceWithAbort(client.createChannel(), signal, safeClose);
    // A failed checkExchange (exchange missing — the documented probe-failure
    // case) makes the broker close the channel, and amqplib emits 'error' on
    // it. Without a listener that emit would escape as an uncaught exception
    // and can tear down the whole shared connection. The rejection below is
    // the real failure signal; the event is just noise to absorb.
    channel.on('error', (err: unknown) => {
      logger.debug('sloth: ping channel error', {
        event: 'sloth.ping.channel_error',
        reason: errMessage(err),
      });
    });
    try {
      await raceWithAbort(channel.checkExchange(slothRequestExchangeName), signal);
    } finally {
      await safeClose(channel);
    }
  } catch (error) {
    logger.error('sloth: ping failed', {
      event: 'sloth.ping.failed',
      reason: errMessage(error),
    });
    // Typed-error contract: foreign (amqplib/broker) failures surface as
    // SlothConnectError with the cause chained; abort reasons pass verbatim.
    throw toSlothError(error, signal, SlothConnectError);
  }
};
