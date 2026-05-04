import type { Channel, ChannelModel } from 'amqplib';
import type { SendDelayMessageParams } from './types.js';
import { getSlothTarget, slothRequestExchangeName } from './utils.js';

export const slothDelaySender =
  (client: ChannelModel) =>
  async ({ data, delayMinutes, logger, config }: SendDelayMessageParams): Promise<void> => {
    if (delayMinutes <= 0) {
      throw new Error('delayMinutes must be a positive number');
    }

    logger.info(`Sending delayed message of type: ${data.key}`);
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
      // matches goamqp ServiceRequestConsumer("delay", ...) in amqp.go
      await chan.assertExchange(slothRequestExchangeName, 'direct', { durable: true });
      chan.publish(slothRequestExchangeName, 'delay', Buffer.from(JSON.stringify(data)), {
        headers: {
          'delay-until': delayUntilUnix, // seconds, not ms — Sloth parses as int64 Unix timestamp
          target: getSlothTarget(config), // amqp://{serviceName}/{routingKey}/ — response destination
        },
      });

      const duration = Date.now() - startTime;
      logger.info(`Sent delayed message of type: ${data.key} in ${String(duration)}ms`);
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(`Error sending delayed message after ${String(duration)}ms`);
      throw error;
    } finally {
      if (chan) {
        try {
          logger.debug('Closing AMQP channel');
          await chan.close();
          logger.debug('AMQP channel closed successfully');
        } catch (closeError) {
          logger.warn(`Failed to close channel: ${String(closeError)}`);
        }
      }
    }
  };
