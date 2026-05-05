import type { Channel, ChannelModel } from 'amqplib';
import { errMessage } from './errors.js';
import { resolveLogger } from './logger.js';
import type { DelaySpec, SendDelayMessageParams } from './types.js';
import { assertSafeSlothConfig, getSlothTarget, slothRequestExchangeName } from './utils.js';

/** ~100 years in seconds — prevents unix timestamp overflow in the delay-until header. */
export const MAX_DELAY_SECONDS = 100 * 365 * 24 * 3600;

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
 * Resolves whichever delay variant is set into an absolute unix timestamp (seconds)
 * and a human-readable description for log lines.
 * Throws on invalid input or out-of-range values. Past delayUntil dates return a pastDateWarning instead of throwing.
 */
export const resolveDelayUnixSeconds = (
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

export const slothDelaySender =
  (client: ChannelModel) =>
  async <TData>(params: SendDelayMessageParams<TData>): Promise<void> => {
    const { data, logger: rawLogger, config, logLabel, logLevel } = params;
    const logger = resolveLogger(rawLogger, logLevel);
    assertSafeSlothConfig(config);

    const label = logLabel !== undefined ? sanitizeLabel(logLabel) : 'message';
    const { delayUntilUnix, delayDesc, pastDateWarning } = resolveDelayUnixSeconds(params);
    if (pastDateWarning !== undefined) logger.warn(`sloth: ${pastDateWarning}`);
    const body = serializeData(data);

    logger.debug(
      `sloth: scheduling ${label} for ${config.serviceName}/${config.routingKey} (${delayDesc})`,
    );

    let chan: Channel | null = null;
    const startTime = Date.now();

    try {
      chan = await client.createChannel();

      // assertExchange per send is acceptable — this is not a hot path.
      // Routing key "delay" matches goamqp ServiceRequestConsumer("delay", ...) in amqp.go.
      await chan.assertExchange(slothRequestExchangeName, 'direct', { durable: true });
      const ok = chan.publish(slothRequestExchangeName, 'delay', body, {
        headers: {
          'delay-until': delayUntilUnix, // seconds — Sloth parses as int64 Unix timestamp
          target: getSlothTarget(config), // amqp://{serviceName}/{routingKey}
        },
      });
      if (!ok) logger.warn('sloth: publish back-pressured (channel write buffer full)');

      logger.info(
        `sloth: scheduled ${label} (${delayDesc}, took=${String(Date.now() - startTime)}ms)`,
      );
    } catch (error) {
      logger.error(
        `sloth: failed to schedule ${label} after ${String(Date.now() - startTime)}ms: ${errMessage(error)}`,
      );
      throw error;
    } finally {
      if (chan) {
        try {
          await chan.close();
        } catch (closeError) {
          logger.warn(`sloth: failed to close publish channel: ${errMessage(closeError)}`);
        }
      }
    }
  };
