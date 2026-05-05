# @rinaldolabs/sloth-amqp

Node.js TypeScript client for the [Sloth](https://gitlab.com/unboundsoftware/sloth) delayed-message AMQP service. Wire-compatible with Sloth `amqp:0.0.10`.

This is a thin, zero-runtime-dependency library. `amqplib` is a **peer dependency** — consumers provide it themselves.

## Commands

```bash
npm run build         # tsc → dist/
npm run test          # vitest --watch
npm run test-once     # vitest single run
npm run coverage      # vitest run --coverage (must be 100%)
npm run lint          # eslint (zero warnings)
npm run lint:fix      # eslint --fix
npm run lint:lockfile # validate package-lock.json (host/scheme/integrity)
npm run sbom          # generate sbom.json (CycloneDX)
npm run test:integration  # vitest against a real RabbitMQ via testcontainers (needs Docker)
```

Run a single test file or pattern:

```bash
npm test -- --run src/__tests__/listener.test.ts
npm test -- --run -t "publishes to the request exchange"
npm run test:integration -- --run -t "consume path"
```

## Architecture

This package implements a single messaging pattern: **delayed-message request/response over Sloth**. A caller publishes a message with a `delay-until` timestamp; Sloth holds it until the time arrives and re-delivers to the caller's response queue.

### Modules (all under `src/`)

- **`connection.ts`** — `slothConnect(url, ...setups)` opens an `amqplib.ChannelModel`, runs optional `SlothSetup` functions, returns the model. `slothClose` closes it. Caller owns the connection.
- **`sender.ts`** — `slothDelaySender(client)` returns an async `send<TData>(params)` function. Publishes to `sloth.direct.exchange.request` with routing key `delay`, headers `delay-until` (unix seconds) and `target` (`amqp://<service>/<key>`), body `JSON.stringify(data)`. Channel is opened per call and closed in `finally`.
- **`listener.ts`** — `setupDelayedMessageListener(opts)` declares the response queue, binds it to `sloth.headers.exchange.response` with the headers binding `service: <serviceName>`, registers the consumer. Returns a `SlothListenerHandle { consumerTag, close() }`. `noAck: false`; handler success → `ack`, handler failure → `nack(requeue=false)` so the broker DLX takes over.
- **`logger.ts`** — `SlothLogger` interface (info/warn/error/debug/child). `NoOpLogger` is the default. `withLogLevel(logger, level)` filters by minimum level.
- **`errors.ts`** — `errMessage(unknown)` extracts a safe string from any caught value. Used everywhere to avoid leaking stack traces.
- **`types.ts`** — public param shapes (`SendDelayMessageParams<TData>`, `SlothListenerOptions`, `SlothListenerHandle`, `SlothSetup`).
- **`utils.ts`** — protocol constants (exchange names, routing keys, default queue TTL), `SlothConfig`, and `assertSafeSlothConfig` which validates `serviceName`/`routingKey` against `[A-Za-z0-9._-]+` before they flow into AMQP routing strings.
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

Headers binding (on consume):
  service:     <config.serviceName>
```

These constants are not configurable — they're part of the wire contract with Sloth. Do not change them.

## Quality gates (must hold on every commit)

- **Coverage 100%** — statements, branches, functions, lines, `perFile`
- **ESLint 0 warnings/errors** — `npm run lint`
- **TypeScript 0 errors** — `npm run build`
- **`npm audit --omit=dev --audit-level=high` clean**
- **`npm run lint:lockfile` clean** — host=npm, scheme=https, integrity required

## Security constraints

- No hardcoded secrets — `amqpUrl` always comes from caller / env
- No stack traces in error messages or logs — use `errMessage()` from `src/errors.ts`
- No `any`, no type assertions (`as`) — only exception is test mocks casting to `never` for opaque amqplib internals
- `serviceName` and `routingKey` are validated against `[A-Za-z0-9._-]+` (`assertSafeSlothConfig`) before flowing into AMQP routing strings
- `delayMinutes` must be positive and finite
- All cleanup/error paths route through the injected `SlothLogger`, never `console`

## Dependency policy

- **Zero runtime dependencies.** Do not add anything to `dependencies`.
- `amqplib` stays in `peerDependencies` (and `devDependencies` for tests). Consumers provide their own version.
- New `devDependencies` should be justified in the PR description.
- Lock file is committed; `npm ci` in CI.
- GitHub Actions can use semver tags (e.g. `@v4.2.2`) — no need to pin to commit SHA.

## Public API surface

Anything exported from `src/index.ts` is part of the published API. Treat changes there as breaking until the package reaches 1.0:

- `slothConnect`, `slothClose`
- `slothDelaySender` — generic over payload type `<TData>`
- `setupDelayedMessageListener` — returns `SlothListenerHandle { consumerTag, close() }`
- `SlothLogger`, `NoOpLogger`, `withLogLevel`, `SlothLogLevel`
- `SlothConfig`, `assertSafeSlothConfig`, `getSlothQueueName`, `getSlothTarget`
- `slothRequestExchangeName`, `slothResponseExchangeName`, `defaultListenerQueueExpiresMs`
- Types: `SendDelayMessageParams<TData>`, `SlothListenerOptions`, `SlothListenerHandle`, `SlothSetup`

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
