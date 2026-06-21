# Security policy

## Supported versions

Only the latest published `0.x` release receives security fixes. The package is pre-1.0 and the API may change between minor versions.

## Reporting a vulnerability

Please report security issues privately via [GitHub's private vulnerability reporting](https://github.com/rinaldolabs/sloth-amqp/security/advisories/new).

Do not file a public issue for security problems.

You will receive an acknowledgement within 7 days. Fixes are released as patch versions and noted in `CHANGELOG.md`.

Remediation targets by severity (CVSS): Critical within 24 hours, High within 7 days, Medium within 30 days, Low by the next release.

## Known dev-only advisories

`npm audit` (run without `--omit=dev`) reports advisories that live entirely in
the build/test toolchain. They do **not** affect consumers: the published
tarball ships only `dist/` (see `files` in `package.json`) and has **zero
runtime dependencies** (`amqplib` is a peer dependency provided by the
consumer). A consumer's `npm install` never installs this package's
`devDependencies` or its lockfile, so none of the chains below reach an
installed application.

The consumer-facing gate is `npm audit --omit=dev --audit-level=high`, which is
enforced in CI and is clean (0 vulnerabilities).

| Advisory | Severity | Chain | Status |
| -------- | -------- | ----- | ------ |
| [GHSA-h67p-54hq-rp68](https://github.com/advisories/GHSA-h67p-54hq-rp68) (js-yaml quadratic-complexity DoS) | moderate | `lockfile-lint → lockfile-lint-api → @yarnpkg/parsers → js-yaml@3.x` | Accepted. The fix is js-yaml 4.2.0, but `@yarnpkg/parsers@3.x` pins `js-yaml@^3` and calls `safeLoad`, which was removed in js-yaml 4 — an `overrides` bump would break the linter at runtime. Dev/CI-only; the YAML parsed is our own `package-lock.json`, not untrusted input. Will clear when `@yarnpkg/parsers` adopts js-yaml ≥ 4.2.0. |
| [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) (esbuild dev-server arbitrary file read, Windows) | low | `tsup → esbuild@0.27.x` | Accepted. The vulnerability is exclusively esbuild's dev server (`esbuild serve`), which this package never invokes — esbuild is used only for one-shot bundling via tsup. Fixed in esbuild 0.28.1; will clear when tsup floats its esbuild dependency past the advisory range. |

We re-evaluate these on every Renovate lockfile-maintenance run. `lockfile-lint`
is retained (not removed) because it provides registry-host and integrity-hash
validation of `package-lock.json` that `npm ci` alone does not.
