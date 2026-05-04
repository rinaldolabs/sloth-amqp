# @emilri/sloth-amqp

Node.js TypeScript client for the [Sloth](https://gitlab.com/unboundsoftware/sloth) delayed-message AMQP service.
Wire-compatible with Sloth `amqp:0.0.10`.

## Commands

```bash
npm run build         # tsc → dist/
npm run test-once     # vitest (single run, no watch)
npm run coverage      # vitest + v8 coverage — must be 100%
npm run lint          # eslint (zero warnings policy)
npm run lint:lockfile # verify package-lock.json integrity
npm run sbom          # generate sbom.json (CycloneDX)
```

## Architecture

```
src/
  logger.ts      — SlothLogger interface + NoOpLogger
  types.ts       — SendDelayMessageParams, SlothListenerOptions, SlothSetup
  utils.ts       — Protocol constants (exchange names, routing keys, service names)
  connection.ts  — slothConnect(url, ...opts), slothClose
  sender.ts      — slothDelaySender(client) → async send function
  listener.ts    — setupDelayedMessageListener, cleanup
  index.ts       — public API barrel (excluded from coverage)
  __tests__/     — all tests co-located here
```

## Protocol (Sloth AMQP wire format)

```
Request exchange:   sloth.direct.exchange.request   (direct, durable)
Response exchange:  sloth.headers.exchange.response  (headers, durable)
Routing key in:     delay
Routing key out:    <config.routingKey>
Service name:       <config.serviceName>
Response queue:     sloth.headers.exchange.response.queue.<config.serviceName>

Headers (on publish):
  delay-until: <int64 unix seconds>
  target:      amqp://<config.serviceName>/<config.routingKey>/
```

## Quality gates

- Coverage **must be 100%** (statements/branches/functions/lines, perFile)
- Zero ESLint warnings or errors — run `npm run lint` before committing
- Zero TypeScript errors — `npm run build` must be clean
- `npm audit --omit=dev --audit-level=high` must be clean

## Security checklist

- [ ] No `any`, no type assertions (`as`)
- [ ] No hardcoded secrets — `AMQP_URL` always from env vars
- [ ] No stack traces exposed in error messages
- [ ] Input validated: `amqpUrl` non-empty, `delayMinutes > 0`
- [ ] GitHub Actions pinned to SHA (supply chain protection)
- [ ] Lock file committed, `npm ci` in CI

## Dependencies

`amqplib` is a **peer dependency** — consuming projects provide it themselves (same as `@opzkit/nodeamqp` pattern). It is also in `devDependencies` for running tests in this repo.

Do NOT add runtime `dependencies` without approval. This is a zero-dependency library at runtime.
