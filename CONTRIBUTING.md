# Contributing

Solo-maintained, but worked like a team repo: the history is part of what this
project is judged on, so `branch → commit → pull request → CI → merge` is the
default path, not an exception.

## Prerequisites

- **Node.js 22** (CI runs on 22; `server/package.json` and `client/package.json`
  have no `engines` pin yet, so this is by convention).
- **MongoDB** — local `mongod` or a free Atlas cluster. Only needed to *run* the
  app; the test suites stub the database and need neither Mongo nor a `.env`.
- Local setup (env files, installing, running) lives in the [README](README.md).
  Don't duplicate it here.

## The workflow

One task, one branch, one pull request. `main` is always green.

```bash
git switch main && git pull
git switch -c feat/screen-sharing      # see branch naming below
# ...work, commit as you go...
git push -u origin feat/screen-sharing
gh pr create --fill                     # or open the PR in the GitHub UI
```

The PR template will prompt for what changed, how it was verified, and a
checklist. CI (`.github/workflows/ci.yml`) runs lint + tests for the server and
lint + build for the client; it must be green before merging.

> A GitHub remote isn't configured yet, so the push/PR steps only work once it
> is (see `NEXT-MILESTONE.md`, P0.5). Until then it's fine to commit straight to
> `main` — but once the remote exists, everything goes through a PR.

**Merge with "Squash and merge"** for a single-commit-per-task history, taking
the PR title as the commit subject — which is why the subject convention below
is worth respecting, since it ends up in the permanent log.

Rules that matter:

- **Keep it one logical change.** If a branch doesn't fit in about a day's work,
  split it.
- **Rebase on `main`** rather than merging `main` in, so the history stays
  linear and reviewable.
- **Never commit `.env`, secrets, or `node_modules`.** `.env` is already ignored;
  keep the real values only in `.env.example`-shaped form.
- **Solo means you review your own PR.** Read the diff in the PR view before
  merging — that pass is where self-review actually catches things, and it's
  what an evaluator sees.

## Branch naming

`<type>/<short-kebab-description>`, where the type matches the commit types:

| Prefix | For | Example |
|---|---|---|
| `feat/` | user-visible functionality | `feat/screen-sharing` |
| `fix/` | bug fixes | `fix/room-code-confusables` |
| `test/` | tests only | `test/socket-relay-scoping` |
| `docs/` | README, CONTRIBUTING, comments | `docs/deployment-guide` |
| `ci/` | workflows and tooling config | `ci/prettier-check` |
| `refactor/` | no behaviour change | `refactor/split-meeting-room` |
| `chore/` | dependencies, housekeeping | `chore/bump-express` |

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>): <subject>

Why this change is needed — the diff already shows what changed.

Refs: #12
```

- **Subject**: imperative mood, lowercase, no trailing period, ≤ 72 characters.
- **Body**: explain *why*. If the diff makes the change obvious, a short body is
  fine — but a bug fix should say what the wrong behaviour was.
- **Footer**: `Refs: #12`, `Co-authored-by:`, or `BREAKING CHANGE:` when
  downstream work is needed.

| Type | Use for |
|---|---|
| `feat` | new user-visible behaviour |
| `fix` | bug fix |
| `test` | adding or fixing tests |
| `docs` | documentation only |
| `ci` | pipeline and tooling config |
| `refactor` | internal change, no behaviour change |
| `perf` | performance |
| `chore` | dependencies, housekeeping |

Good and bad, concretely:

- ✅ `fix: keep ICE candidates that arrive before the remote description`
- ✅ `feat: let the host remove a participant from a live meeting`
- ❌ `update`, `fixes`, `WIP`, `final changes` — a future reader (or a rebase)
  learns nothing
- ❌ `fix: change line 42 of MeetingRoom.jsx` — describes the edit, not the intent

To get the structure in your editor, opt in to the template (this is a local git
config change, so it's your call to make):

```bash
git config commit.template .gitmessage
```

## Before you push

Run exactly what CI runs:

```bash
cd server && npm run lint && npm test        # npm run test:coverage for the report
cd ../client && npm run lint && npm run build
```

Two things that trip people up:

- The server suites boot the **real** `src/index.js` with the Mongoose models
  swapped out, so they need no MongoDB. If a route starts using a query the
  stub doesn't implement, add it to `server/test/helpers/fake-db.js`.
- The suites must pass with **no `.env` present**. If a test needs a new
  environment variable, set it in `server/test/helpers/app.js` rather than
  relying on your local file — otherwise CI fails and local runs don't.

## Tests

- **Server**: Node's built-in `node:test` runner, files under `server/test/`.
  A new route belongs in the suite that matches its concern
  (`auth`, `meeting-access`, `moderation`); a new socket event needs a socket
  suite (not written yet).
- **Coverage** is around 82% of lines via `npm run test:coverage`. Don't let it
  drop: new behaviour should come with a test, or the PR should say why it can't.
- **Client**: no test runner yet — `client/src/lib/webrtc.js` (the pure
  ICE-queue and config logic) is the first thing worth covering.

## Documentation expectations

- New environment variable → add it to the matching `.env.example` **and** the
  README setup section.
- New endpoint → document it in the README, following the host-controls section.
- New user-visible feature → update the README feature table, including what is
  deliberately *not* done yet.
