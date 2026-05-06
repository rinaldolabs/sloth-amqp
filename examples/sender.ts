// Send a single delayed message and exit.
//
// Run with:
//   AMQP_URL=amqp://guest:guest@localhost:5672/ node --experimental-strip-types examples/sender.ts
//
// On Node 24, type stripping is enabled by default for erasable TypeScript syntax.

import { createDelaySender, slothClose, slothConnect, type SlothLogger } from '../src/index.ts';

const consoleLogger: SlothLogger = {
  info: (msg) => {
    console.log(msg);
  },
  warn: (msg) => {
    console.warn(msg);
  },
  error: (msg) => {
    console.error(msg);
  },
  debug: (msg) => {
    console.debug(msg);
  },
  child: () => consoleLogger,
};

const amqpUrl = process.env['AMQP_URL'];
if (!amqpUrl) {
  console.error('AMQP_URL must be set');
  process.exit(1);
}

const client = await slothConnect(amqpUrl);
const { send } = createDelaySender(client);

await send({
  data: { kind: 'reminder', userId: 'user-123' },
  delayMinutes: 1,
  logger: consoleLogger,
  config: { serviceName: 'example-service', routingKey: 'example.reminder' },
  logLabel: 'reminder',
});

await slothClose(client);
