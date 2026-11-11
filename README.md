# @rinaldolabs/sloth-amqp

[![CI](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml/badge.svg)](https://github.com/rinaldolabs/sloth-amqp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@rinaldolabs/sloth-amqp.svg)](https://www.npmjs.com/package/@rinaldolabs/sloth-amqp)
[![install size](https://packagephobia.com/badge?p=@rinaldolabs/sloth-amqp)](https://packagephobia.com/result?p=@rinaldolabs/sloth-amqp)
[![bundle size](https://img.shields.io/badge/bundle-~4KB%20br-brightgreen)](./.size-limit.cjs)
[![types: built-in](https://img.shields.io/badge/types-built--in-blue)](./src/index.ts)
[![Node](https://img.shields.io/node/v/@rinaldolabs/sloth-amqp)](./package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![provenance](https://img.shields.io/badge/npm-provenance-blueviolet)](https://docs.npmjs.com/generating-provenance-statements)

Node.js TypeScript client for [Sloth](https://codeberg.org/sloth-scheduler) — a delayed-message delivery service over AMQP/RabbitMQ.

This package implements the same wire protocol as [`codeberg.org/sloth-scheduler/client-amqp`](https://codeberg.org/sloth-scheduler/client-amqp) (the canonical Go client) — the two can interoperate against the same Sloth server — but the TypeScript API is intentionally different; see [Compared to the Go client](#compared-to-the-go-client). The `SlothSetup` composition pattern is borrowed from [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp); the two libraries are otherwise independent and cover different patterns (`nodeamqp` handles event streams and request/response; this one handles delayed messages via Sloth).

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

const amqpUrl = process.env.AMQP_URL;
if (!amqpUrl) throw new Error('AMQP_URL must be set');

const config = { serviceName: 'my-service', routingKey: 'my.delayed' };
const client = await slothConnect(amqpUrl);
const { send } = createDelaySender(client);

await send({
  data: { key: 'user.verify', userId: '123' },
  delayMinutes: 30,
  config,
  logger: myLogger,
});
```

Messages are published **persistent** (`deliveryMode: 2`) with `contentType: application/json` — wire parity with the Go client, so a broker restart before Sloth consumes the request cannot drop it.

Each call must specify **exactly one** of three delay variants:

```ts
await send({ data, config, logger, delayMinutes: 30 });
await send({ data, config, logger, delaySeconds: 90 });
await send({ data, config, logger, delayUntil: new Date('2030-01-01T00:00:00Z') });
```

Optional fields on every variant:

| Field       | Type            | Notes                                                                                                                                       |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `logLabel`  | `string`        | Human-readable identifier used in log lines. Sanitized (control chars stripped, capped at 200 grapheme clusters).                           |
| `logLevel`  | `SlothLogLevel` | Minimum level for **this library's** log calls. The caller's logger is otherwise unchanged.                                                 |
| `timeoutMs` | `number`        | Bounds the whole publish — channel acquire **and** broker confirm; on expiry `send` rejects with `SlothTimeoutError`. See the caveat below. |
| `signal`    | `AbortSignal`   | Caller signal bounding the same window. An abort that fires before the publish is issued rejects **without publishing**.                    |

All variants are validated before any AMQP work happens: positive and finite numbers, valid `Date`, capped at ~100 years (`MAX_DELAY_SECONDS`). A `delayUntil` in the past is logged at `warn` and still published — Sloth will deliver immediately, matching the upstream Go client's behavior. If you set `logLevel: 'error'` (or wrap with `withLogLevel(..., 'error')`), this warning is suppressed; use `'warn'` or lower if you want to see past-date schedules.

> **Publish timeout & at-least-once.** Without `timeoutMs`/`signal`, `send` resolves only when the broker confirms (or the channel closes). On a black-hole partition (socket alive but no confirm) it can hang until heartbeats trip the channel — and **indefinitely** if the connection was opened with `heartbeat: 0`, which genuinely disables heartbeats on amqplib v2. Set `timeoutMs` to bound this. **A timed-out publish may still have reached the broker** — delivery is at-least-once, so make consumers idempotent. A timeout does not recreate the cached channel (the message may yet confirm); only a broker error/close does.

> **Unroutable requests (opt-in `mandatory`).** By default a request that no queue receives (Sloth not running on this broker yet, or its request queue expired after 5 idle days) is confirmed and dropped, so `send` resolves. Pass `createDelaySender(client, { mandatory: true })` to make such a send reject with a `SlothPublishError` instead; this is worth turning on before switching to a fresh broker. With the option on, each publish carries an `x-sloth-publish-id` header (matching the broker's return to its confirm), and passing that header yourself throws. A `mandatory` value that is not a boolean throws `SlothValidationError` when the sender is created. A resolved send then means the request reached at least one queue and was confirmed, not that Sloth has processed it.

### Listening for delivered messages

```ts
import { setupDelayedMessageListener } from '@rinaldolabs/sloth-amqp';

const config = { serviceName: 'my-service', routingKey: 'my.delayed' };

const amqpUrl = process.env.AMQP_URL;
if (!amqpUrl) throw new Error('AMQP_URL must be set');

const handle = await setupDelayedMessageListener({
  amqpUrl,
  config,
  logger: myLogger, // optional — defaults to NoOpLogger
  onMessage: async (message) => {
    const data = JSON.parse(message.content.toString()) as { key: string };
    // dispatch on data.key here
  },
  onClosed: (reason) => {
    // The listener died without close() being called — see the supervision
    // note below. Re-run setupDelayedMessageListener, or exit and let the
    // orchestrator restart the process.
    myLogger.error(`sloth listener closed: ${reason}`);
    process.exit(1);
  },
});

// Clean up on shutdown — closes the consumer, channel and connection
process.on('SIGTERM', () => void handle.close());
process.on('SIGINT', () => void handle.close());
```

The handle is an `AsyncDisposable`, so you can also scope it with `await using` (TS 5.2+, Node 24) — `close()` runs automatically on scope exit:

```ts
await using handle = await setupDelayedMessageListener({ amqpUrl, config, onMessage });
// handle.close() is called when this scope exits (including on throw).
```

Optional fields on `setupDelayedMessageListener`:

| Field            | Type                                          | Default | Notes                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queueExpiresMs` | `number`                                      | 5 days  | Auto-expiry for the response queue when no consumer is connected (`x-expires`). Must be a positive integer.                                                                                                                                                                                                                   |
| `prefetch`       | `number`                                      | `20`    | Consumer prefetch (QoS) — max unacknowledged messages delivered at once. Sloth re-delivers in bursts, so a bounded window caps memory. `0` = unlimited. Must be a non-negative integer.                                                                                                                                       |
| `graceTimeoutMs` | `number`                                      | `10000` | How long `handle.close()` waits for in-flight `onMessage` handlers to settle (after cancelling the consumer) before closing the channel. `0` skips the wait. Must be a non-negative integer.                                                                                                                                  |
| `onClosed`       | `(reason: SlothListenerClosedReason) => void` | —       | Opt-in death notification — see the supervision note below.                                                                                                                                                                                                                                                                   |
| `queueType`      | `'quorum'`                                    | omitted | Omitted: no `x-queue-type` is sent and the vhost default decides (classic on a default broker). `'quorum'` adds `x-queue-type: quorum` and `x-single-active-consumer: true`, the response queue Sloth's Go client v1.0.x declares. A queue keeps the type it was created with. Any other value throws `SlothValidationError`. |

> **Shutdown & at-least-once.** `handle.close()` cancels the consumer (no new deliveries), waits up to `graceTimeoutMs` for in-flight handlers to finish, then closes the channel and connection. A clean drain avoids the broker requeuing messages a handler was mid-way through — but if a handler is still running when the grace period elapses (or you set `graceTimeoutMs: 0`), its message is requeued and redelivered (`redelivered: true`) on next connect. Delivery is at-least-once either way, so handlers must be idempotent.

> **Supervision — the listener does not reconnect.** The listener owns an internal AMQP connection; if that connection drops (broker restart, heartbeat timeout), the broker closes the channel, or the consumer is cancelled server-side (queue deleted, node failover), the consumer is **dead** and no further messages arrive. The library logs the event and — if you passed `onClosed` — calls it exactly once with the reason (`'connection-closed'` | `'channel-closed'` | `'consumer-cancelled'`; never for your own `close()`). Production deployments must react: re-run `setupDelayedMessageListener` with backoff, or exit and let the orchestrator restart the process. Note that `ping()` probes the **sender's** connection, not the listener's — a dead listener does not fail your readiness probe by itself.

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

### Wire-message tap

Pass `onWireMessage` to `send` or `setupDelayedMessageListener` to observe the raw bytes crossing the wire — one call per publish (`direction: 'out'`) and per delivery (`direction: 'in'`). This lets you inspect or record payloads/routing without the library logging them itself (its structured logs never contain message bodies — the hook is the only opt-in path bytes leave):

```ts
import type { SlothWireEvent } from '@rinaldolabs/sloth-amqp';

const onWireMessage = (e: SlothWireEvent) => {
  if (e.direction === 'out') {
    metrics.recordPublish(e.routingKey, e.content.byteLength);
  } else {
    metrics.recordDelivery(e.routingKey, e.redelivered);
  }
};

await send({ data, config, logger, delaySeconds: 60, onWireMessage });
const handle = await setupDelayedMessageListener({ amqpUrl, config, onMessage, onWireMessage });
```

The hook is synchronous and **not awaited**, so a slow observer never back-pressures the data path. If it throws, the error is caught and logged as `sloth.wire.hook_failed` and publish/consume proceeds unaffected. Treat `content` as read-only and do not retain the Buffer.

### Log events

Every log call from this package emits an object-first second argument with a stable `event` name plus context fields. The names below are part of the public contract — renames are breaking changes.

| Event                                     | Level | Where           | Context fields                                                         |
| ----------------------------------------- | ----- | --------------- | ---------------------------------------------------------------------- |
| `sloth.publish.scheduling`                | debug | sender          | `serviceName`, `routingKey`, `messageId`, `correlationId`, `delayDesc` |
| `sloth.publish.confirmed`                 | info  | sender          | + `durationMs`                                                         |
| `sloth.publish.back_pressured`            | warn  | sender          | `serviceName`, `routingKey`, `messageId`                               |
| `sloth.publish.failed`                    | error | sender          | + `durationMs`, `reason`                                               |
| `sloth.publish.past_date_warning`         | warn  | sender          | `serviceName`, `routingKey`                                            |
| `sloth.listener.setup_started`            | debug | listener        | `serviceName`, `routingKey`                                            |
| `sloth.listener.ready`                    | info  | listener        | + `queueName`, `consumerTag`                                           |
| `sloth.listener.handler_failed`           | error | listener        | + `messageId`, `correlationId`, `reason`                               |
| `sloth.listener.unexpected_message`       | error | listener        | + `messageId`, `correlationId`                                         |
| `sloth.listener.ack_failed`               | error | listener        | + `messageId`, `correlationId`, `reason`                               |
| `sloth.listener.nack_failed`              | error | listener        | + `messageId`, `correlationId`, `reason`                               |
| `sloth.listener.channel_error`            | error | listener        | + `reason`                                                             |
| `sloth.listener.channel_closed`           | warn  | listener        | `serviceName`, `routingKey`                                            |
| `sloth.listener.connection_error`         | error | listener        | + `reason`                                                             |
| `sloth.listener.connection_closed`        | warn  | listener        | `serviceName`, `routingKey`                                            |
| `sloth.listener.consumer_cancelled`       | warn  | listener        | `serviceName`, `routingKey`                                            |
| `sloth.listener.consumer_cancel_failed`   | error | listener        | + `consumerTag`, `reason`                                              |
| `sloth.listener.on_closed_failed`         | error | listener        | + `reason`                                                             |
| `sloth.listener.resources_release_failed` | error | listener        | + `reason`                                                             |
| `sloth.listener.setup_failed`             | error | listener        | + `reason`                                                             |
| `sloth.ping.channel_error`                | debug | ping            | `reason`                                                               |
| `sloth.ping.failed`                       | error | ping            | `reason`                                                               |
| `sloth.wire.hook_failed`                  | warn  | sender/listener | `direction`, `reason`                                                  |

### Errors

Every error this library throws extends `SlothError`, which carries a readonly `code` so you can branch on the failure kind without matching message strings:

| Class                  | `code`             | Thrown when                                                                                                                                                                                                  |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SlothValidationError` | `SLOTH_VALIDATION` | Invalid input caught at a boundary before any AMQP work (delay spec, config, `amqpUrl`, `queueExpiresMs`, `prefetch`, `timeoutMs`, reserved headers, non-serializable `data`). A caller bug — fix the input. |
| `SlothPublishError`    | `SLOTH_PUBLISH`    | A publish failed — broker nack, channel open/assert failure, or a channel that died before the publisher was ready. The original amqplib/broker cause is chained on `error.cause`.                           |
| `SlothTimeoutError`    | `SLOTH_TIMEOUT`    | A `send` exceeded its `timeoutMs` / `signal` deadline (see [Cancellation and timeouts](#cancellation-and-timeouts)).                                                                                         |
| `SlothConnectError`    | `SLOTH_CONNECT`    | `slothConnect`, `ping`, or listener setup failed against the broker; the amqplib cause is chained on `error.cause`.                                                                                          |

```ts
import { SlothTimeoutError, SlothValidationError } from '@rinaldolabs/sloth-amqp';

try {
  await send({ data, config, logger, delaySeconds: 60, timeoutMs: 5_000 });
} catch (e) {
  if (e instanceof SlothTimeoutError) {
    // confirm didn't arrive in time — may still have been delivered (see below)
  } else if (e instanceof SlothValidationError) {
    throw e; // a bug in the call — don't retry
  } else {
    throw e; // SlothPublishError, or a broker/network error
  }
}
```

Abort/timeout raised from a caller's **own** `AbortSignal` still surfaces as the WHATWG `DOMException` (`AbortError` / `TimeoutError`) — or the caller's custom abort reason **verbatim** — never wrapped in a `SlothError`. See [Cancellation and timeouts](#cancellation-and-timeouts).

> **Dual-package note on `instanceof`.** If your process somehow loads both the ESM and CJS builds (see the installation note above), each build has its own class identities and `instanceof SlothError` can fail across them. The `code` property is format-independent — prefer `err.code === 'SLOTH_TIMEOUT'`-style narrowing in code that might run in mixed-module setups.

### Cancellation and timeouts

Both `slothConnect` and `setupDelayedMessageListener` accept an optional `signal` (`AbortSignal`) and `timeoutMs` to bound the network setup phase. Internally they compose via `AbortSignal.any` and reject with `signal.reason` propagated **verbatim**, matching WHATWG `fetch`/undici semantics — the package never wraps the reason.

The reason depends on what fired:

| Source                             | Resulting `signal.reason`                                        |
| ---------------------------------- | ---------------------------------------------------------------- |
| `AbortSignal.timeout(ms)`          | `DOMException` with `name === 'TimeoutError'`                    |
| `controller.abort()` (no argument) | `DOMException` with `name === 'AbortError'`                      |
| `controller.abort(reason)`         | `reason` as-is — `Error`, string, or any value the caller passes |

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

| Logger                      | How to pass it                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- |
| **winston**                 | `logger` directly — `winston.Logger` is structurally compatible                         |
| **pino**                    | `logger` directly — `pino.Logger` is structurally compatible                            |
| **bunyan**                  | `logger` directly                                                                       |
| **console**                 | Use the exported `consoleLogger`                                                        |
| **`@nestjs/common` Logger** | Wrap (signature is `(message, context?)`, not `(message, ...meta)`) — see snippet below |
| Custom                      | Implement `info / warn / error / debug` (and optionally `child`)                        |

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

### Connection naming

Pass `connectionName` (or arbitrary `clientProperties`) so the connection is identifiable in RabbitMQ's management UI and `rabbitmqctl list_connections` — handy for spotting which service, pod, or version owns a connection:

```ts
import { slothConnect, slothClientProperties } from '@rinaldolabs/sloth-amqp';

// Explicit name:
const client = await slothConnect(process.env.AMQP_URL, {
  connectionName: 'orders-worker@pod-7',
});

// Or the helper default — `<serviceName>:sloth-amqp@<hostname>`:
const client2 = await slothConnect(process.env.AMQP_URL, {
  clientProperties: slothClientProperties({ serviceName: 'orders-worker' }),
});
```

`connectionName` is sent as `clientProperties.connection_name` and takes precedence over any `connection_name` in `clientProperties`. Do not put the AMQP URL, credentials, or other secrets in `clientProperties` — they are visible in the broker's management UI. The default hostname is a pod/task id in container environments but may be a personal machine name locally; pass an explicit `connectionName` when that matters.

### TLS, heartbeats, and socket options

`SlothConnectOptions.socketOptions` passes straight through as amqplib's second `connect` argument. That is the hook for mutual TLS on `amqps://` URLs and for amqplib's opt-in connection recovery:

```ts
const client = await slothConnect('amqps://broker.internal:5671', {
  connectionName: 'orders-worker@pod-7',
  socketOptions: {
    ca: [fs.readFileSync('/etc/tls/ca.pem')],
    cert: fs.readFileSync('/etc/tls/client.pem'),
    key: fs.readFileSync('/etc/tls/client.key'),
  },
});
```

A `clientProperties` key inside `socketOptions` is merged underneath the dedicated `clientProperties` / `connectionName` options (the dedicated ones win). Heartbeats are tuned via the URL query string (`amqp://…?heartbeat=30`); note that `heartbeat=0` genuinely disables them on amqplib v2 — see the publish-timeout caveat above.

## RabbitMQ versions

The same code runs on every supported broker; the library never checks the broker version. It asks only for per-consumer prefetch and durable queues, so the features RabbitMQ 4.3 denies by default (global QoS, transient non-exclusive queues) are not used. CI runs the integration suite against RabbitMQ 3.13.7, 4.2.5, 4.2.9, 4.3.7 and 4.4.0, each with a classic and a quorum default vhost. The suite uses a stand-in for the Sloth server, so it proves this library's wire behaviour, not a Sloth deployment end to end.

What still differs between broker versions:

| Behaviour                                        | 3.13 and 4.2                                         | 4.3.7 and 4.4.0                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consumer timeout (default 30 min), classic queue | Channel closed (`406`): `onClosed('channel-closed')` | Not evaluated                                                                                                                                                                                                                                       |
| Consumer timeout, quorum queue                   | Channel closed (`406`): `onClosed('channel-closed')` | Consumer cancelled: `onClosed('consumer-cancelled')`. In the tested images, an ack from the old handler after the cancel was followed by amqplib closing the channel (`Unknown consumer`); with no ack the channel stayed open for the 5 s observed |
| Quorum delivery limit                            | None on 3.13, 20 on 4.2                              | 20, counting only failed deliveries                                                                                                                                                                                                                 |
| Passive declare in `ping`                        | No permission check                                  | Configure permission (4.3); configure, write or read (4.4)                                                                                                                                                                                          |

In every timeout case the message goes back to the queue and is redelivered, so close the old handle, start a new listener and keep handlers idempotent. The 4.3 quorum row holds from 4.3.7 (earlier 4.3 patches are not tested), and a broker configured with `consumer_timeout_response = close_channel` closes the channel instead. `nack(requeue=false)` drops a message unless a dead-letter exchange is configured on the queue or by policy.

On a vhost whose default queue type is quorum, a listener without `queueType` gets a quorum queue, which works because the listener's prefetch is per consumer. A queue keeps its type and arguments: an existing queue refuses a declaration with different ones (`406 PRECONDITION_FAILED`), so a Node listener and a Go v1.0.x service sharing a `serviceName` must both use the quorum shape, and switching an existing queue needs a drain or a fresh broker.

## Operating in production

- **Connection ownership and `'error'` events.** The `ChannelModel` returned by `slothConnect` is yours — attach an `'error'` handler (see [Setup composition](#setup-composition)); an unhandled `'error'` event crashes a Node process. During `slothConnect`'s own setup window, and on every connection/channel the library creates internally (listener, ping), the library guards this for you.
- **Reconnection.** The **sender** transparently re-creates its cached channel after a channel-level error/close, and composes with amqplib's opt-in connection `recovery` (pass it via `socketOptions`) — after the connection recovers, the next `send` opens a fresh channel. The **listener** does not reconnect: supervise it via `onClosed` (see the supervision note above).
- **Broker alarms (`blocked`).** When RabbitMQ hits a resource alarm it accepts publishes but stalls confirms. A `send` with `timeoutMs` then rejects with `SlothTimeoutError` even though the broker is up. Subscribe to `client.on('blocked', ...)` / `'unblocked'` on the connection to tell the two apart in dashboards.
- **Back-pressure.** When the channel's write buffer is full, `publish` queues in memory and the library logs `sloth.publish.back_pressured` (it does not wait for `'drain'`). Sequential `await send(...)` callers are naturally throttled by the confirm; bound your own concurrency if you fire many unawaited sends.
- **Clock skew.** `delayMinutes`/`delaySeconds` are resolved to an absolute `delay-until` timestamp using the **producer's** clock. If your hosts drift, delivery drifts with them — use `delayUntil` with a trusted clock source when exact wall-clock delivery matters.

Everything below is re-exported from the package root.

### Protocol constants and helpers

```ts
import {
  slothRequestExchangeName, // "sloth.direct.exchange.request"
  slothResponseExchangeName, // "sloth.headers.exchange.response"
  slothDelayRoutingKey, // "delay"
  defaultListenerQueueExpiresMs, // 5 days, in ms
  defaultListenerPrefetch, // 20
  defaultListenerGraceTimeoutMs, // 10 seconds, in ms
  getSlothQueueName, // (config) => "sloth.headers.exchange.response.queue.<serviceName>"
  getSlothTarget, // (config) => "amqp://<serviceName>/<routingKey>"
  assertSafeSlothConfig, // throws if serviceName/routingKey contain unsafe chars
  slothClientProperties, // ({ serviceName, connectionName? }) => clientProperties object
} from '@rinaldolabs/sloth-amqp';
```

### Pure helpers (re-exported for callers that want to validate ahead of `send`)

```ts
import {
  MAX_DELAY_SECONDS, // ~100 years in seconds
  resolveDelaySeconds, // (DelaySpec) => { delayUntilUnix, delayDesc, pastDateWarning? }
  sanitizeLabel, // (raw) => safe single-line string, max 200 grapheme clusters
  serializeData, // (data) => Buffer; throws on non-JSON-serializable input
} from '@rinaldolabs/sloth-amqp';
```

### Errors and loggers

```ts
import {
  SlothError, // abstract base — instanceof-narrow or branch on `code`
  SlothValidationError,
  SlothPublishError,
  SlothTimeoutError,
  SlothConnectError,
  NoOpLogger, // the default logger — discards everything
  consoleLogger, // console-backed shim for scripts/demos
  withLogLevel, // (logger, minLevel) => level-filtered logger
} from '@rinaldolabs/sloth-amqp';
```

### Types

```ts
import type {
  SlothConfig,
  SlothConnectOptions,
  SlothErrorCode,
  SlothLogger,
  SlothLogLevel,
  SlothSetup,
  SlothListenerOptions,
  SlothListenerHandle,
  SlothListenerClosedReason,
  SendDelayMessageParams,
  DelaySender,
  DelaySenderOptions,
  DelaySpec,
  SlothQueueType,
  PingOptions,
  OnWireMessage,
  SlothWireEvent,
  SlothWireInbound,
  SlothWireOutbound,
} from '@rinaldolabs/sloth-amqp';
```

## Why this and not …

| Capability                                           | `@rinaldolabs/sloth-amqp`  | `amqplib` raw        | `amqp-connection-manager` | `bullmq`            |
| ---------------------------------------------------- | -------------------------- | -------------------- | ------------------------- | ------------------- |
| Sloth wire protocol (delayed messages over AMQP)     | ✅ first-class             | ❌ build it yourself | ❌ build it yourself      | ❌ different system |
| Confirm-channel publish with broker ack              | ✅ auto                    | manual               | ✅                        | n/a                 |
| Auto-recreate channel on broker error/close (sender) | ✅                         | manual               | ✅                        | n/a                 |
| Listener death notification (`onClosed`)             | ✅ opt-in callback         | manual               | event-based               | n/a                 |
| `AbortSignal` + `timeoutMs` on connect/setup         | ✅ verbatim WHATWG reasons | ❌                   | ❌                        | partial             |
| `messageId` auto-UUID + `correlationId` propagation  | ✅                         | manual               | manual                    | ✅                  |
| W3C trace-context (`traceparent`) header passthrough | ✅ via `headers`           | manual               | manual                    | partial             |
| Health-check helper (`ping`)                         | ✅                         | manual               | manual                    | n/a                 |
| Dual ESM + CJS published                             | ✅                         | ✅                   | ✅                        | ✅                  |
| Built-in TypeScript types (no `@types/*`)            | ✅                         | ✅                   | ✅                        | ✅                  |
| Zero runtime dependencies                            | ✅ (amqplib is a peer dep) | n/a                  | adds promise-breaker      | many                |
| Object-first structured log events                   | ✅ stable contract         | n/a                  | n/a                       | partial             |
| Bundle size (minified+brotli)                        | ~4 KB per format           | n/a                  | larger                    | much larger         |
| npm provenance (Sigstore)                            | ✅                         | varies               | varies                    | varies              |

`amqplib` is a peer dependency, not a competitor — this package is a thin layer on top. The comparison is for "what can I drop in without rebuilding the same wheels every consumer of `amqplib` builds."

## Wire compatibility

Implements the Sloth AMQP protocol as defined by the upstream [`amqp` source plugin](https://codeberg.org/sloth-scheduler/amqp) (formerly on GitLab, now archived there). The wire format — exchange names, routing keys, header names and types, queue naming — is treated as a fixed contract and verified by `test/integration/wire-protocol.test.ts` against a real RabbitMQ container.

Headers sent with each delayed message:

| Header        | Type                   | Description                                               |
| ------------- | ---------------------- | --------------------------------------------------------- |
| `delay-until` | `int64` (unix seconds) | When to deliver the message                               |
| `target`      | `string` (AMQP URL)    | Response destination: `amqp://<serviceName>/<routingKey>` |

Requests are published to `sloth.direct.exchange.request` with routing key `delay`, `deliveryMode: 2` (persistent) and `contentType: application/json` — the same message properties goamqp's `publishMessage` sets, so requests survive a broker restart while queued ahead of the Sloth consumer.

## Compared to the Go client

The wire protocol — exchange names, routing keys, `delay-until` / `target` headers — is identical to [`codeberg.org/sloth-scheduler/client-amqp`](https://codeberg.org/sloth-scheduler/client-amqp). Its v1.0.x declares the response queue as quorum with single active consumer; use `queueType: 'quorum'` when a Node listener shares a queue with it. The TypeScript API intentionally diverges from the Go API where idiomatic TypeScript suggests a different shape:

- **Per-call config instead of a type registry.** The Go client uses `reflect.TypeOf` to map request structs to routing keys at registration time (`New(serviceName, url, mappings...)`). We require the caller to pass `{ serviceName, routingKey }` per send. TypeScript has no runtime type reflection for arbitrary types, and explicit config is type-safer than a runtime registry.
- **Explicit listener handle.** `setupDelayedMessageListener` returns `SlothListenerHandle { consumerTag, close() }`. The Go client returns a `goamqp.Setup` function and exposes `ResponseListener(handler, types...)`. The handle makes shutdown order explicit and prevents leaked consumers.
- **Caller-owned connection.** `slothConnect` returns a `ChannelModel` that the caller owns; `createDelaySender(client)` is a factory that does not take ownership. The Go client's `New()` opens and `Close()` closes the connection. The split lets one connection serve multiple senders/listeners and makes tests trivial. The factory caches one [confirm channel](https://www.rabbitmq.com/docs/confirms#publisher-confirms) for its lifetime — `await sender.send(...)` resolves only after the broker has acknowledged the publish (it rejects on a broker nack), and the channel is transparently re-created if the broker closes or errors it.
- **Three delay variants.** `delayMinutes`, `delaySeconds`, or `delayUntil: Date` — exactly one per send, enforced by a discriminated union at compile time and by a runtime guard at the system boundary. The Go client takes a single `time.Time`.
- **Strict ack model.** The listener uses `noAck: false` and explicitly `ack`s on success or `nack(requeue=false)` on handler failure, relying on a broker-configured DLX for retries. The Go client uses goamqp's defaults.
- **Injected logger.** All logging goes through an injected `SlothLogger` (`NoOpLogger` by default). Nothing is written to `console`.

## Related

- [@opzkit/nodeamqp](https://www.npmjs.com/package/@opzkit/nodeamqp) — event streams and service request/response
- [Sloth server](https://codeberg.org/sloth-scheduler) — the delay service this client connects to

## Acknowledgements

Built on the work of [Unbound Software AB](https://gitlab.com/unboundsoftware) and [opzkit](https://github.com/opzkit). See [NOTICE](./NOTICE) for the full attribution list. Specifically:

- **[`gitlab.com/unboundsoftware/sloth`](https://gitlab.com/unboundsoftware/sloth)** — the Sloth delayed-message AMQP server (MIT). The wire protocol implemented here (`sloth.direct.exchange.request`, `sloth.headers.exchange.response`, `delay-until` / `target` headers) comes directly from the upstream Sloth `amqp` source plugin.
- **[`gitlab.com/unboundsoftware/sloth/client-amqp`](https://gitlab.com/unboundsoftware/sloth/client-amqp)** — the canonical Go client (MIT). Used as the API-shape and behavior reference; the [Compared to the Go client](#compared-to-the-go-client) section above documents intentional divergences.
- **[`github.com/opzkit/nodeamqp`](https://github.com/opzkit/nodeamqp)** — Node.js AMQP library for event streams and request/response (MIT). The `SlothSetup` composition pattern (passing setup functions to `slothConnect`) and project scaffolding (release-please, conventional commits, `amqplib` as a peer dependency) were modeled on it. The runtime code is independent.

Standards and specs this project follows: [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), [Semantic Versioning 2.0.0](https://semver.org/), [Keep a Changelog](https://keepachangelog.com/), and the [AMQP 0-9-1 protocol](https://www.rabbitmq.com/tutorials/amqp-concepts).

## License

MIT — see [LICENSE](./LICENSE).
