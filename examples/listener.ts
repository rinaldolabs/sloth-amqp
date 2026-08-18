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
  timeoutMs: 10_000, // bounds the queue/bind/consume setup phase
  onMessage: async (message) => {
    const payload: unknown = JSON.parse(message.content.toString());
    console.log('received delayed message', payload);
    return Promise.resolve();
  },
  // Fired at most once if the listener dies without close() being called.
  // The listener does not auto-reconnect — exit non-zero so a supervisor
  // (systemd, k8s, docker restart policy) restarts the process.
  onClosed: (reason) => {
    console.error('listener closed unexpectedly:', reason);
    process.exitCode = 1;
    process.exit(1);
  },
});

const shutdown = (): void => {
  void handle.close().then(() => {
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
