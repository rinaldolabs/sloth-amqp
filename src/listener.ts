import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { errMessage, SlothConnectError, SlothError, SlothValidationError } from './errors.js';
import { NoOpLogger, resolveLogger } from './logger.js';
import type { SlothListenerHandle, SlothListenerOptions } from './types.js';
import {
  assertSafeSlothConfig,
  defaultListenerGraceTimeoutMs,
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
  graceTimeoutMs = defaultListenerGraceTimeoutMs,
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
  if (!Number.isInteger(graceTimeoutMs) || graceTimeoutMs < 0) {
    throw new SlothValidationError('graceTimeoutMs must be a non-negative integer');
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
  // Number of onMessage handlers currently executing. close() waits for this to
  // reach 0 (bounded by graceTimeoutMs) after cancelling the consumer, so the
  // broker doesn't requeue messages a handler was mid-way through.
  let inFlight = 0;
  // Resolvers parked by close() while it waits for in-flight handlers to drain;
  // fired when inFlight returns to 0.
  let drainWaiters: (() => void)[] = [];
  const settleHandler = (): void => {
    inFlight--;
    if (inFlight === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
  const drain = (timeoutMs: number): Promise<void> => {
    if (inFlight === 0 || timeoutMs === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      drainWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

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

  // amqplib's ack/nack throw IllegalOperationError *synchronously* if the channel
  // has already closed (e.g. a broker-initiated close racing an in-flight
  // handler). Swallow that so a transient channel loss can't escalate to an
  // unhandled rejection and crash the process; log it instead.
  const safeAck = (message: ConsumeMessage): void => {
    try {
      channel?.ack(message);
    } catch (error) {
      logger.error(`sloth: ack failed: ${errMessage(error)}`, {
        event: 'sloth.listener.ack_failed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        messageId: message.properties.messageId as string | undefined,
        correlationId: message.properties.correlationId as string | undefined,
        reason: errMessage(error),
      });
    }
  };
  const safeNack = (message: ConsumeMessage): void => {
    try {
      channel?.nack(message, false, false);
    } catch (error) {
      logger.error(`sloth: nack failed: ${errMessage(error)}`, {
        event: 'sloth.listener.nack_failed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        messageId: message.properties.messageId as string | undefined,
        correlationId: message.properties.correlationId as string | undefined,
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
            safeNack(message);
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
          inFlight++;
          onMessage(message)
            .then(() => {
              safeAck(message);
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
              safeNack(message);
            })
            .finally(() => {
              settleHandler();
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

    const close = async (): Promise<void> => {
      try {
        if (channel) {
          // cancel() guarantees no further deliveries once it resolves, so
          // after this only already-started handlers remain to drain.
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
      await drain(graceTimeoutMs);
      await closeResources();
    };

    return {
      consumerTag,
      close,
      [Symbol.asyncDispose]: close,
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
