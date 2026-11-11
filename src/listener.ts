import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from 'amqplib';
import { combineAbort, raceWithAbort, safeClose } from './abort.js';
import { errMessage, SlothConnectError, SlothValidationError, toSlothError } from './errors.js';
import { NoOpLogger, resolveLogger } from './logger.js';
import type {
  SlothListenerClosedReason,
  SlothListenerHandle,
  SlothListenerOptions,
} from './types.js';
import {
  assertSafeSlothConfig,
  defaultListenerGraceTimeoutMs,
  defaultListenerPrefetch,
  defaultListenerQueueExpiresMs,
  getSlothQueueName,
  slothResponseExchangeName,
} from './utils.js';
import { makeWireEmitter } from './wire.js';

// Matches go-messaging-amqp's default queue, which Sloth's Go client v1.0.0
// and v1.0.1 declare for the same response queue name.
const quorumQueueArguments = { 'x-queue-type': 'quorum', 'x-single-active-consumer': true };

export async function setupDelayedMessageListener({
  amqpUrl,
  config,
  logger: rawLogger = new NoOpLogger(),
  onMessage,
  queueExpiresMs = defaultListenerQueueExpiresMs,
  queueType,
  prefetch = defaultListenerPrefetch,
  graceTimeoutMs = defaultListenerGraceTimeoutMs,
  logLevel,
  signal: rawSignal,
  timeoutMs,
  onWireMessage,
  onClosed,
}: SlothListenerOptions): Promise<SlothListenerHandle> {
  if (!amqpUrl) {
    throw new SlothValidationError('amqpUrl must not be empty');
  }
  assertSafeSlothConfig(config);
  // Integer like its sibling options — RabbitMQ's x-expires argument rejects
  // fractional values with a channel error, so fail at the boundary instead.
  if (!Number.isInteger(queueExpiresMs) || queueExpiresMs <= 0) {
    throw new SlothValidationError('queueExpiresMs must be a positive integer');
  }
  if (!Number.isInteger(prefetch) || prefetch < 0) {
    throw new SlothValidationError('prefetch must be a non-negative integer');
  }
  const requestedQueueType: unknown = queueType;
  if (requestedQueueType !== undefined && requestedQueueType !== 'quorum') {
    throw new SlothValidationError("queueType must be 'quorum' when set");
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
  // Death-notification state for the opt-in onClosed callback. `armed` flips
  // true only after setup succeeds (mid-setup failures reject the returned
  // promise instead); `userClosing` suppresses the teardown events that
  // close() itself provokes; `closedNotified` makes the callback fire at most
  // once even when connection- and channel-close cascade together.
  let armed = false;
  let userClosing = false;
  let closedNotified = false;
  const notifyClosed = (reason: SlothListenerClosedReason): void => {
    if (!armed || userClosing || closedNotified) return;
    closedNotified = true;
    if (!onClosed) return;
    try {
      onClosed(reason);
    } catch (error) {
      logger.error(`sloth: onClosed callback threw: ${errMessage(error)}`, {
        event: 'sloth.listener.on_closed_failed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        reason: errMessage(error),
      });
    }
  };
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

  // Each resource is closed in its own try/catch: channel.close() rejects with
  // IllegalOperationError whenever the broker already closed the channel, and
  // a shared block would then skip connection.close() — leaking the internal
  // TCP socket (the caller has no reference to it).
  const logReleaseFailed = (error: unknown): void => {
    logger.error(`sloth: failed to release listener resources: ${errMessage(error)}`, {
      event: 'sloth.listener.resources_release_failed',
      serviceName: config.serviceName,
      routingKey: config.routingKey,
      reason: errMessage(error),
    });
  };
  const closeResources = async (): Promise<void> => {
    if (channel) {
      const c = channel;
      channel = null;
      try {
        await c.close();
      } catch (error) {
        logReleaseFailed(error);
      }
    }
    if (connection) {
      const c = connection;
      connection = null;
      try {
        await c.close();
      } catch (error) {
        logReleaseFailed(error);
      }
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

    // amqplib emits 'error' on the ChannelModel for connection-level failures
    // (heartbeat timeout, ECONNRESET, server close-with-error). This internal
    // connection is never exposed to the caller, so without a listener here an
    // EventEmitter 'error' with zero listeners would crash the process.
    connection.on('error', (err: unknown) => {
      logger.error(`sloth: listener connection error: ${errMessage(err)}`, {
        event: 'sloth.listener.connection_error',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
        reason: errMessage(err),
      });
    });
    connection.on('close', () => {
      logger.warn('sloth: listener connection closed', {
        event: 'sloth.listener.connection_closed',
        serviceName: config.serviceName,
        routingKey: config.routingKey,
      });
      notifyClosed('connection-closed');
    });

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
      notifyClosed('channel-closed');
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
      channel.assertQueue(queueName, {
        durable: true,
        expires: queueExpiresMs,
        ...(queueType === 'quorum' && { arguments: quorumQueueArguments }),
      }),
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
          // null = broker cancelled this consumer server-side (queue deleted,
          // node failover); nothing to ack, and no more deliveries will come.
          if (!message) {
            logger.warn('sloth: consumer cancelled by broker', {
              event: 'sloth.listener.consumer_cancelled',
              serviceName: config.serviceName,
              routingKey: config.routingKey,
            });
            notifyClosed('consumer-cancelled');
            return;
          }
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
          // Promise.resolve().then(...) contains a synchronously-throwing or
          // non-promise-returning onMessage: either still routes through the
          // .catch → nack path instead of escaping the consume callback.
          Promise.resolve()
            .then(() => onMessage(message))
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

    // Setup succeeded — from here on, death is reported via onClosed instead
    // of a rejected setup promise.
    armed = true;

    const close = async (): Promise<void> => {
      // Caller-initiated shutdown — the channel/connection close events this
      // provokes must not fire the onClosed death notification.
      userClosing = true;
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
    // Surface our own errors, WHATWG abort/timeout reasons, and caller abort
    // reasons verbatim; wrap a foreign (amqplib/broker) failure as
    // SlothConnectError with the cause chained.
    throw toSlothError(error, signal, SlothConnectError);
  }
}
