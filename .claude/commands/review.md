---
description: Review the current branch (or staged diff) against project quality and protocol rules
---

You are reviewing changes in @rinaldolabs/sloth-amqp. The goal is to enforce the rules in `CLAUDE.md`, not generic taste. Be specific and cite file:line.

## 1. Determine review scope

Run in parallel:

```bash
git rev-parse --abbrev-ref HEAD
git diff main...HEAD --stat
git diff main...HEAD
git status --short
```

If on `main`, review the staged diff (`git diff --cached`) instead. If both are empty, tell the user there's nothing to review.

## 2. Run quality gates (read-only)

In parallel:

```bash
npm run lint
npm run build
npm run coverage
```

Coverage **must** be 100% perFile. Anything below is a blocker. Lint and build must produce zero warnings/errors. Capture the numbers in the review output.

Also:

```bash
npm run lint:lockfile
npm audit --omit=dev --audit-level=high
```

## 3. Diff review checklist

Walk the diff and flag anything matching these categories. Group findings by severity (Blocker / High / Medium / Low / Nit).

### Public API surface

- Any change to `src/index.ts` exports — confirm the commit type uses `feat:` / `feat!:` and (for breaking changes) includes a `BREAKING CHANGE:` footer
- Any change to `SlothListenerHandle`, `SendDelayMessageParams`, `SlothListenerOptions`, `SlothConfig` shape
- Any new exported symbol — should be intentional, named consistently, and documented in CLAUDE.md's "Public API surface" list

### Protocol conformance

- Exchange names, routing keys, queue name pattern, header names — must match the spec in CLAUDE.md exactly
- `delay-until` must be unix **seconds**, not milliseconds
- `target` header format `amqp://{serviceName}/{routingKey}/`
- Listener: `noAck: false` only — manual ack/nack required
- Sender: `delayMinutes` must be validated with `Number.isFinite` and `> 0`

### Type safety

- No `any`
- No `as` assertions in production code (test mock casts to `never` are the only allowed exception)
- No non-null assertions (`!.`) on values that aren't proven non-null

### Logging and errors

- All error paths use `errMessage()` from `src/errors.ts` — never raw `String(error)` and never `error.stack` in log lines
- All cleanup paths use the injected `SlothLogger` — never `console.*` in `src/`
- No PII or secrets in log strings

### Validation at boundaries

- Public functions validate their inputs (`amqpUrl` non-empty, `delayMinutes` finite/positive, config via `assertSafeSlothConfig`, `queueExpiresMs` finite/positive)

### Dependency hygiene

- No new entries in `"dependencies"` (this is a zero-runtime-dep library)
- New `devDependencies` should be justified
- `package-lock.json` updated alongside `package.json`

### Tests

- Every new branch covered by a test (perFile coverage stays at 100%)
- Listener tests assert on `noAck: false`, ack on success, nack on failure
- Sender tests cover `NaN`, `Infinity`, `0`, and negative `delayMinutes`
- Validation helpers have tests for both accept and reject cases
- No flaky timing — tests use `vi.useFakeTimers` or `setImmediate` flushes, not real `setTimeout`

### CI / release workflows

- Changes to `.github/workflows/` keep the gate set: `[lint, build, coverage, security]`
- Release pipeline still runs lint + lockfile-lint + coverage before `npm publish`

## 4. Report

Format:

```
## Quality gates
- ESLint: <pass/fail, count>
- tsc:    <pass/fail>
- Tests:  <N passed / N>
- Coverage: <stmt/branch/func/line %, perFile>
- Lockfile: <pass/fail>
- Audit:  <pass/fail>

## Findings
### Blocker
- file:line — issue + what to do

### High / Medium / Low / Nit
- ...

## Summary
<one paragraph: ship / fix-then-ship / redesign>
```

Be terse. Cite file:line. Don't restate code that's in the diff.
