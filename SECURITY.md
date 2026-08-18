# Security policy

## Supported versions

Only the latest published `0.x` release receives security fixes. The package is pre-1.0 and the API may change between minor versions.

## Reporting a vulnerability

Please report security issues privately via [GitHub's private vulnerability reporting](https://github.com/rinaldolabs/sloth-amqp/security/advisories/new).

Do not file a public issue for security problems.

You will receive an acknowledgement within 7 days. Fixes are released as patch versions and noted in `CHANGELOG.md`.

Remediation targets by severity (CVSS): Critical within 24 hours, High within 7 days, Medium within 30 days, Low by the next release.

## Dependency-audit policy

The published tarball ships only `dist/` (see `files` in `package.json`) and
has **zero runtime dependencies** (`amqplib` is a peer dependency provided by
the consumer), so a consumer's `npm install` never installs this package's
`devDependencies` or its lockfile.

Two audit gates run in CI on every PR and release:

- `npm audit --omit=dev --audit-level=high` — the consumer-facing gate over
  the (empty) production tree plus the amqplib peer edge. Blocking.
- `npm audit --audit-level=critical` — the full tree, including the dev
  toolchain that executes in CI. Blocking at critical; high/moderate dev-tree
  advisories are fixed via Renovate vulnerability alerts (immediate, no
  cooldown) rather than failing the gate.

Both are clean (0 vulnerabilities) as of 2026-08-11. If a dev-only advisory
ever has to be accepted (no fix available in-range), it gets documented here
with the chain and the clear-condition, and is re-evaluated on every Renovate
lockfile-maintenance run. `lockfile-lint` is retained because it provides
registry-host and integrity-hash validation of `package-lock.json` that
`npm ci` alone does not.
