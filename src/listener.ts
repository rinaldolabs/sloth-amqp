import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { errMessage, SlothConnectError, SlothError, SlothValidationError } from './errors.js';
import { NoOpLogger, resolveLogger } from './logger.js';
import type { SlothListenerHandle, SlothListenerOptions } from './types.js';
import {
  assertSafeSlothConfig,
  defaultListenerPrefetch,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  slothResponseExchangeName,
} from './utils.js';
import { makeWireEmitter } from './wire.js';

export async function setupDelayedMessageListener({
  amqpUrl,
  config,
  logger: rawLogger = new NoOpLogger(),
  onMessage,
  queueExpiresMs = defaultListenerQueueExpiresMs,
  prefetch = defaultListenerPrefetch,
  logLevel,
  signal: rawSignal,
  timeoutMs,
  onWireMessage,
}: SlothListenerOptions): Promise<SlothListenerHandle> {
  if (!amqpUrl) {
    throw new SlothValidationError('amqpUrl must not be empty');
  }
  assertSafeSlothConfig(config);
  if (!Number.isFinite(queueExpiresMs) || queueExpiresMs <= 0) {
    throw new SlothValidationError('queueExpiresMs must be a positive finite number');
  }
  if (!Number.isInteger(prefetch) || prefetch < 0) {
    throw new SlothValidationError('prefetch must be a non-negative integer');
  }

  const signal = combineAbort(rawSignal, timeoutMs);
  if (signal?.aborted) throw signal.reason as unknown;

  const logger = resolveLogger(rawLogger, logLevel);
  const emitWire = makeWireEmitter(onWireMessage, logger);
  logger.debug(`sloth: setting up listener for ${config.serviceName}/${config.routingKey}`, {
    event: 'sloth.listener.setup_started',
    serviceName: config.serviceName,
    routingKey: config.routingKey,
  });

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
      logger.error(`sloth: failed to release listener resources: ${errMessage(error)}`, {
        event: 'sloth.listener.resources_release_failed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        reason: errMessage(error),
      });
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

    channel.on('error', (err: unknown) => {
      logger.error(`sloth: listener channel error: ${errMessage(err)}`, {
        event: 'sloth.listener.channel_error',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        reason: errMessage(err),
      });
    });

    // Broker-initiated channel close: just log. Don't null `channel` here —
    // `closeResources` already nulls before calling close(), and the subsequent
    // `connection.close()` cascade tears the channel down on the broker side.
    channel.on('close', () => {
      logger.warn('sloth: listener channel closed', {
        event: 'sloth.listener.channel_closed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
      });
    });

    // Bound the unacked-message window before declaring anything, so a burst of
    // due-now redeliveries can't flood this consumer's memory. prefetch=0 means
    // unlimited (caller opt-in). Per-consumer, not global.
    await raceWithAbort(channel.prefetch(prefetch), signal);

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
    // Headers exchange: routing is matched on the binding arguments
    // (service={serviceName}, set by Sloth on the response), NOT on the routing
    // key. The routing-key arg below is ignored by the broker for matching —
    // don't "fix" it into the matcher.
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
          // null = broker cancelled this consumer server-side; nothing to ack.
          if (!message) return;
          // Defend the handler against a structurally-unusable delivery (no
          // content Buffer to read). Route it to the DLX rather than letting
          // onMessage throw on message.content.toString() — that would surface
          // as handler_failed and wrongly implicate the caller's handler.
          if (!Buffer.isBuffer(message.content)) {
            logger.error('sloth: unexpected message (missing content buffer)', {
              event: 'sloth.listener.unexpected_message',
              serviceName: config.serviceName,
              routingKey: config.routingKey,
              messageId: message.properties.messageId as string | undefined,
              correlationId: message.properties.correlationId as string | undefined,
            });
            channel?.nack(message, false, false);
            return;
          }
          emitWire(() => {
            const headers = message.properties.headers as Record<string, unknown> | undefined;
            const messageId = message.properties.messageId as string | undefined;
            const correlationId = message.properties.correlationId as string | undefined;
            return {
              direction: 'in',
              queue: queueName,
              routingKey: message.fields.routingKey,
              content: message.content,
              redelivered: message.fields.redelivered,
              ...(headers !== undefined && { headers }),
              ...(messageId !== undefined && { messageId }),
              ...(correlationId !== undefined && { correlationId }),
            };
          });
          onMessage(message)
            .then(() => {
              channel?.ack(message);
            })
            .catch((err: unknown) => {
              logger.error(`sloth: onMessage handler failed: ${errMessage(err)}`, {
                event: 'sloth.listener.handler_failed',
                serviceName: config.serviceName,
                routingKey: config.routingKey,
                messageId: message.properties.messageId as string | undefined,
                correlationId: message.properties.correlationId as string | undefined,
                reason: errMessage(err),
              });
              // requeue=false: rely on a broker-configured DLX for retries.
              channel?.nack(message, false, false);
            });
        },
        { noAck: false },
      ),
      signal,
    );

    logger.info(`sloth: listener ready (queue=${queueName}, consumerTag=${consumerTag})`, {
      event: 'sloth.listener.ready',
      serviceName: config.serviceName,
      routingKey: config.routingKey,
      queueName,
      consumerTag,
    });

    return {
      consumerTag,
      close: async (): Promise<void> => {
        try {
          if (channel) {
            await channel.cancel(consumerTag);
          }
        } catch (error) {
          logger.error(`sloth: failed to cancel consumer: ${errMessage(error)}`, {
            event: 'sloth.listener.consumer_cancel_failed',
            serviceName: config.serviceName,
            routingKey: config.routingKey,
            consumerTag,
            reason: errMessage(error),
          });
        }
        await closeResources();
      },
    };
  } catch (error) {
    logger.error(`sloth: listener setup failed: ${errMessage(error)}`, {
      event: 'sloth.listener.setup_failed',
      serviceName: config.serviceName,
      routingKey: config.routingKey,
      reason: errMessage(error),
    });
    await closeResources();
    // Surface our own errors and WHATWG abort/timeout reasons verbatim; wrap a
    // foreign (amqplib/broker) failure as SlothConnectError with the cause.
    if (error instanceof SlothError || error instanceof DOMException) throw error;
    throw new SlothConnectError(errMessage(error), { cause: error });
  }
}
