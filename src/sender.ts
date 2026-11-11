import { randomUUID } from 'node:crypto';
import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';
import { combineAbort, raceWithAbort } from './abort.js';
import {
  errMessage,
  SlothPublishError,
  SlothTimeoutError,
  SlothValidationError,
  toSlothError,
} from './errors.js';
import { resolveLogger } from './logger.js';
import type { DelaySenderOptions, DelaySpec, SendDelayMessageParams } from './types.js';
import {
  assertSafeSlothConfig,
  getSlothTarget,
  slothDelayRoutingKey,
  slothRequestExchangeName,
} from './utils.js';
import { makeWireEmitter } from './wire.js';

/** ~100 years in seconds — prevents unix timestamp overflow in the delay-until header. */
export const MAX_DELAY_SECONDS = 100 * 365 * 24 * 3600;

/**
 * Headers reserved by the Sloth wire protocol. Callers cannot override these
 * via `params.headers`; passing them throws before any AMQP work happens.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['delay-until', 'target']);

// Ack order across publishes is not guaranteed, and callers may reuse a
// messageId, so a basic.return is matched to its confirm by this per-attempt id.
const publishIdHeader = 'x-sloth-publish-id';

/**
 * Throws if `headers` contains any key reserved by the Sloth wire protocol
 * (`delay-until`, `target`), or the publish id header when `mandatory` is on.
 * Returns the input unchanged on success, or an empty object when called with
 * `undefined` so callsites can spread the result directly without an extra
 * null check.
 */
const assertNoReservedHeaders = (
  headers: Record<string, string | number | boolean> | undefined,
  mandatory: boolean,
): Record<string, string | number | boolean> => {
  if (!headers) return {};
  for (const key of Object.keys(headers)) {
    if (RESERVED_HEADERS.has(key) || (mandatory && key === publishIdHeader)) {
      throw new SlothValidationError(
        `headers.${key} is reserved by the Sloth wire protocol and cannot be overridden`,
      );
    }
  }
  return headers;
};

/**
 * Strips control and direction-manipulating characters and truncates to 200
 * grapheme clusters so caller-supplied labels cannot inject line breaks, escape
 * sequences, or bidi-reordering tricks into log output.
 * Removed: ASCII controls (U+0000–U+001F), DEL + C1 controls (U+007F–U+009F,
 * which covers NEL U+0085 and CSI U+009B), Unicode line/paragraph separators
 * (U+2028/U+2029), bidi embeddings/overrides (U+202A–U+202E), and bidi
 * isolates (U+2066–U+2069).
 */
const segmenter = new Intl.Segmenter();
const isUnsafeChar = (c: string): boolean => {
  const n = c.codePointAt(0);
  return (
    n !== undefined &&
    (n <= 0x1f ||
      (n >= 0x7f && n <= 0x9f) ||
      n === 0x2028 ||
      n === 0x2029 ||
      (n >= 0x202a && n <= 0x202e) ||
      (n >= 0x2066 && n <= 0x2069))
  );
};
// 200 grapheme clusters of BMP astral pairs = 400 code units. A single cluster
// can carry unbounded code points (ZWJ chains), so a code-unit hard cap keeps
// log lines bounded even for pathological input.
const maxLabelCodeUnits = 400;
export const sanitizeLabel = (raw: string): string => {
  const label = Array.from(segmenter.segment(raw), (s) => s.segment)
    .filter((c) => !isUnsafeChar(c))
    .slice(0, 200)
    .join('');
  return label.length > maxLabelCodeUnits ? label.slice(0, maxLabelCodeUnits) : label;
};

/**
 * Resolves whichever delay variant is set into an absolute unix timestamp
 * (seconds since epoch) and a human-readable description for log lines.
 * Throws on invalid input or out-of-range values. Past delayUntil dates
 * return a pastDateWarning instead of throwing.
 *
 * Rounding contract: `delayUntil` rounds **up** (`Math.ceil`) so an absolute
 * deadline is never delivered in the second before it; the relative variants
 * (`delaySeconds`/`delayMinutes`) round **down** (`Math.floor`), so the effect
 * is at most one second short of the requested offset. Both are sub-second
 * effects on a service whose granularity is whole seconds.
 */
export const resolveDelaySeconds = (
  params: DelaySpec,
): { delayUntilUnix: number; delayDesc: string; pastDateWarning?: string } => {
  const { delayUntil, delaySeconds, delayMinutes } = params;
  const setCount = [delayUntil, delaySeconds, delayMinutes].filter((v) => v !== undefined).length;
  if (setCount !== 1)
    throw new SlothValidationError(
      'exactly one of delayMinutes, delaySeconds, or delayUntil must be provided',
    );
  const nowMs = Date.now();

  if (delayUntil !== undefined) {
    // Duck-typed (not instanceof) so cross-realm Dates work; a JS caller
    // passing a string or plain object gets a typed error, not a TypeError.
    if (typeof delayUntil.getTime !== 'function') {
      throw new SlothValidationError('delayUntil must be a Date');
    }
    const ms = delayUntil.getTime();
    if (!Number.isFinite(ms)) throw new SlothValidationError('delayUntil is an invalid Date');
    const delayUntilUnix = Math.ceil(ms / 1000);
    if (delayUntilUnix - Math.floor(nowMs / 1000) > MAX_DELAY_SECONDS)
      throw new SlothValidationError('delayUntil exceeds maximum allowed delay of 100 years');
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
      throw new SlothValidationError('delaySeconds must be a positive finite number');
    if (delaySeconds > MAX_DELAY_SECONDS)
      throw new SlothValidationError('delaySeconds exceeds maximum allowed delay of 100 years');
    return {
      delayUntilUnix: Math.floor((nowMs + delaySeconds * 1000) / 1000),
      delayDesc: `delay=${String(delaySeconds)}s`,
    };
  }

  if (!Number.isFinite(delayMinutes) || delayMinutes <= 0)
    throw new SlothValidationError('delayMinutes must be a positive finite number');
  if (delayMinutes * 60 > MAX_DELAY_SECONDS)
    throw new SlothValidationError('delayMinutes exceeds maximum allowed delay of 100 years');
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
    throw new SlothValidationError('data is not JSON-serializable');
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
 * With `options.mandatory`, an unroutable request rejects too.
 */
export const createDelaySender = (
  client: ChannelModel,
  { mandatory = false }: DelaySenderOptions = {},
): DelaySender => {
  // Mandatory publishes awaiting their confirm, keyed by publish id. The broker
  // sends basic.return before the confirm of the same message.
  const publishStates = new Map<string, 'pending' | 'returned'>();
  const markReturned = (message: Message): void => {
    const publishId: unknown = Reflect.get(message.properties.headers ?? {}, publishIdHeader);
    if (typeof publishId === 'string' && publishStates.get(publishId) === 'pending') {
      publishStates.set(publishId, 'returned');
    }
  };
  const takePublishState = (publishId: string | undefined): 'pending' | 'returned' | undefined => {
    if (publishId === undefined) return undefined;
    const state = publishStates.get(publishId);
    publishStates.delete(publishId);
    return state;
  };

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
    if (mandatory) chan.on('return', markReturned);
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
      throw new SlothPublishError('sloth: confirm channel closed before publisher was ready');
    }
    cached = chan;
    return chan;
  };

  const acquire = (): Promise<ConfirmChannel> => {
    if (cached) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    // Only clear state that still belongs to this attempt: a channel that died
    // mid-open has already been cleared by `invalidate`, and a newer acquire
    // may have started in the meantime — clobbering its state would strand the
    // newer attempt's channel.
    const attempt: Promise<ConfirmChannel> = open().finally(() => {
      if (inFlight === attempt) {
        pendingChan = null;
        inFlight = null;
      }
    });
    inFlight = attempt;
    return attempt;
  };

  const send = async <TData>(params: SendDelayMessageParams<TData>): Promise<void> => {
    const { data, logger: rawLogger, config, logLabel, logLevel } = params;
    const logger = resolveLogger(rawLogger, logLevel);
    const emitWire = makeWireEmitter(params.onWireMessage, logger);
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
    const extraHeaders = assertNoReservedHeaders(params.headers, mandatory);
    const publishId = mandatory ? randomUUID() : undefined;
    const headers = {
      ...extraHeaders,
      ...(publishId !== undefined && { [publishIdHeader]: publishId }),
      // Reserved Sloth wire-protocol headers — written last as a defence-in-depth
      // against any future spread mistake; assertNoReservedHeaders has already
      // rejected attempts to set these via params.headers.
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

    // Bounds the confirm wait. amqplib has no per-publish timeout; without this
    // a black-hole partition (socket alive, no confirm) hangs send() until
    // heartbeats trip the channel — and indefinitely if the connection set
    // heartbeat:0 (which genuinely disables heartbeats on amqplib v2).
    const signal = combineAbort(params.signal, params.timeoutMs);
    if (signal?.aborted) throw signal.reason as unknown;

    const startTime = Date.now();
    try {
      // The acquire (createConfirmChannel + assertExchange) is raced against
      // the same signal as the confirm wait — a black-hole partition during
      // channel-open would otherwise hang send() past its deadline. No loser
      // cleanup: the shared open is abandoned, not killed, so other senders
      // still benefit when it eventually resolves.
      const chan = await raceWithAbort(acquire(), signal);
      // Re-check after the race: if the abort fired in the same tick the
      // acquire resolved, do not publish a message the caller has cancelled.
      if (signal?.aborted) throw signal.reason as unknown;
      // ConfirmChannel.publish takes a callback that fires on broker ack/nack.
      // Wrapping it in a Promise turns the callback into the resolution signal:
      // resolve = broker accepted, reject = broker nacked or channel error.
      // If a timeout wins the race below, the underlying publish can't be
      // cancelled — but a late ack/nack then calls resolve/reject on an
      // already-settled promise, which is a harmless no-op (no extra guard
      // needed).
      const confirm = new Promise<void>((resolve, reject) => {
        if (publishId !== undefined) publishStates.set(publishId, 'pending');
        let ok: boolean;
        try {
          ok = chan.publish(
            slothRequestExchangeName,
            slothDelayRoutingKey,
            body,
            {
              // deliveryMode 2 — wire parity with goamqp's publishMessage, so a
              // broker restart before Sloth consumes the request cannot drop it.
              persistent: true,
              contentType: 'application/json',
              messageId,
              ...(params.correlationId !== undefined && { correlationId: params.correlationId }),
              ...(mandatory && { mandatory: true }),
              headers,
            },
            (err) => {
              const returned = takePublishState(publishId) === 'returned';
              if (err) reject(new SlothPublishError(errMessage(err), { cause: err }));
              else if (returned) {
                reject(
                  new SlothPublishError(
                    `unroutable: no queue is bound to ${slothRequestExchangeName} with routing key ${slothDelayRoutingKey}`,
                  ),
                );
              } else resolve();
            },
          );
        } catch (error) {
          takePublishState(publishId);
          throw error;
        }
        if (!ok) {
          logger.warn('sloth: publish back-pressured (channel write buffer full)', {
            event: 'sloth.publish.back_pressured',
            serviceName: config.serviceName,
            routingKey: config.routingKey,
            messageId,
          });
        }
      });
      // Race the confirm against the signal. Don't close the channel on a
      // timeout — the message may still confirm and the channel is still
      // healthy for the next send. A TimeoutError from our own timeoutMs is
      // normalised to SlothTimeoutError; a caller abort() reason propagates
      // verbatim.
      try {
        await raceWithAbort(confirm, signal);
      } catch (raceErr) {
        if (raceErr instanceof DOMException && raceErr.name === 'TimeoutError') {
          throw new SlothTimeoutError(
            `publish confirm timed out after ${String(params.timeoutMs)}ms`,
            { cause: raceErr },
          );
        }
        throw raceErr;
      }

      emitWire(() => ({
        direction: 'out',
        exchange: slothRequestExchangeName,
        routingKey: slothDelayRoutingKey,
        content: body,
        headers,
        messageId,
        ...(params.correlationId !== undefined && { correlationId: params.correlationId }),
      }));

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
      // Typed-error contract: foreign failures (channel open, exchange assert,
      // raw broker errors) surface as SlothPublishError with the cause chained;
      // SlothErrors, DOMExceptions, and abort reasons propagate verbatim.
      throw toSlothError(error, signal, SlothPublishError);
    }
  };

  return { send };
};
