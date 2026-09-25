# Contributing

Solo-maintained, but worked like a team repo: the history is part of what this
project is judged on, so `branch → commit → pull request → CI → merge` is the
default path, not an exception.

## Prerequisites

- **Node.js 22** (CI runs on 22; `server/package.json` and `client/package.json`
  have no `engines` pin yet, so this is by convention).
- **MongoDB** — local `mongod` or a free Atlas cluster. Only needed to *run* the
  app; the test suites stub the database and need neither Mongo nor a `.env`.
- **Docker** (optional) — `npm run turn:up` runs a local coturn relay so the
  TURN path can be tested without an account. Nothing else needs it.
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
checklist. CI (`.github/workflows/ci.yml`) runs lint, tests and a coverage floor
for both packages, a Prettier check over the whole repo, and the client build; it
must be green before merging.

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
npm ci                                       # once, from the repository root
npm run format:check                         # Prettier, over the whole repo
cd server && npm run lint && npm run test:coverage
cd ../client && npm run lint && npm run test:coverage && npm run build
cd .. && npm run test:scripts                # STUN codec
```

`test:coverage` is `npm test` plus the report, and it exits non-zero below a
floor (85% lines / 70% branches on the server, 95% / 90% on the client), so the
figure CI prints is enforced rather than decorative. Everything here is also
available from the root: `npm run lint`, `npm run test`, `npm run format`,
`npm run build`.

Every test job `tee`s its output and then publishes a summary of it — test count,
failures by name, and coverage next to the floor that enforces it — to the run
page. GitHub serves job *logs* only to an authenticated request, so this is how
the numbers are readable by anyone with the link, and it is written even when the
job is red, which is when you want it. To render the same block locally:

```bash
npm --prefix client run test:coverage > /tmp/client.log 2>&1
node scripts/ci-summary.mjs client /tmp/client.log
```

The first argument is `server`, `client` or `scripts` — whichever job's output you
captured. Vitest still colours that log even when it is a file, which is why the
script strips ANSI escapes before parsing; a full log that has no summary line in
it says so instead of reporting zero tests.

Two things that trip people up:

- The server suites boot the **real** `src/index.js` with the Mongoose models
  swapped out, so they need no MongoDB. If a route starts using a query the
  stub doesn't implement, add it to `server/test/helpers/fake-db.js`.
- The suites must pass with **no `.env` present**. If a test needs a new
  environment variable, set it in `server/test/helpers/app.js` rather than
  relying on your local file — otherwise CI fails and local runs don't.

## Tests

- **Server**: Node's built-in `node:test` runner, files under `server/test/`.
  Fifteen suites today — `admin`, `auth`, `capacity`, `claim`, `deployment`,
  `email-verification`, `guest`, `guest-retention`, `hardening`, `indexes`,
  `meeting-access`, `moderation`, `observability`, `socket` and
  `socket-payloads` — plus three shared helpers. A new route belongs in the suite
  that matches its concern; a new socket event belongs in `socket.test.js`
  (protocol) or `socket-payloads.test.js` (what a client is allowed to send).

  `email-verification` follows the real flow — it reads the one-time link out of
  the mailer's in-memory outbox and spends it over HTTP — rather than setting the
  flag on the model, so the token plumbing is covered too. Suites that claim an
  account must expect `emailVerified: false` unless they turn
  `EMAIL_VERIFICATION_REQUIRED` off themselves.
- **Coverage** is around 92% of lines and 86% of branches via
  `npm run test:coverage`. Don't let it drop: new behaviour should come with a
  test, or the PR should say why it can't.
- **Client**: Vitest, scoped to `src/lib` — `webrtc.js` (the ICE-queue and ICE
  server config, which is where a call silently fails to connect) and the caps
  that mirror the server's. React components are not unit-tested: a renderer with
  a mocked socket would mostly assert that React works, and the demo path is
  rehearsed in a browser instead. `npm test` in `client/` runs it; the setup file
  supplies the two WebRTC globals Node doesn't have.
- **Scripts**: `node:test` again, under `scripts/test/`. Today that is the STUN
  codec behind `npm run check:turn`, pinned to the published test vectors in
  RFC 5769, and `ci-summary.mjs`, which parses each job's output for the run
  page — its fixtures are captured runner output, including the ANSI-styled
  lines Vitest writes when its output is piped, which is the case that only
  showed up against a real log. Wire-format code is worth this much: a MESSAGE-INTEGRITY that is
  subtly wrong still looks fine locally and fails against every real server, so
  the check would report a network problem that doesn't exist. Those tests are
  dependency-free, which is why CI runs them without an install step.

## Documentation expectations

- New environment variable → add it to the matching `.env.example` **and** the
  README setup section.
- New endpoint → document it in the README, following the host-controls section.
- New user-visible feature → update the README feature table, including what is
  deliberately *not* done yet.
