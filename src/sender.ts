import type { Channel, ChannelModel } from 'amqplib';
import { errMessage } from './errors.js';
import type { SendDelayMessageParams } from './types.js';
import { assertSafeSlothConfig, getSlothTarget, slothRequestExchangeName } from './utils.js';

export const slothDelaySender =
  (client: ChannelModel) =>
  async <TData>({
    data,
    delayMinutes,
    logger,
    config,
    logLabel,
  }: SendDelayMessageParams<TData>): Promise<void> => {
    if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
      throw new Error('delayMinutes must be a positive finite number');
    }
    assertSafeSlothConfig(config);

    const label = logLabel ?? 'message';
    logger.info(`Sending delayed ${label}`);
    const delayDuration = delayMinutes * 60 * 1000;
    // delay-until is a Unix timestamp in seconds (int64) — Sloth's ServiceRequestConsumer reads this header
    const delayUntilUnix = Math.floor((Date.now() + delayDuration) / 1000);

    let chan: Channel | null = null;
    const startTime = Date.now();

    try {
      logger.debug('Creating AMQP channel for delayed message');
      chan = await client.createChannel();
      logger.debug('AMQP channel created successfully');

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
            target: getSlothTarget(config), // amqp://{serviceName}/{routingKey}/ — response destination
          },
        },
      );
      if (!ok) {
        logger.warn('AMQP publish returned false — channel write buffer full (backpressure)');
      }

      const duration = Date.now() - startTime;
      logger.info(`Sent delayed ${label} in ${String(duration)}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`Error sending delayed ${label} after ${String(duration)}ms: ${errMessage(error)}`);
      throw error;
    } finally {
      if (chan) {
        try {
          logger.debug('Closing AMQP channel');
          await chan.close();
          logger.debug('AMQP channel closed successfully');
        } catch (closeError) {
          logger.warn(`Failed to close channel: ${errMessage(closeError)}`);
        }
      }
    }
  };
