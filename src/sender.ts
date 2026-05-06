import { randomUUID } from 'node:crypto';
import type { ChannelModel, ConfirmChannel } from 'amqplib';
import { errMessage } from './errors.js';
import { resolveLogger } from './logger.js';
import type { DelaySpec, SendDelayMessageParams } from './types.js';
import { assertSafeSlothConfig, getSlothTarget, slothRequestExchangeName } from './utils.js';

/** ~100 years in seconds — prevents unix timestamp overflow in the delay-until header. */
export const MAX_DELAY_SECONDS = 100 * 365 * 24 * 3600;

/**
 * Headers reserved by the Sloth wire protocol. Callers cannot override these
 * via `params.headers`; passing them throws before any AMQP work happens.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['delay-until', 'target']);

const mergeReservedHeaders = (
  headers: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> => {
  if (!headers) return {};
  for (const key of Object.keys(headers)) {
    if (RESERVED_HEADERS.has(key)) {
      throw new Error(
        `headers.${key} is reserved by the Sloth wire protocol and cannot be overridden`,
      );
    }
  }
  return headers;
};

/**
 * Strips control and newline-like characters and truncates to 200 grapheme clusters
 * so caller-supplied labels cannot inject line breaks or escape sequences into log output.
 * Removed: ASCII controls (U+0000–U+001F), DEL (U+007F), NEL (U+0085),
 *           Unicode line separator (U+2028), paragraph separator (U+2029).
 */
const segmenter = new Intl.Segmenter();
const isUnsafeChar = (c: string): boolean => {
  const n = c.codePointAt(0);
  return n !== undefined && (n <= 0x1f || n === 0x7f || n === 0x85 || n === 0x2028 || n === 0x2029);
};
export const sanitizeLabel = (raw: string): string =>
  Array.from(segmenter.segment(raw), (s) => s.segment)
    .filter((c) => !isUnsafeChar(c))
    .slice(0, 200)
    .join('');

/**
 * Resolves whichever delay variant is set into an absolute unix timestamp
 * (seconds since epoch) and a human-readable description for log lines.
 * Throws on invalid input or out-of-range values. Past delayUntil dates
 * return a pastDateWarning instead of throwing.
 */
export const resolveDelaySeconds = (
  params: DelaySpec,
): { delayUntilUnix: number; delayDesc: string; pastDateWarning?: string } => {
  const { delayUntil, delaySeconds, delayMinutes } = params;
  const setCount = [delayUntil, delaySeconds, delayMinutes].filter((v) => v !== undefined).length;
  if (setCount !== 1)
    throw new Error('exactly one of delayMinutes, delaySeconds, or delayUntil must be provided');
  const nowMs = Date.now();

  if (delayUntil !== undefined) {
    const ms = delayUntil.getTime();
    if (!Number.isFinite(ms)) throw new Error('delayUntil is an invalid Date');
    const delayUntilUnix = Math.ceil(ms / 1000);
    if (delayUntilUnix - Math.floor(nowMs / 1000) > MAX_DELAY_SECONDS)
      throw new Error('delayUntil exceeds maximum allowed delay of 100 years');
    const base = { delayUntilUnix, delayDesc: `until=${delayUntil.toISOString()}` };
    return ms <= nowMs
      ? {
          ...base,
          pastDateWarning: `delayUntil ${delayUntil.toISOString()} is in the past — Sloth will deliver immediately`,
        }
      : base;
  }

  if (delaySeconds !== undefined) {
    if (!Number.isFinite(delaySeconds) || delaySeconds <= 0)
      throw new Error('delaySeconds must be a positive finite number');
    if (delaySeconds > MAX_DELAY_SECONDS)
      throw new Error('delaySeconds exceeds maximum allowed delay of 100 years');
    return {
      delayUntilUnix: Math.floor((nowMs + delaySeconds * 1000) / 1000),
      delayDesc: `delay=${String(delaySeconds)}s`,
    };
  }

  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0)
    throw new Error('delayMinutes must be a positive finite number');
  if (delayMinutes * 60 > MAX_DELAY_SECONDS)
    throw new Error('delayMinutes exceeds maximum allowed delay of 100 years');
  return {
    delayUntilUnix: Math.floor((nowMs + delayMinutes * 60 * 1000) / 1000),
    delayDesc: `delay=${String(delayMinutes)}min`,
  };
};

/** Serializes data to a Buffer, throwing a clear error if the value is not JSON-serializable. */
export const serializeData = (data: unknown): Buffer => {
  try {
    return Buffer.from(JSON.stringify(data));
  } catch {
    throw new Error('data is not JSON-serializable');
  }
};

/**
 * The object returned by {@link createDelaySender}. Exposes a single `send`
 * method today; returning an object (rather than a bare function) leaves room
 * for future methods like `sendBatch` without another breaking change, and
 * avoids the `getSender()(params)` smell at consumer wrappers.
 */
export interface DelaySender {
  send<TData>(params: SendDelayMessageParams<TData>): Promise<void>;
}

/**
 * Creates a delayed-message sender bound to the given `ChannelModel`.
 *
 * Internally caches a single confirm channel for the lifetime of the returned
 * sender (matching the Go client's shared-publisher model). The exchange is
 * asserted once on the first publish. If the channel emits `error` or `close`,
 * the cache is dropped and the next call re-creates it transparently.
 *
 * Uses `createConfirmChannel` so each publish awaits a broker ack — a `send`
 * that resolves means the broker has accepted the message, not just that it
 * was written to the local socket. A nack from the broker rejects the promise.
 */
export const createDelaySender = (client: ChannelModel): DelaySender => {
  let cached: ConfirmChannel | null = null;
  // Single in-flight lock so concurrent send() calls share one channel-creation
  // path instead of each opening their own (which would leak all but the last).
  let inFlight: Promise<ConfirmChannel> | null = null;
  // Marks the channel currently being opened so its event handlers can also
  // clear `inFlight` if the channel dies before assertExchange resolves.
  let pendingChan: ConfirmChannel | null = null;

  const open = async (): Promise<ConfirmChannel> => {
    const chan = await client.createConfirmChannel();
    pendingChan = chan;
    const status: { dead: boolean } = { dead: false };
    const invalidate = (): void => {
      status.dead = true;
      if (cached === chan) cached = null;
      if (pendingChan === chan) {
        pendingChan = null;
        inFlight = null;
      }
    };
    chan.on('error', invalidate);
    chan.on('close', invalidate);
    try {
      // Routing key "delay" matches goamqp ServiceRequestConsumer("delay", ...) in amqp.go.
      await chan.assertExchange(slothRequestExchangeName, 'direct', { durable: true });
    } catch (error) {
      // assertExchange failed — close the orphan channel best-effort so it
      // doesn't linger on the connection, then rethrow so the in-flight
      // promise rejects and the next acquire() starts fresh.
      try {
        await chan.close();
      } catch {
        // already broken — nothing more to do
      }
      throw error;
    }
    if (status.dead) {
      // The channel emitted error/close while assertExchange was in flight.
      // Don't cache a dead channel — surface the failure so the caller retries.
      throw new Error('sloth: confirm channel closed before publisher was ready');
    }
    cached = chan;
    return chan;
  };

  const acquire = (): Promise<ConfirmChannel> => {
    if (cached) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = open().finally(() => {
      pendingChan = null;
      inFlight = null;
    });
    return inFlight;
  };

  const send = async <TData>(params: SendDelayMessageParams<TData>): Promise<void> => {
    const { data, logger: rawLogger, config, logLabel, logLevel } = params;
    const logger = resolveLogger(rawLogger, logLevel);
    assertSafeSlothConfig(config);

    const label = logLabel !== undefined ? sanitizeLabel(logLabel) : 'message';
    const { delayUntilUnix, delayDesc, pastDateWarning } = resolveDelaySeconds(params);
    if (pastDateWarning !== undefined) {
      logger.warn(`sloth: ${pastDateWarning}`, {
        event: 'sloth.publish.past_date_warning',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
      });
    }
    const body = serializeData(data);

    // Auto-generate a message ID per send unless caller provided one. UUIDs
    // give consumers a free idempotency key without us implementing dedup.
    const messageId = params.messageId ?? randomUUID();
    const extraHeaders = mergeReservedHeaders(params.headers);
    const headers = {
      ...extraHeaders,
      // Reserved Sloth wire-protocol headers — written last so callers cannot
      // override them via params.headers (also enforced by mergeReservedHeaders).
      'delay-until': delayUntilUnix, // seconds — Sloth parses as int64 Unix timestamp
      target: getSlothTarget(config), // amqp://{serviceName}/{routingKey}
    };

    logger.debug(`sloth: scheduling ${label}`, {
      event: 'sloth.publish.scheduling',
      serviceName: config.serviceName,
      routingKey: config.routingKey,
      messageId,
      correlationId: params.correlationId,
      delayDesc,
    });

    const startTime = Date.now();
    try {
      const chan = await acquire();
      // ConfirmChannel.publish takes a callback that fires on broker ack/nack.
      // Wrapping it in a Promise turns the callback into the resolution signal:
      // resolve = broker accepted, reject = broker nacked or channel error.
      await new Promise<void>((resolve, reject) => {
        const ok = chan.publish(
          slothRequestExchangeName,
          'delay',
          body,
          {
            messageId,
            ...(params.correlationId !== undefined && { correlationId: params.correlationId }),
            headers,
          },
          (err) => {
            if (err) reject(err instanceof Error ? err : new Error(errMessage(err)));
            else resolve();
          },
        );
        if (!ok) {
          logger.warn('sloth: publish back-pressured (channel write buffer full)', {
            event: 'sloth.publish.back_pressured',
            serviceName: config.serviceName,
            routingKey: config.routingKey,
            messageId,
          });
        }
      });

      logger.info(`sloth: scheduled ${label}`, {
        event: 'sloth.publish.confirmed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        messageId,
        correlationId: params.correlationId,
        delayDesc,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      logger.error(`sloth: failed to schedule ${label}`, {
        event: 'sloth.publish.failed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        messageId,
        correlationId: params.correlationId,
        delayDesc,
        durationMs: Date.now() - startTime,
        reason: errMessage(error),
      });
      throw error;
    }
  };

  return { send };
};
