# @rinaldolabs/sloth-amqp

Node.js TypeScript client for the [Sloth](https://gitlab.com/unboundsoftware/sloth) delayed-message AMQP service. Wire-compatible with the Sloth [`amqp` source plugin](https://gitlab.com/unboundsoftware/sloth/amqp).

This is a thin, zero-runtime-dependency library. `amqplib` is a **peer dependency** — consumers provide it themselves.

## Commands

```bash
npm run build         # tsup → dist/{index.js,index.cjs,index.d.ts,index.d.cts}
npm run type-check    # tsc --noEmit (esbuild does not type-check)
npm run test          # vitest --watch
npm run test-once     # vitest single run
npm run coverage      # vitest run --coverage (must be 100%)
npm run lint          # eslint (zero warnings)
npm run lint:fix      # eslint --fix
npm run lint:lockfile # validate package-lock.json (host/scheme/integrity)
npm run sbom          # generate sbom.json (CycloneDX)
npm run test:integration  # vitest against a real RabbitMQ via testcontainers (needs Docker)
```

The package is dual-published. `dist/index.js` is ESM, `dist/index.cjs` is CJS, with matching `.d.ts` and `.d.cts`. Node's resolver picks the right format based on the consumer's module system. The package's own source is ESM (`"type": "module"`); tsup handles the CJS rewrite at build time.

Run a single test file or pattern:

```bash
npm test -- --run src/__tests__/listener.test.ts
npm test -- --run -t "publishes to the request exchange"
npm run test:integration -- --run -t "consume path"
```

## Architecture

This package implements a single messaging pattern: **delayed-message request/response over Sloth**. A caller publishes a message with a `delay-until` timestamp; Sloth holds it until the time arrives and re-delivers to the caller's response queue.

### Modules (all under `src/`)

- **`connection.ts`** — `slothConnect(url, ...setups)` opens an `amqplib.ChannelModel`, runs optional `SlothSetup` functions **sequentially in argument order**, returns the model. Optional first arg `SlothConnectOptions { signal?, timeoutMs?, connectionName?, clientProperties?, socketOptions? }` bounds the connect+setup phase via `AbortSignal`, sets the broker-visible `connection_name`, and passes `socketOptions` through as amqplib's second connect argument (TLS material, opt-in `recovery`; a `clientProperties` key inside it merges underneath the dedicated options). A temporary no-op `'error'` handler is parked on the connection during the setup window so a connection-level failure can't crash the process before the caller owns the connection. Foreign connect/setup failures are wrapped as `SlothConnectError` (cause chained); SlothErrors, DOMExceptions, and caller abort reasons propagate verbatim. `slothClose` closes it. Caller owns the connection (and its `'error'` handler) after return.
- **`abort.ts`** — `combineAbort` composes `signal` + `timeoutMs` via `AbortSignal.any`. `raceWithAbort` races a promise against the signal with loser-cleanup support (closes resources that resolve after abort to avoid leaks). `safeClose` helper that calls `.close()` and swallows errors. Used by `connection.ts`, `listener.ts`, and `ping.ts`.
- **`ping.ts`** — `ping(client, opts?)` opens a temporary channel, runs `checkExchange` against the Sloth request exchange, and closes. Suitable for k8s readiness/liveness probes. Accepts `signal` / `timeoutMs` / `logger`. The temp channel gets an `'error'` listener (logged `sloth.ping.channel_error` at debug) because a failed passive check makes the broker close the channel with an `'error'` emit — unhandled, that emit would tear down the shared connection or crash the process. Foreign failures are wrapped as `SlothConnectError`; abort reasons propagate verbatim.
- **`sender.ts`** — `createDelaySender(client)` returns a `DelaySender` object with an async `send<TData>(params)` method. Publishes to `sloth.direct.exchange.request` with routing key `delay` (`slothDelayRoutingKey`), headers `delay-until` (unix seconds) and `target` (`amqp://<service>/<key>`), body `JSON.stringify(data)`, message properties `persistent: true` (deliveryMode 2) + `contentType: application/json` — wire parity with goamqp's `publishMessage`, so a broker restart before Sloth consumes cannot drop the request. Caches a single `ConfirmChannel` for the factory's lifetime, asserts the exchange once on first use, and re-creates the channel transparently on broker `error`/`close` (a failed open never clobbers a newer in-flight acquire). `send` resolves only after the broker confirms the publish; a broker nack rejects the promise. `send` accepts optional `timeoutMs`/`signal` bounding the **whole** publish — channel acquire and confirm wait (rejects `SlothTimeoutError` on timeout; a timed-out publish may still have been delivered — at-least-once); an abort that fires before the publish is issued rejects without publishing; a timeout keeps the cached channel. Foreign failures (channel open, exchange assert, raw broker errors) are wrapped as `SlothPublishError` with the cause chained; abort reasons propagate verbatim.
- **`listener.ts`** — `setupDelayedMessageListener(opts)` declares the response queue, binds it to `sloth.headers.exchange.response` with the headers binding `service: <serviceName>`, sets `prefetch`, registers the consumer. Returns a `SlothListenerHandle { consumerTag, close() }` (also `AsyncDisposable`). `noAck: false`; handler success → `ack`, handler failure (rejection **or** sync throw — the handler call is contained via `Promise.resolve().then`) → `nack(requeue=false)` so the broker DLX takes over — `ack`/`nack` go through `safeAck`/`safeNack` which swallow amqplib's synchronous channel-closed throw (logs `sloth.listener.ack_failed`/`nack_failed`) so a channel blip can't crash the process. The internal connection gets `'error'`/`'close'` handlers (an unhandled connection `'error'` would crash the process — the connection is internal, so the caller can't attach one). **The listener does not reconnect**: connection close, broker channel close, and server-side consumer cancel (null delivery, logged `sloth.listener.consumer_cancelled`) each mark the consumer dead and fire the opt-in `onClosed(reason)` callback at most once (`SlothListenerClosedReason`: `'connection-closed' | 'channel-closed' | 'consumer-cancelled'`), armed only after setup succeeds and never fired for the caller's own `close()`; a throwing callback is caught and logged (`sloth.listener.on_closed_failed`). `close()` cancels the consumer, drains in-flight handlers up to `graceTimeoutMs`, then closes channel and connection each in its own try/catch (a rejecting `channel.close()` must not leak the internal TCP connection). Accepts optional `signal` / `timeoutMs` to bound the setup phase; foreign setup failures wrap as `SlothConnectError`, abort reasons propagate verbatim.
- **`logger.ts`** — `SlothLogger` interface (`info/warn/error/debug` required, `child` optional). `NoOpLogger` is the default; `consoleLogger` is a `console`-backed shim for scripts/demos. `withLogLevel(logger, level)` filters by minimum level and only exposes `child` when the wrapped logger has it; an invalid level string from a JS caller throws `SlothValidationError` instead of silently dropping all output.
- **`errors.ts`** — `errMessage(unknown)` extracts a safe string from any caught value (used everywhere to avoid leaking stack traces; guarded against values `String()` itself throws on), plus the typed error hierarchy: abstract `SlothError` (readonly `code: SlothErrorCode`) and leaf classes `SlothValidationError` / `SlothPublishError` / `SlothTimeoutError` / `SlothConnectError`. `toSlothError(error, signal, Wrap)` is the internal helper enforcing the throw contract at every boundary: SlothErrors, DOMExceptions, and the caller's own abort reason pass through verbatim, anything foreign is wrapped with the cause chained. Every throw from this package is a `SlothError`, a WHATWG `DOMException`, or the caller's abort reason verbatim. No `setPrototypeOf` needed at the ES2024 target.
- **`types.ts`** — public param shapes (`SendDelayMessageParams<TData>`, `SlothListenerOptions`, `SlothListenerHandle`, `SlothSetup`, `SlothWireEvent`/`SlothWireOutbound`/`SlothWireInbound`, `OnWireMessage`).
- **`wire.ts`** — `makeWireEmitter(onWireMessage, logger)` returns a non-throwing emitter for the opt-in wire tap; it skips building the event when no hook is set and routes a throwing hook to the logger (`sloth.wire.hook_failed`) instead of breaking publish/consume.
- **`utils.ts`** — protocol constants (exchange names, `slothDelayRoutingKey`, default queue TTL, default prefetch), `SlothConfig`, `assertSafeSlothConfig` which validates `serviceName`/`routingKey` against `[A-Za-z0-9._-]{1,200}` (the length bound keeps derived AMQP names under the protocol's 255-byte short-string limit), and `slothClientProperties` for broker-visible `connection_name`.
- **`index.ts`** — public-API barrel; excluded from coverage.
- **`__tests__/`** — co-located vitest specs (one per module).

Integration tests live under `test/integration/` and run against a real RabbitMQ container via testcontainers — see `npm run test:integration`. They are excluded from the unit-coverage gate.

## Sloth wire protocol

```
Request exchange:   sloth.direct.exchange.request   (direct, durable)
Response exchange:  sloth.headers.exchange.response (headers, durable)
Routing key in:     delay
Routing key out:    <config.routingKey>
Service name:       <config.serviceName>
Response queue:     sloth.headers.exchange.response.queue.<config.serviceName>

Headers (on publish):
  delay-until: <int64 unix seconds>
  target:      amqp://<config.serviceName>/<config.routingKey>

Message properties (on publish):
  deliveryMode: 2 (persistent)      — parity with goamqp publishMessage
  contentType:  application/json

Headers binding (on consume):
  service:     <config.serviceName>
```

These constants are not configurable — they're part of the wire contract with Sloth. Do not change them.

## Quality gates (must hold on every commit)

- **Coverage 100%** — statements, branches, functions, lines, `perFile`
- **ESLint 0 warnings/errors** — `npm run lint`
- **TypeScript 0 errors** — `npm run type-check`
- **Build clean** — `npm run build` (tsup emits ESM + CJS + types)
- **`npm audit --omit=dev --audit-level=high` clean**
- **`npm run lint:lockfile` clean** — host=npm, scheme=https, integrity required

## Security constraints

- No hardcoded secrets — `amqpUrl` always comes from caller / env
- No stack traces in error messages or logs — use `errMessage()` from `src/errors.ts`
- No `any`, no type assertions (`as`) — only exception is test mocks casting to `never` for opaque amqplib internals
- `serviceName` and `routingKey` are validated against `[A-Za-z0-9._-]{1,200}` (`assertSafeSlothConfig`) before flowing into AMQP routing strings
- Exactly one of `delayMinutes` / `delaySeconds` / `delayUntil` must be provided per send. `delayMinutes` and `delaySeconds` must be positive and finite; `delayUntil` must be a valid `Date`. All variants are capped at `MAX_DELAY_SECONDS` (~100 years) to prevent unix-timestamp overflow
- `logLabel` is sanitized via `sanitizeLabel` (strips ASCII controls, DEL + C1 controls incl. NEL/CSI, U+2028/U+2029, bidi embeddings/overrides/isolates; truncated to 200 grapheme clusters with a 400-code-unit hard cap) before being written to log lines
- `data` is JSON-serialized once via `serializeData` before the channel opens; non-serializable values throw before any AMQP work
- All cleanup/error paths route through the injected `SlothLogger`, never `console`. The one sanctioned `console.*` in `src/` is the exported `consoleLogger` shim (`src/logger.ts`) — an explicit opt-in for scripts/demos, never the default and never used internally

## Dependency policy

- **Zero runtime dependencies.** Do not add anything to `dependencies`.
- `amqplib` stays in `peerDependencies` (and `devDependencies` for tests). Consumers provide their own version.
- New `devDependencies` should be justified in the PR description.
- Lock file is committed; `npm ci` in CI.
- GitHub Actions can use semver tags (e.g. `@v4.2.2`) — no need to pin to commit SHA.

## Public API surface

Anything exported from `src/index.ts` is part of the published API. Treat changes there as breaking until the package reaches 1.0:

- `slothConnect`, `slothClose` — `slothConnect` accepts optional `SlothConnectOptions { signal?, timeoutMs?, connectionName?, clientProperties?, socketOptions? }`
- `createDelaySender` — returns a `DelaySender { send<TData>(params): Promise<void> }`
- `setupDelayedMessageListener` — returns `SlothListenerHandle { consumerTag, close() }`. Accepts optional `signal` / `timeoutMs` / `onClosed` on `SlothListenerOptions`.
- `ping(client, opts?)` — health-check helper for k8s readiness probes
- `MAX_DELAY_SECONDS`, `resolveDelaySeconds`, `sanitizeLabel`, `serializeData` — pure helpers exposed for callers that want to validate input ahead of `send`
- `DelaySender` — interface returned by `createDelaySender`
- `NoOpLogger`, `consoleLogger`, `withLogLevel`
- `SlothError`, `SlothValidationError`, `SlothPublishError`, `SlothTimeoutError`, `SlothConnectError` (+ `SlothErrorCode` type) — typed error hierarchy; throw contract, breaking to change post-1.0
- `SlothConfig`, `assertSafeSlothConfig`, `getSlothQueueName`, `getSlothTarget`, `slothClientProperties`
- `slothRequestExchangeName`, `slothResponseExchangeName`, `slothDelayRoutingKey`, `defaultListenerQueueExpiresMs`, `defaultListenerPrefetch`, `defaultListenerGraceTimeoutMs`
- Types: `SlothLogger`, `SlothLogLevel`, `DelaySpec`, `SendDelayMessageParams<TData>`, `SlothListenerOptions`, `SlothListenerHandle`, `SlothListenerClosedReason`, `SlothSetup`, `SlothConnectOptions`, `PingOptions`, `OnWireMessage`, `SlothWireEvent`, `SlothWireInbound`, `SlothWireOutbound`

### Stable log event names

Logger calls emit an object-first second arg with a stable `event` string. The catalogue lives in README under "Log events" and is part of the public contract — renames are breaking changes. Sender events are prefixed `sloth.publish.*`, listener events `sloth.listener.*`, ping events `sloth.ping.*`, wire-tap failures `sloth.wire.*`.

## Resource hygiene

Before running tests/builds in this repo, check for stray runners:

```bash
pgrep -a vitest
```

Don't spawn a new test run while another is still going.

## Conventional commits

Repo uses [release-please](https://github.com/googleapis/release-please) on `main` to drive releases. Commit subjects must follow Conventional Commits:

- `feat:` — new functionality (minor bump)
- `fix:` — bug fix (patch bump)
- `refactor:`, `chore:`, `docs:`, `test:`, `ci:` — no version bump
- `feat!:` / `fix!:` / `BREAKING CHANGE:` footer — major bump (pre-1.0: minor bump)

Use `/commit` for a guided flow.
