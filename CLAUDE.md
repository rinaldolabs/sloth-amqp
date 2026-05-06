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

- **`connection.ts`** — `slothConnect(url, ...setups)` opens an `amqplib.ChannelModel`, runs optional `SlothSetup` functions, returns the model. Optional first arg `SlothConnectOptions { signal?, timeoutMs? }` bounds the connect+setup phase via `AbortSignal`. `slothClose` closes it. Caller owns the connection.
- **`abort.ts`** — `combineAbort` composes `signal` + `timeoutMs` via `AbortSignal.any`. `raceWithAbort` races a promise against the signal with loser-cleanup support (closes resources that resolve after abort to avoid leaks). `safeClose` helper that calls `.close()` and swallows errors. Used by both `connection.ts` and `listener.ts`.
- **`sender.ts`** — `createDelaySender(client)` returns a `DelaySender` object with an async `send<TData>(params)` method. Publishes to `sloth.direct.exchange.request` with routing key `delay`, headers `delay-until` (unix seconds) and `target` (`amqp://<service>/<key>`), body `JSON.stringify(data)`. Caches a single `ConfirmChannel` for the factory's lifetime, asserts the exchange once on first use, and re-creates the channel transparently on broker `error`/`close`. `send` resolves only after the broker confirms the publish; a broker nack rejects the promise.
- **`listener.ts`** — `setupDelayedMessageListener(opts)` declares the response queue, binds it to `sloth.headers.exchange.response` with the headers binding `service: <serviceName>`, registers the consumer. Returns a `SlothListenerHandle { consumerTag, close() }`. `noAck: false`; handler success → `ack`, handler failure → `nack(requeue=false)` so the broker DLX takes over. Accepts optional `signal` / `timeoutMs` to bound the setup phase.
- **`logger.ts`** — `SlothLogger` interface (`info/warn/error/debug` required, `child` optional). `NoOpLogger` is the default; `consoleLogger` is a `console`-backed shim for scripts/demos. `withLogLevel(logger, level)` filters by minimum level and only exposes `child` when the wrapped logger has it.
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
- **TypeScript 0 errors** — `npm run type-check`
- **Build clean** — `npm run build` (tsup emits ESM + CJS + types)
- **`npm audit --omit=dev --audit-level=high` clean**
- **`npm run lint:lockfile` clean** — host=npm, scheme=https, integrity required

## Security constraints

- No hardcoded secrets — `amqpUrl` always comes from caller / env
- No stack traces in error messages or logs — use `errMessage()` from `src/errors.ts`
- No `any`, no type assertions (`as`) — only exception is test mocks casting to `never` for opaque amqplib internals
- `serviceName` and `routingKey` are validated against `[A-Za-z0-9._-]+` (`assertSafeSlothConfig`) before flowing into AMQP routing strings
- Exactly one of `delayMinutes` / `delaySeconds` / `delayUntil` must be provided per send. `delayMinutes` and `delaySeconds` must be positive and finite; `delayUntil` must be a valid `Date`. All variants are capped at `MAX_DELAY_SECONDS` (~100 years) to prevent unix-timestamp overflow
- `logLabel` is sanitized via `sanitizeLabel` (strips ASCII controls, NEL, U+2028, U+2029; truncated to 200 grapheme clusters) before being written to log lines
- `data` is JSON-serialized once via `serializeData` before the channel opens; non-serializable values throw before any AMQP work
- All cleanup/error paths route through the injected `SlothLogger`, never `console`

## Dependency policy

- **Zero runtime dependencies.** Do not add anything to `dependencies`.
- `amqplib` stays in `peerDependencies` (and `devDependencies` for tests). Consumers provide their own version.
- New `devDependencies` should be justified in the PR description.
- Lock file is committed; `npm ci` in CI.
- GitHub Actions can use semver tags (e.g. `@v4.2.2`) — no need to pin to commit SHA.

## Public API surface

Anything exported from `src/index.ts` is part of the published API. Treat changes there as breaking until the package reaches 1.0:

- `slothConnect`, `slothClose` — `slothConnect` accepts optional `SlothConnectOptions { signal?, timeoutMs? }`
- `createDelaySender` — returns a `DelaySender { send<TData>(params): Promise<void> }`
- `setupDelayedMessageListener` — returns `SlothListenerHandle { consumerTag, close() }`
- `MAX_DELAY_SECONDS`, `resolveDelaySeconds`, `sanitizeLabel`, `serializeData` — pure helpers exposed for callers that want to validate input ahead of `send`
- `DelaySender` — interface returned by `createDelaySender`
- `NoOpLogger`, `consoleLogger`, `withLogLevel`
- `SlothConfig`, `assertSafeSlothConfig`, `getSlothQueueName`, `getSlothTarget`
- `slothRequestExchangeName`, `slothResponseExchangeName`, `defaultListenerQueueExpiresMs`
- Types: `SlothLogger`, `SlothLogLevel`, `DelaySpec`, `SendDelayMessageParams<TData>`, `SlothListenerOptions`, `SlothListenerHandle`, `SlothSetup`

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
