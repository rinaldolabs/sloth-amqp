import amqp, { type Channel, type ChannelModel } from 'amqplib';
import { NoOpLogger } from './logger.js';
import type { SlothListenerOptions } from './types.js';
import { getSlothQueueName, slothResponseExchangeName } from './utils.js';

let connection: ChannelModel | null = null;
let channel: Channel | null = null;

export async function setupDelayedMessageListener({
  amqpUrl,
  config,
  logger = new NoOpLogger(),
  onMessage,
}: SlothListenerOptions): Promise<void> {
  logger.info('Setting up delayed message listener');
  try {
    // Queue name follows Sloth's PublishServiceResponse convention
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
      expires: 432000000, // 5 days — queue auto-expires if the service is down
    });
    // Bind using headers: Sloth sets service={serviceName} when publishing the response
    await channel.bindQueue(queueName, slothResponseExchangeName, config.routingKey, {
      service: config.serviceName,
    });

    await channel.consume(
      queueName,
      (message) => {
        if (message) void onMessage(message);
      },
      { noAck: true },
    );

    logger.info('Waiting for delayed messages...');
  } catch (error) {
    logger.error('Error setting up delayed message listener');
    await cleanup();
    throw error;
  }
}

export async function cleanup(): Promise<void> {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
  } catch (error) {
    console.error('Error during cleanup:', error);
  }
}
