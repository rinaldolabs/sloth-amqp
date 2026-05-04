import type { Channel, ChannelModel } from 'amqplib';
import { errMessage } from './errors.js';
import { resolveLogger } from './logger.js';
import type { SendDelayMessageParams } from './types.js';
import { assertSafeSlothConfig, getSlothTarget, slothRequestExchangeName } from './utils.js';

export const slothDelaySender =
  (client: ChannelModel) =>
  async <TData>({
    data,
    delayMinutes,
    logger: rawLogger,
    config,
    logLabel,
    logLevel,
  }: SendDelayMessageParams<TData>): Promise<void> => {
    const logger = resolveLogger(rawLogger, logLevel);
    if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
      throw new Error('delayMinutes must be a positive finite number');
    }
    assertSafeSlothConfig(config);

    const label = logLabel ?? 'message';
    const delayUntilUnix = Math.floor((Date.now() + delayMinutes * 60 * 1000) / 1000);

    logger.debug(
      `sloth: scheduling ${label} for ${config.serviceName}/${config.routingKey} in ${String(delayMinutes)}min`,
    );

    let chan: Channel | null = null;
    const startTime = Date.now();

    try {
      chan = await client.createChannel();

      // Publishes to sloth.direct.exchange.request with routing key "delay" —
      // matches goamqp ServiceRequestConsumer("delay", ...) in amqp.go.
      // assertExchange per send is acceptable — this is not a hot path.
      await chan.assertExchange(slothRequestExchangeName, 'direct', { durable: true });
      const ok = chan.publish(
        slothRequestExchangeName,
        'delay',
        Buffer.from(JSON.stringify(data)),
        {
          headers: {
            'delay-until': delayUntilUnix, // seconds, not ms — Sloth parses as int64 Unix timestamp
            target: getSlothTarget(config), // amqp://{serviceName}/{routingKey} — response destination
          },
        },
      );
      if (!ok) {
        logger.warn('sloth: publish backpressured (channel write buffer full)');
      }

      const duration = Date.now() - startTime;
      logger.info(
        `sloth: scheduled ${label} (delay=${String(delayMinutes)}min, took=${String(duration)}ms)`,
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        `sloth: failed to schedule ${label} after ${String(duration)}ms: ${errMessage(error)}`,
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
