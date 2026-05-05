<!--
  PR title must follow Conventional Commits 1.0.0 (feat:, fix:, chore:, docs:, etc.).
  Breaking changes: include a `BREAKING CHANGE:` footer in the description.
-->

## Summary

<!-- 1–3 bullets: what changed and why. -->

## Test plan

<!-- Bulleted checklist of how this was tested. -->

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm run lint:lockfile`
- [ ] `npm run coverage` (must remain 100%)

## Wire-protocol impact

<!--
  Tick if this PR changes anything observable on the wire (exchange names, routing keys,
  header names or types, queue naming, target URL format). If yes, link to the upstream
  Sloth server source (gitlab.com/unboundsoftware/sloth/amqp) for verification.
-->

- [ ] No wire-protocol change.
- [ ] Wire change verified against upstream Sloth server: <!-- link -->
