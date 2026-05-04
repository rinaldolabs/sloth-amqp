# @rinaldolabs/sloth-amqp

Node.js TypeScript client for [Sloth](https://gitlab.com/unboundsoftware/sloth) — a delayed-message delivery service over AMQP/RabbitMQ.

This package is the TypeScript counterpart to `gitlab.com/unboundsoftware/sloth/client-amqp` and is wire-compatible with Sloth `amqp:0.0.10`. It complements [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp), which handles event streams and request/response patterns.

## Installation

```sh
npm install @rinaldolabs/sloth-amqp amqplib
```

Requires `amqplib >= 1.0.0` as a peer dependency.

## How Sloth works

Sloth is a message delay service. Instead of delivering a message immediately, your service publishes it to Sloth with a `delay-until` timestamp. Sloth holds the message and re-delivers it to your response queue when the time arrives.

```
Your service
    │
    │  Publish to sloth.direct.exchange.request
    │  Routing key: "delay"
    │  Headers: { "delay-until": <unix seconds>, "target": "amqp://<serviceName>/<routingKey>" }
    ▼
Sloth server (holds until delay-until)
    │
    │  (time elapsed)
    │  Delivers to sloth.headers.exchange.response
    │  Queue: sloth.headers.exchange.response.queue.<serviceName>
    ▼
Your listener
```

## Usage

### Sending a delayed message

```ts
import { slothConnect, slothDelaySender } from '@rinaldolabs/sloth-amqp';

const config = { serviceName: 'my-service', routingKey: 'my.delayed' };
const client = await slothConnect(process.env.AMQP_URL);
const send = slothDelaySender(client);

await send({
  data: { key: 'user.verify', userId: '123' },
  delayMinutes: 30,
  config,
  logger: myLogger,
});
```

### Listening for delivered messages

```ts
import { setupDelayedMessageListener } from '@rinaldolabs/sloth-amqp';

const config = { serviceName: 'my-service', routingKey: 'my.delayed' };

const handle = await setupDelayedMessageListener({
  amqpUrl: process.env.AMQP_URL,
  config,
  logger: myLogger, // optional — defaults to NoOpLogger
  onMessage: async (message) => {
    const data = JSON.parse(message.content.toString()) as { key: string };
    // dispatch on data.key here
  },
});

// Clean up on shutdown — closes the consumer, channel and connection
process.on('SIGTERM', () => void handle.close());
process.on('SIGINT', () => void handle.close());
```

### Custom logger

Pass any logger that satisfies `SlothLogger` (winston, pino, console, etc.):

```ts
import type { SlothLogger } from '@rinaldolabs/sloth-amqp';

const logger: SlothLogger = {
  info: (msg, ...meta) => console.log(msg, ...meta),
  warn: (msg, ...meta) => console.warn(msg, ...meta),
  error: (msg, ...meta) => console.error(msg, ...meta),
  debug: (msg, ...meta) => console.debug(msg, ...meta),
  child: () => logger,
};
```

`NoOpLogger` (the default) silently discards all log calls.

### Setup composition

`slothConnect` accepts optional `SlothSetup` functions, mirroring the `@opzkit/nodeamqp` composition pattern:

```ts
const client = await slothConnect(process.env.AMQP_URL, async (conn) => {
  conn.on('error', (err) => myLogger.error('AMQP error', err));
});
```

## Protocol constants

```ts
import {
  slothRequestExchangeName, // "sloth.direct.exchange.request"
  slothResponseExchangeName, // "sloth.headers.exchange.response"
  getSlothQueueName, // (config) => "sloth.headers.exchange.response.queue.<serviceName>"
  getSlothTarget, // (config) => "amqp://<serviceName>/<routingKey>"
} from '@rinaldolabs/sloth-amqp';
```

## Wire compatibility

Implements the Sloth AMQP protocol as defined in [gitlab.com/unboundsoftware/sloth/amqp](https://gitlab.com/unboundsoftware/sloth/amqp) (compatible with `amqp:0.0.10`).

Headers sent with each delayed message:

| Header        | Type                   | Description                                                |
| ------------- | ---------------------- | ---------------------------------------------------------- |
| `delay-until` | `int64` (unix seconds) | When to deliver the message                                |
| `target`      | `string` (AMQP URL)    | Response destination: `amqp://<serviceName>/<routingKey>` |

## Related

- [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp) — event streams and service request/response
- [Sloth server](https://gitlab.com/unboundsoftware/sloth) — the delay service this client connects to

## License

MIT
