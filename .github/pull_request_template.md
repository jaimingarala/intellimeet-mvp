## What and why

<!-- The problem this solves, and why now. Link the issue if one exists. -->

## Type of change

- [ ] `feat` — new user-visible behaviour
- [ ] `fix` — bug fix
- [ ] `test` — tests only
- [ ] `docs` — documentation
- [ ] `ci` / `chore` — tooling, dependencies, housekeeping
- [ ] `refactor` — no behaviour change

## How this was verified

<!-- Paste the commands you ran and what they printed. "It works" is not
     evidence; a failing-then-passing test or a screenshot is. -->

```bash
cd server && npm run lint && npm test
cd ../client && npm run lint && npm run build
```

- [ ] Server suites pass (`npm test`) — _N tests_
- [ ] Client builds
- [ ] Manually exercised in a browser — say how (two tabs? two devices?)

## Screenshots

<!-- For UI changes: before and after. Delete this section if it doesn't apply. -->

## Checklist

- [ ] One logical change; `main` stays green
- [ ] New behaviour has a test, or this PR explains why it can't
- [ ] No secrets, `.env` files, or build output committed
- [ ] New environment variables added to the relevant `.env.example` and the README
- [ ] README / NEXT-MILESTONE.md updated if this changes the documented state
- [ ] Commit subjects follow the convention in [CONTRIBUTING.md](../CONTRIBUTING.md)

## Breaking changes and follow-ups

<!-- Work deliberately left out, or downstream things that need changing.
     If a follow-up matters, add it to NEXT-MILESTONE.md rather than leaving it
     only in this box. -->
