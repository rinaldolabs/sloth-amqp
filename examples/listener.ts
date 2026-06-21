// Listen for delivered delayed messages until interrupted.
//
// Run with:
//   AMQP_URL=amqp://guest:guest@localhost:5672/ node --experimental-strip-types examples/listener.ts
//
// On Node 24, type stripping is enabled by default for erasable TypeScript syntax.

import { consoleLogger, setupDelayedMessageListener } from '../src/index.ts';

const amqpUrl = process.env['AMQP_URL'];
if (!amqpUrl) {
  console.error('AMQP_URL must be set');
  process.exit(1);
}

const handle = await setupDelayedMessageListener({
  amqpUrl,
  config: { serviceName: 'example-service', routingKey: 'example.reminder' },
  logger: consoleLogger,
  onMessage: async (message) => {
    const payload: unknown = JSON.parse(message.content.toString());
    console.log('received delayed message', payload);
    return Promise.resolve();
  },
});

const shutdown = (): void => {
  void handle.close().then(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
