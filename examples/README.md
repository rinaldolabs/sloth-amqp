# Examples

Runnable examples for `@emilri/sloth-amqp`. They import from the local `src/` so you can run them from a checkout without installing the package.

## Prerequisites

- Node 24 (type stripping enabled by default).
- A reachable Sloth + RabbitMQ instance.

## Run

```sh
AMQP_URL=amqp://guest:guest@localhost:5672/ node --experimental-strip-types examples/listener.ts
# in another shell:
AMQP_URL=amqp://guest:guest@localhost:5672/ node --experimental-strip-types examples/sender.ts
```

The listener stays running and prints each delivered payload. The sender publishes one message scheduled one minute out and exits.

In your own project, replace `'../src/index.ts'` with `'@emilri/sloth-amqp'`.
