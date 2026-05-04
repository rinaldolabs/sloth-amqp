import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { NoOpLogger } from './logger.js';
import { errMessage } from './errors.js';
import type { SlothListenerHandle, SlothListenerOptions } from './types.js';
import {
  assertSafeSlothConfig,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  slothResponseExchangeName,
} from './utils.js';

export async function setupDelayedMessageListener({
  amqpUrl,
  config,
  logger = new NoOpLogger(),
  onMessage,
  queueExpiresMs = defaultListenerQueueExpiresMs,
}: SlothListenerOptions): Promise<SlothListenerHandle> {
  if (!amqpUrl) {
    throw new Error('amqpUrl must not be empty');
  }
  assertSafeSlothConfig(config);
  if (!Number.isFinite(queueExpiresMs) || queueExpiresMs <= 0) {
    throw new Error('queueExpiresMs must be a positive finite number');
  }

  logger.info('Setting up delayed message listener');

  let connection: ChannelModel | null = null;
  let channel: Channel | null = null;

  const closeResources = async (): Promise<void> => {
    try {
      if (channel) {
        const c = channel;
        channel = null;
        await c.close();
      }
      if (connection) {
        const c = connection;
        connection = null;
        await c.close();
      }
    } catch (error) {
      logger.error(`Error during cleanup: ${errMessage(error)}`);
    }
  };

  try {
    const queueName = getSlothQueueName(config);

    connection = await amqp.connect(amqpUrl);
    channel = await connection.createChannel();

    channel.on('error', (err: Error) => {
      logger.error(`AMQP channel error: ${err.message}`);
    });

    channel.on('close', () => {
      logger.warn('AMQP channel closed');
      channel = null;
    });

    // Sloth re-delivers via sloth.headers.exchange.response (headers exchange) —
    // matches goamqp ServiceResponseConsumer in amqp.go
    await channel.assertExchange(slothResponseExchangeName, 'headers', { durable: true });
    await channel.assertQueue(queueName, {
      durable: true,
      expires: queueExpiresMs,
    });
    // Bind using headers: Sloth sets service={serviceName} when publishing the response
    await channel.bindQueue(queueName, slothResponseExchangeName, config.routingKey, {
      service: config.serviceName,
    });

    const { consumerTag } = await channel.consume(
      queueName,
      (message) => {
        if (!message) return;
        onMessage(message)
          .then(() => {
            channel?.ack(message);
          })
          .catch((err: unknown) => {
            logger.error(`onMessage failed: ${errMessage(err)}`);
            // requeue=false: rely on a broker-configured DLX for retries.
            channel?.nack(message, false, false);
          });
      },
      { noAck: false },
    );

    logger.info('Waiting for delayed messages...');

    return {
      consumerTag,
      close: async (): Promise<void> => {
        try {
          if (channel) {
            await channel.cancel(consumerTag);
          }
        } catch (error) {
          logger.error(`Error cancelling consumer: ${errMessage(error)}`);
        }
        await closeResources();
      },
    };
  } catch (error) {
    logger.error(`Error setting up delayed message listener: ${errMessage(error)}`);
    await closeResources();
    throw error;
  }
}
