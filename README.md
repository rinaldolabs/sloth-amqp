# @rinaldolabs/sloth-amqp

[![CI](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@rinaldolabs/sloth-amqp.svg)](https://www.npmjs.com/package/@rinaldolabs/sloth-amqp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

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

## Compared to the Go client

This package implements the same wire protocol as [`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp) — they can interoperate with the same Sloth server. The TypeScript API intentionally diverges from the Go API where idiomatic TypeScript suggests a different shape:

- **Per-call config instead of a type registry.** The Go client uses `reflect.TypeOf` to map request structs to routing keys at registration time. We require the caller to pass `{ serviceName, routingKey }` per send. TypeScript has no runtime type reflection for arbitrary types, and explicit config is type-safer than a runtime registry.
- **Explicit listener handle.** `setupDelayedMessageListener` returns `SlothListenerHandle { consumerTag, close() }`. The Go client returns a `goamqp.Setup` function. The handle makes shutdown order explicit and prevents leaked consumers.
- **Caller-owned connection.** `slothConnect` returns a `ChannelModel` that the caller owns; `slothDelaySender(client)` is a factory that does not take ownership. The Go client's `New()` opens and closes its own connection. The split lets one connection serve multiple senders/listeners and makes tests trivial.
- **Strict ack model.** The listener uses `noAck: false` and explicitly `ack`s on success or `nack(requeue=false)` on handler failure, relying on a broker-configured DLX for retries. The Go client uses goamqp's defaults.
- **Injected logger.** All logging goes through an injected `SlothLogger` (`NoOpLogger` by default). Nothing is written to `console`.

These are deliberate API choices, not accidents. The wire protocol — exchange names, routing keys, `delay-until` and `target` headers — is identical to the Go client.

## Related

- [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp) — event streams and service request/response
- [Sloth server](https://gitlab.com/unboundsoftware/sloth) — the delay service this client connects to

## Acknowledgements

Built on the work of [Unbound Software AB](https://gitlab.com/unboundsoftware) and [opzkit](https://github.com/opzkit). See [NOTICE](./NOTICE) for the full attribution list. Specifically:

- **[`gitlab.com/unboundsoftware/sloth`](https://gitlab.com/unboundsoftware/sloth)** — the Sloth delayed-message AMQP server (MIT). The wire protocol implemented here (`sloth.direct.exchange.request`, `sloth.headers.exchange.response`, `delay-until` / `target` headers) comes directly from the upstream Sloth `amqp` source plugin.
- **[`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp)** — the canonical Go client (MIT). Used as the API-shape and behavior reference; the [Compared to the Go client](#compared-to-the-go-client) section above documents intentional divergences.
- **[`github.com/opzkit/nodeamqp`](https://github.com/opzkit/nodeamqp)** — sibling Node.js AMQP library by the same upstream maintainer (MIT). Project scaffolding (release-please, conventional commits, peer-dependency pattern) was modeled on it.

Standards and specs this project follows: [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), [Semantic Versioning 2.0.0](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/), and the [AMQP 0-9-1 protocol](https://www.rabbitmq.com/tutorials/amqp-concepts).

## License

MIT — see [LICENSE](./LICENSE).
