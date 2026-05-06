import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { errMessage } from './errors.js';
import { NoOpLogger, resolveLogger } from './logger.js';
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
  logger: rawLogger = new NoOpLogger(),
  onMessage,
  queueExpiresMs = defaultListenerQueueExpiresMs,
  logLevel,
  signal: rawSignal,
  timeoutMs,
}: SlothListenerOptions): Promise<SlothListenerHandle> {
  if (!amqpUrl) {
    throw new Error('amqpUrl must not be empty');
  }
  assertSafeSlothConfig(config);
  if (!Number.isFinite(queueExpiresMs) || queueExpiresMs <= 0) {
    throw new Error('queueExpiresMs must be a positive finite number');
  }

  const signal = combineAbort(rawSignal, timeoutMs);
  if (signal?.aborted) throw signal.reason as unknown;

  const logger = resolveLogger(rawLogger, logLevel);
  logger.debug(`sloth: setting up listener for ${config.serviceName}/${config.routingKey}`);

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
      logger.error(`sloth: failed to release listener resources: ${errMessage(error)}`);
    }
  };

  try {
    const queueName = getSlothQueueName(config);

    // Each network step is raced against the abort signal so a hung broker
    // (TCP open but no AMQP handshake) can't block setup forever. The
    // `safeClose` cleanup closes any resource that resolves *after* the
    // signal fires, so we don't leak sockets/channels in the abort path.
    connection = await raceWithAbort(amqp.connect(amqpUrl), signal, safeClose);
    channel = await raceWithAbort(connection.createChannel(), signal, safeClose);

    channel.on('error', (err: Error) => {
      logger.error(`sloth: listener channel error: ${err.message}`);
    });

    // Broker-initiated channel close: just log. Don't null `channel` here —
    // `closeResources` already nulls before calling close(), and the subsequent
    // `connection.close()` cascade tears the channel down on the broker side.
    channel.on('close', () => {
      logger.warn('sloth: listener channel closed');
    });

    // Sloth re-delivers via sloth.headers.exchange.response (headers exchange) —
    // matches goamqp ServiceResponseConsumer in amqp.go
    await raceWithAbort(
      channel.assertExchange(slothResponseExchangeName, 'headers', { durable: true }),
      signal,
    );
    await raceWithAbort(
      channel.assertQueue(queueName, { durable: true, expires: queueExpiresMs }),
      signal,
    );
    // Bind using headers: Sloth sets service={serviceName} when publishing the response
    await raceWithAbort(
      channel.bindQueue(queueName, slothResponseExchangeName, config.routingKey, {
        service: config.serviceName,
      }),
      signal,
    );

    const { consumerTag } = await raceWithAbort(
      channel.consume(
        queueName,
        (message) => {
          if (!message) return;
          onMessage(message)
            .then(() => {
              channel?.ack(message);
            })
            .catch((err: unknown) => {
              logger.error(`sloth: onMessage handler failed: ${errMessage(err)}`);
              // requeue=false: rely on a broker-configured DLX for retries.
              channel?.nack(message, false, false);
            });
        },
        { noAck: false },
      ),
      signal,
    );

    logger.info(`sloth: listener ready (queue=${queueName}, consumerTag=${consumerTag})`);

    return {
      consumerTag,
      close: async (): Promise<void> => {
        try {
          if (channel) {
            await channel.cancel(consumerTag);
          }
        } catch (error) {
          logger.error(`sloth: failed to cancel consumer: ${errMessage(error)}`);
        }
        await closeResources();
      },
    };
  } catch (error) {
    logger.error(`sloth: listener setup failed: ${errMessage(error)}`);
    await closeResources();
    throw error;
  }
}
