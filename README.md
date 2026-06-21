# @rinaldolabs/sloth-amqp

[![CI](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@rinaldolabs/sloth-amqp.svg)](https://www.npmjs.com/package/@rinaldolabs/sloth-amqp)
[![install size](https://packagephobia.com/badge?p=@rinaldolabs/sloth-amqp)](https://packagephobia.com/result?p=@rinaldolabs/sloth-amqp)
[![bundle size](https://img.shields.io/badge/bundle-%3C6KB%20gz-brightgreen)](./.size-limit.cjs)
[![types: built-in](https://img.shields.io/badge/types-built--in-blue)](./src/index.ts)
[![Node](https://img.shields.io/node/v/@rinaldolabs/sloth-amqp)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![provenance](https://img.shields.io/badge/npm-provenance-blueviolet)](https://docs.npmjs.com/generating-provenance-statements)

Node.js TypeScript client for [Sloth](https://gitlab.com/unboundsoftware/sloth) — a delayed-message delivery service over AMQP/RabbitMQ.

This package implements the same wire protocol as [`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp) (the canonical Go client) — the two can interoperate against the same Sloth server — but the TypeScript API is intentionally different; see [Compared to the Go client](#compared-to-the-go-client). The `SlothSetup` composition pattern is borrowed from [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp); the two libraries are otherwise independent and cover different patterns (`nodeamqp` handles event streams and request/response; this one handles delayed messages via Sloth).

## Installation

```sh
npm install @rinaldolabs/sloth-amqp amqplib
```

Requires `amqplib` `^2.0.0` as a peer dependency.

The package is **dual-published** as both ESM (`dist/index.js`) and CJS (`dist/index.cjs`) with matching `.d.ts` / `.d.cts` declarations. Node's resolver picks the right format automatically — works out of the box with Node ESM, Vitest, Jest (+ `@swc/jest`), ts-node, Bun, and Deno without any test-runner configuration.

> **Dual-package note.** Avoid mixing ESM `import` and CJS `require` of this package in the same process. The `createDelaySender` factory caches a `ConfirmChannel` in closure state; loading the package twice (once per format) gives you two independent caches. In practice, apps pick one module system and this is a non-issue.

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
import { createDelaySender, slothConnect } from '@rinaldolabs/sloth-amqp';

const config = { serviceName: 'my-service', routingKey: 'my.delayed' };
const client = await slothConnect(process.env.AMQP_URL);
const { send } = createDelaySender(client);

await send({
  data: { key: 'user.verify', userId: '123' },
  delayMinutes: 30,
  config,
  logger: myLogger,
});
```

Each call must specify **exactly one** of three delay variants:

```ts
await send({ data, config, logger, delayMinutes: 30 });
await send({ data, config, logger, delaySeconds: 90 });
await send({ data, config, logger, delayUntil: new Date('2030-01-01T00:00:00Z') });
```

Optional fields on every variant:

| Field      | Type           | Notes                                                                                                                  |
| ---------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `logLabel` | `string`       | Human-readable identifier used in log lines. Sanitized (control chars stripped, capped at 200 grapheme clusters). |
| `logLevel` | `SlothLogLevel` | Minimum level for **this library's** log calls. The caller's logger is otherwise unchanged.                            |

All variants are validated before any AMQP work happens: positive and finite numbers, valid `Date`, capped at ~100 years (`MAX_DELAY_SECONDS`). A `delayUntil` in the past is logged at `warn` and still published — Sloth will deliver immediately, matching the upstream Go client's behavior. If you set `logLevel: 'error'` (or wrap with `withLogLevel(..., 'error')`), this warning is suppressed; use `'warn'` or lower if you want to see past-date schedules.

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

Optional fields on `setupDelayedMessageListener`:

| Field            | Type     | Default  | Notes                                                                                                                                                       |
| ---------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queueExpiresMs` | `number` | 5 days   | Auto-expiry for the response queue when no consumer is connected (`x-expires`). Must be positive and finite.                                                |
| `prefetch`       | `number` | `20`     | Consumer prefetch (QoS) — max unacknowledged messages delivered at once. Sloth re-delivers in bursts, so a bounded window caps memory. `0` = unlimited. Must be a non-negative integer. |

### Health checks

`ping(client, opts?)` is a cheap liveness probe — it opens a temporary channel, asserts that the Sloth request exchange is reachable, and closes the channel. Suitable for Kubernetes readiness/liveness endpoints and graceful-startup gates.

```ts
import { ping, slothConnect } from '@rinaldolabs/sloth-amqp';

const client = await slothConnect(process.env.AMQP_URL);

// In your /readyz handler:
app.get('/readyz', async (_req, res) => {
  try {
    await ping(client, { timeoutMs: 2_000 });
    res.status(200).send('ok');
  } catch {
    res.status(503).send('sloth unreachable');
  }
});
```

The probe completes if and only if (1) the broker accepts a new channel on the existing connection and (2) the Sloth request exchange exists. `ping` accepts the same `signal` / `timeoutMs` as the other entry points.

### Tracing and message identity

Every `send` publishes the message with an auto-generated `messageId` (UUID via `node:crypto`'s `randomUUID`) on the AMQP basic properties. Consumers read it via `message.properties.messageId` — useful as a free idempotency key. Callers can override with their own ID for deterministic dedup.

`correlationId` is forwarded to AMQP basic properties when set; consumers read it via `message.properties.correlationId`.

For distributed tracing, pass W3C trace context as headers — they survive the Sloth hop without the package taking an OpenTelemetry dependency:

```ts
import { context, propagation } from '@opentelemetry/api';

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);

await send({
  data,
  config,
  delaySeconds: 60,
  logger,
  correlationId: 'order-abc-123',
  headers: carrier, // forwards traceparent, tracestate
});
```

The headers `delay-until` and `target` are reserved by the Sloth wire protocol — passing them throws before any AMQP work happens.

### Log events

Every log call from this package emits an object-first second argument with a stable `event` name plus context fields. The names below are part of the public contract — renames are breaking changes.

| Event | Level | Where | Context fields |
| ----- | ----- | ----- | -------------- |
| `sloth.publish.scheduling` | debug | sender | `serviceName`, `routingKey`, `messageId`, `correlationId`, `delayDesc` |
| `sloth.publish.confirmed` | info | sender | + `durationMs` |
| `sloth.publish.back_pressured` | warn | sender | `serviceName`, `routingKey`, `messageId` |
| `sloth.publish.failed` | error | sender | + `durationMs`, `reason` |
| `sloth.publish.past_date_warning` | warn | sender | `serviceName`, `routingKey` |
| `sloth.listener.setup_started` | debug | listener | `serviceName`, `routingKey` |
| `sloth.listener.ready` | info | listener | + `queueName`, `consumerTag` |
| `sloth.listener.handler_failed` | error | listener | + `messageId`, `correlationId`, `reason` |
| `sloth.listener.channel_error` | error | listener | + `reason` |
| `sloth.listener.channel_closed` | warn | listener | `serviceName`, `routingKey` |
| `sloth.listener.consumer_cancel_failed` | error | listener | + `consumerTag`, `reason` |
| `sloth.listener.resources_release_failed` | error | listener | + `reason` |
| `sloth.listener.setup_failed` | error | listener | + `reason` |
| `sloth.ping.failed` | error | ping | `reason` |

### Cancellation and timeouts

Both `slothConnect` and `setupDelayedMessageListener` accept an optional `signal` (`AbortSignal`) and `timeoutMs` to bound the network setup phase. Internally they compose via `AbortSignal.any` and reject with `signal.reason` propagated **verbatim**, matching WHATWG `fetch`/undici semantics — the package never wraps the reason.

The reason depends on what fired:

| Source | Resulting `signal.reason` |
| ------ | ------------------------- |
| `AbortSignal.timeout(ms)` | `DOMException` with `name === 'TimeoutError'` |
| `controller.abort()` (no argument) | `DOMException` with `name === 'AbortError'` |
| `controller.abort(reason)` | `reason` as-is — `Error`, string, or any value the caller passes |

```ts
import { slothConnect, setupDelayedMessageListener } from '@rinaldolabs/sloth-amqp';

// Bound by a 10-second timeout — first arg after `url` may be an options bag.
const client = await slothConnect(amqpUrl, { timeoutMs: 10_000 });

// Or a caller-supplied AbortController shared across operations.
const ac = new AbortController();
process.on('SIGTERM', () => ac.abort());
const client = await slothConnect(amqpUrl, { signal: ac.signal });

// Both — first source to fire wins, and signal.reason carries that source's reason.
const client = await slothConnect(amqpUrl, { signal: ac.signal, timeoutMs: 30_000 });

// Listener accepts the same options inline.
const handle = await setupDelayedMessageListener({
  amqpUrl,
  config,
  onMessage,
  signal: ac.signal,
  timeoutMs: 15_000,
});

// Catching abort/timeout errors. `err` is `unknown` in strict TS, so narrow
// before reading `.name`. Custom abort reasons may not be DOMException-shaped.
try {
  await slothConnect(amqpUrl, { timeoutMs: 100 });
} catch (err) {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    // bounded by timeoutMs
  } else if (err instanceof DOMException && err.name === 'AbortError') {
    // caller invoked controller.abort() with no argument
  } else {
    // either a custom abort reason from controller.abort(reason),
    // or a real network/protocol error from amqplib
  }
}
```

The cancellation window covers connect + handshake + setup. After the operation resolves, the signal stops mattering — manage lifetime via `slothClose(client)` or `handle.close()`.

> Existing `slothConnect(url, ...setups)` callers keep working unchanged. The options bag is optional and detected by shape (object vs function), so adding it doesn't break the variadic setup-functions form. Passing `undefined` in the options slot — e.g. `slothConnect(url, maybeOpts, setupFn)` where `maybeOpts` is `undefined` — also works; the discriminator treats it as "no options" and the trailing arguments are still picked up as setup functions.

### Logger compatibility

Any object satisfying `SlothLogger` works. `child()` is **optional** — loggers that don't support contextual children (`console`, `@nestjs/common` Logger, electron-log, etc.) can omit it. The package never relies on `child()` internally; `withLogLevel` only proxies it when the wrapped logger has it.

| Logger | How to pass it |
| ------ | -------------- |
| **winston** | `logger` directly — `winston.Logger` is structurally compatible |
| **pino** | `logger` directly — `pino.Logger` is structurally compatible |
| **bunyan** | `logger` directly |
| **console** | Use the exported `consoleLogger` |
| **`@nestjs/common` Logger** | Wrap (signature is `(message, context?)`, not `(message, ...meta)`) — see snippet below |
| Custom | Implement `info / warn / error / debug` (and optionally `child`) |

```ts
import { consoleLogger, NoOpLogger } from '@rinaldolabs/sloth-amqp';

await send({ data, config, logger: consoleLogger, delayMinutes: 30 });
// NoOpLogger (the default) silently discards all log calls.
```

**Nest.js adapter:**

```ts
import { Logger } from '@nestjs/common';
import type { SlothLogger } from '@rinaldolabs/sloth-amqp';

const nest = new Logger('Sloth');
const slothLogger: SlothLogger = {
  info: (msg, ...meta) => nest.log(msg, ...meta.map(String)),
  warn: (msg, ...meta) => nest.warn(msg, ...meta.map(String)),
  error: (msg, ...meta) => nest.error(msg, ...meta.map(String)),
  debug: (msg, ...meta) => nest.debug(msg, ...meta.map(String)),
};
```

### Setup composition

`slothConnect` accepts optional `SlothSetup` functions, mirroring the `@opzkit/nodeamqp` composition pattern:

```ts
const client = await slothConnect(process.env.AMQP_URL, async (conn) => {
  conn.on('error', (err) => myLogger.error('AMQP error', err));
});
```

## Public exports

Everything below is re-exported from the package root.

### Protocol constants and helpers

```ts
import {
  slothRequestExchangeName,        // "sloth.direct.exchange.request"
  slothResponseExchangeName,       // "sloth.headers.exchange.response"
  defaultListenerQueueExpiresMs,   // 5 days, in ms
  getSlothQueueName,               // (config) => "sloth.headers.exchange.response.queue.<serviceName>"
  getSlothTarget,                  // (config) => "amqp://<serviceName>/<routingKey>"
  assertSafeSlothConfig,           // throws if serviceName/routingKey contain unsafe chars
} from '@rinaldolabs/sloth-amqp';
```

### Pure helpers (re-exported for callers that want to validate ahead of `send`)

```ts
import {
  MAX_DELAY_SECONDS,        // ~100 years in seconds
  resolveDelaySeconds,      // (DelaySpec) => { delayUntilUnix, delayDesc, pastDateWarning? }
  sanitizeLabel,            // (raw) => safe single-line string, max 200 grapheme clusters
  serializeData,            // (data) => Buffer; throws on non-JSON-serializable input
} from '@rinaldolabs/sloth-amqp';
```

### Types

```ts
import type {
  SlothConfig,
  SlothLogger,
  SlothLogLevel,
  SlothSetup,
  SlothListenerOptions,
  SlothListenerHandle,
  SendDelayMessageParams,
  DelaySpec,
} from '@rinaldolabs/sloth-amqp';
```

## Why this and not …

| Capability | `@rinaldolabs/sloth-amqp` | `amqplib` raw | `amqp-connection-manager` | `bullmq` |
| ---------- | ------------------------- | ------------- | ------------------------- | -------- |
| Sloth wire protocol (delayed messages over AMQP) | ✅ first-class | ❌ build it yourself | ❌ build it yourself | ❌ different system |
| Confirm-channel publish with broker ack | ✅ auto | manual | ✅ | n/a |
| Auto-recreate channel on broker error/close | ✅ | manual | ✅ | n/a |
| `AbortSignal` + `timeoutMs` on connect/setup | ✅ verbatim WHATWG reasons | ❌ | ❌ | partial |
| `messageId` auto-UUID + `correlationId` propagation | ✅ | manual | manual | ✅ |
| W3C trace-context (`traceparent`) header passthrough | ✅ via `headers` | manual | manual | partial |
| Health-check helper (`ping`) | ✅ | manual | manual | n/a |
| Dual ESM + CJS published | ✅ | ✅ | ✅ | ✅ |
| Built-in TypeScript types (no `@types/*`) | ✅ | ✅ | ✅ | ✅ |
| Zero runtime dependencies | ✅ (amqplib is a peer dep) | n/a | adds reconnect-core | many |
| Object-first structured log events | ✅ stable contract | n/a | n/a | partial |
| Bundle size (minified+brotli) | ~3 KB per format | n/a | larger | much larger |
| npm provenance (Sigstore) | ✅ | varies | varies | varies |

`amqplib` is a peer dependency, not a competitor — this package is a thin layer on top. The comparison is for "what can I drop in without rebuilding the same wheels every consumer of `amqplib` builds."

## Wire compatibility

Implements the Sloth AMQP protocol as defined by the upstream [`amqp` source plugin](https://gitlab.com/unboundsoftware/sloth/amqp). The wire format — exchange names, routing keys, header names and types, queue naming — is treated as a fixed contract and verified by `test/integration/wire-protocol.test.ts` against a real RabbitMQ container.

Headers sent with each delayed message:

| Header        | Type                   | Description                                                |
| ------------- | ---------------------- | ---------------------------------------------------------- |
| `delay-until` | `int64` (unix seconds) | When to deliver the message                                |
| `target`      | `string` (AMQP URL)    | Response destination: `amqp://<serviceName>/<routingKey>` |

## Compared to the Go client

The wire protocol — exchange names, routing keys, `delay-until` / `target` headers — is identical to [`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp). The TypeScript API intentionally diverges from the Go API where idiomatic TypeScript suggests a different shape:

- **Per-call config instead of a type registry.** The Go client uses `reflect.TypeOf` to map request structs to routing keys at registration time (`New(serviceName, url, mappings...)`). We require the caller to pass `{ serviceName, routingKey }` per send. TypeScript has no runtime type reflection for arbitrary types, and explicit config is type-safer than a runtime registry.
- **Explicit listener handle.** `setupDelayedMessageListener` returns `SlothListenerHandle { consumerTag, close() }`. The Go client returns a `goamqp.Setup` function and exposes `ResponseListener(handler, types...)`. The handle makes shutdown order explicit and prevents leaked consumers.
- **Caller-owned connection.** `slothConnect` returns a `ChannelModel` that the caller owns; `createDelaySender(client)` is a factory that does not take ownership. The Go client's `New()` opens and `Close()` closes the connection. The split lets one connection serve multiple senders/listeners and makes tests trivial. The factory caches one [confirm channel](https://www.rabbitmq.com/docs/confirms#publisher-confirms) for its lifetime — `await sender.send(...)` resolves only after the broker has acknowledged the publish (it rejects on a broker nack), and the channel is transparently re-created if the broker closes or errors it.
- **Three delay variants.** `delayMinutes`, `delaySeconds`, or `delayUntil: Date` — exactly one per send, enforced by a discriminated union at compile time and by a runtime guard at the system boundary. The Go client takes a single `time.Time`.
- **Strict ack model.** The listener uses `noAck: false` and explicitly `ack`s on success or `nack(requeue=false)` on handler failure, relying on a broker-configured DLX for retries. The Go client uses goamqp's defaults.
- **Injected logger.** All logging goes through an injected `SlothLogger` (`NoOpLogger` by default). Nothing is written to `console`.

## Related

- [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp) — event streams and service request/response
- [Sloth server](https://gitlab.com/unboundsoftware/sloth) — the delay service this client connects to

## Acknowledgements

Built on the work of [Unbound Software AB](https://gitlab.com/unboundsoftware) and [opzkit](https://github.com/opzkit). See [NOTICE](./NOTICE) for the full attribution list. Specifically:

- **[`gitlab.com/unboundsoftware/sloth`](https://gitlab.com/unboundsoftware/sloth)** — the Sloth delayed-message AMQP server (MIT). The wire protocol implemented here (`sloth.direct.exchange.request`, `sloth.headers.exchange.response`, `delay-until` / `target` headers) comes directly from the upstream Sloth `amqp` source plugin.
- **[`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp)** — the canonical Go client (MIT). Used as the API-shape and behavior reference; the [Compared to the Go client](#compared-to-the-go-client) section above documents intentional divergences.
- **[`github.com/opzkit/nodeamqp`](https://github.com/opzkit/nodeamqp)** — Node.js AMQP library for event streams and request/response (MIT). The `SlothSetup` composition pattern (passing setup functions to `slothConnect`) and project scaffolding (release-please, conventional commits, `amqplib` as a peer dependency) were modeled on it. The runtime code is independent.

Standards and specs this project follows: [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), [Semantic Versioning 2.0.0](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/), and the [AMQP 0-9-1 protocol](https://www.rabbitmq.com/tutorials/amqp-concepts).

## License

MIT — see [LICENSE](./LICENSE).
