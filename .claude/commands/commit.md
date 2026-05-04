---
description: Run quality gates, scan for leaks, and create a Conventional Commit
---

You are creating a commit for the @rinaldolabs/sloth-amqp repo. Follow these steps in order. Stop and report to the user if any step fails — do **not** auto-fix, do **not** force.

## 1. Pre-flight checks

Run these in parallel (single message, multiple Bash calls):

```bash
git status --short
git diff --cached --stat
git diff --stat
git log --oneline -5
```

If nothing is staged, ask the user whether to stage everything (`git add -A`) or stage specific files. Never `git add -A` without asking.

## 2. Quality gates (must all pass)

Run in parallel:

```bash
npm run lint
npm run build
npm run test-once
```

Then sequentially (these depend on lock file integrity, not on each other):

```bash
npm run lint:lockfile
npm audit --omit=dev --audit-level=high
```

If any gate fails, stop and report the failure. Do **not** commit.

## 3. Secret / leak scan on the staged diff

```bash
git diff --cached
```

Reject the commit if the diff contains:

- `console.log` / `console.error` / `console.debug` (in `src/`, not in tests)
- Hardcoded URLs starting with `amqp://` or `amqps://` other than placeholders/test fixtures
- Anything that looks like a token, password, API key, or `.env` line
- Stack traces or raw `Error` objects passed to logger calls instead of `errMessage(...)`
- New runtime entries in `dependencies` (peer deps and devDeps are fine)
- TODO / FIXME / XXX comments

If anything matches, stop and surface it to the user.

## 4. Draft the commit message

Use Conventional Commits. Pick the type from the diff:

- `feat:` — new exported symbol or behavior
- `fix:` — bug fix in existing behavior
- `refactor:` — internal change, no API surface change
- `test:` — only test files touched
- `docs:` — only docs / README / CLAUDE.md
- `ci:` — only `.github/workflows/**` or CI scripts
- `chore:` — config, deps, tooling
- Append `!` and a `BREAKING CHANGE:` footer when the public API in `src/index.ts` changes incompatibly

Subject line ≤ 70 chars, imperative mood. Body explains _why_, not _what_. Reference protocol/spec sections by name, not line numbers (line numbers rot).

## 5. Commit

Use HEREDOC to preserve formatting:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <subject>

<body explaining why; wrap at 72>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then run `git status` to confirm. Do **not** push unless the user asks.
