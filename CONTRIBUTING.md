# Contributing to `@rinaldolabs/sloth-amqp`

Thanks for your interest in improving this package. It's a thin, zero-runtime-dependency
client for the [Sloth](https://gitlab.com/unboundsoftware/sloth) delayed-message AMQP
service, and it holds a deliberately small, well-tested surface. The bar for changes is
high; this guide explains how to clear it.

## Prerequisites

- Node.js `^24.17.0` and npm `^11.17.0` (see `engines` in `package.json`; an `.nvmrc` is provided)
- [Docker](https://www.docker.com/) — only needed to run the integration tests
- Install dependencies with `npm ci` (reproducible from the committed lock file)

## Quality gates (all must pass)

These are enforced in CI and must be green before a PR is merged. Run them locally first:

```bash
npm run lint          # ESLint — zero warnings/errors
npm run type-check    # tsc --noEmit — zero errors
npm run coverage      # vitest --coverage — must be 100% (statements/branches/functions/lines, perFile)
npm run build         # tsup — emits dist/{index.js,index.cjs,index.d.ts,index.d.cts}
npm run lint:packaging # publint + are-the-types-wrong (node16 profile)
npm run lint:lockfile # lockfile-lint — host=npm, scheme=https, integrity required
npm run size          # size-limit — bundle stays within budget
npm audit --omit=dev --audit-level=high  # consumer-facing audit must be clean
```

**Coverage is 100%, `perFile`.** Every new branch needs a test. There is no exception —
if a line is hard to cover, that usually means it should be refactored, not exempted.

### Tests

```bash
npm test                  # watch mode (unit tests)
npm run test-once         # single unit-test run
npm test -- --run -t "publishes to the request exchange"   # single test by name
npm run test:integration  # wire-protocol tests against a real RabbitMQ (needs Docker)
```

Unit tests mock `amqplib`. The integration suite (`test/integration/`) stands up a real
RabbitMQ container via testcontainers and asserts the on-the-wire format; it runs in its
own CI job and is excluded from the unit-coverage gate.

## Constraints that are non-negotiable

- **Zero runtime dependencies.** Nothing goes in `dependencies`. `amqplib` stays a peer
  dependency. New `devDependencies` must be justified in the PR.
- **Wire protocol is fixed.** Exchange names, routing keys, header names/types, and the
  queue-name pattern are the contract with Sloth (see `src/utils.ts` and the README "Sloth
  wire protocol" section). Do not change them.
- **No `any`, no type assertions** in production code (the only sanctioned exception is test
  mocks casting opaque amqplib internals to `never`).
- **No `console.*` in `src/`** except the documented `consoleLogger` opt-in shim. All
  library logging goes through the injected `SlothLogger`, and all error strings through
  `errMessage()` (`src/errors.ts`) — never raw `String(error)` or `error.stack`.
- **Public API and log-event names are a contract.** Anything exported from `src/index.ts`,
  and every `event:` string, is documented in the README; renames are breaking changes.

## Commits and releases

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) and
[release-please](https://github.com/googleapis/release-please) on `main`. The commit type
drives the version bump:

- `feat:` — new functionality (minor)
- `fix:` / `deps:` — bug or dependency fix (patch)
- `docs:`, `refactor:`, `chore:`, `test:`, `ci:` — no release
- `feat!:` / `fix!:` / a `BREAKING CHANGE:` footer — breaking (pre-1.0: treated as minor)

commitlint validates PR titles and commit messages. A guided flow is available via the
`/commit` skill.

### First-publish checklist

The package publishes to npm with [Sigstore provenance](https://docs.npmjs.com/generating-provenance-statements) (`provenance: true` in `publishConfig`). On the **first** release, confirm `npm publish --provenance` actually succeeds — provenance requires `repository.url` in `package.json` to match the build's source URI, and a `git+https://…` vs HTTPS mismatch can fail the publish with a 422. After publishing, verify with `npm audit signatures`.

## Pull requests

1. Branch off `main` (`<type>/<short-description>`).
2. Make the change with tests; keep coverage at 100%.
3. Run the full gate set above.
4. Open a PR; fill in the template. CI must be green (including the integration job when
   `src/` changes).

## Reporting security issues

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
