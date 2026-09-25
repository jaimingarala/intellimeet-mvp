# IntellMeet — Next Milestone Plan

Derived from the gap analysis of `Zidio Web.pdf` against the current MVP.
Ordered by **rubric leverage** (weight × how far short we currently are), not by
the spec's own 28-day sequence.

## Why this order

The rubric's two weightings (they differ slightly between the deliverables table
and the evaluation-criteria table) agree on the shape of the answer:

| Rubric item | Weight | Status today | Leverage |
|---|---|---|---|
| Live public demo URL | 30% | zero — not deployed, everything is behind login | **highest** |
| GitHub repository | 20% | zero — not even a git repo | **highest** |
| Technical depth (tests, lint, security) | 25% | partial — clean code, no tests/CI/lint | high |
| Documentation (report PDF + README) | 20-25% | partial — README only, no report/diagram | high |
| Functionality & UX | 20% | partial — 5 of 7 areas, several half-done | medium |
| Deployment & reliability | 10% | zero — no Docker, no monitoring | medium |
| Presentation (demo video) | 10% | zero | medium |

Consequence: **~70% of the grade is demo + repo + docs, all currently at zero**,
while features are 20% and already partly done. So: ship the plumbing first, then
harden, then build features.

Constraint kept throughout: **no paid service may be required for a judge to run
the demo** (spec rule). This is why the AI feature keeps its offline fallback and
why live transcription is optional.

---

## Phase 0 — Repo foundation  ·  ~half a day  ·  unlocks everything

| ID | Task | Notes |
|---|---|---|
| P0.1 | `git init` + root `.gitignore` | Root needs `node_modules/`, `dist/`, `.env`, `*.log`, `.freebuff/`, editor cruft. Per-package `.gitignore`s already cover their own dirs; both `package-lock.json` files exist and must be committed (CI needs them). |
| P0.2 | Delete root artifacts `server.log`, `vite.log` | Untracked junk in the working tree. |
| P0.3 | Decide on `Zidio Web.pdf` (468 KB) | It is the assignment brief, not project code. Default: keep it out of the public repo. |
| P0.4 | Initial commit, then conventional commits + a branch + PR per task | Rubric asks for semantic commit messages and PRs "even if solo". |
| P0.5 | Create the GitHub remote and push | **Needs you**: GitHub account/repo (public). |
| P0.6 | Add `.nvmrc` + a "Requirements: Node 20+" note | Cheap points for "easy local setup". |

**Gate:** clean initial commit, clean `git status`, remote pushed, no `.env` in
history.

## Phase 1 — Public demo  ·  30%  ·  depends on Phase 0

| ID | Task | Notes |
|---|---|---|
| P1.1 | ✅ Guest provisioning on demand (`POST /api/auth/demo`, `services/guest.js`) | Superseded the original seed-script/shared-account plan: each visit creates a real anonymous `User` (flagged `isGuest`, unusable random password hash) plus a room of their own, seeded with a sample meeting. No script to run. `services/guestRetention.js` sweeps guests and their rooms after `GUEST_RETENTION_HOURS` (24h), so the path can't grow the DB without bound. |
| P1.2 | ✅ "Try the demo" one-click button on the login page | Rubric: core functionality available **without sign-up**. Each visitor gets a distinct identity and room, and a room link auto-joins a visitor as a guest — the "real guest join" stretch, across REST + sockets, so two people can meet with no accounts. Still needs TURN (P1.6) before two *networks* reliably connect. |
| P1.3 | Deploy server (Render free tier) + MongoDB Atlas M0 | `render.yaml` now carries the whole demo-shaped env surface (demo path, retention, `APP_BASE_URL`, verification off with no mail transport, optional `ADMIN_TOKEN`), so this is a Blueprint import plus four secrets. **Needs you**: the Render and Atlas accounts. |
| P1.4 | Deploy client (Vercel/Netlify), `VITE_API_URL` → server | `vercel.json` supplies build, output and the SPA rewrite. HTTPS automatic (rubric requires it). **Needs you**: the Vercel account. |
| P1.5 | ✅ Keep-alive ping every ~10 min | `.github/workflows/keepalive.yml` pings `/api/health` every 10 minutes; free tiers cold-start in ~50 s, which directly fights the rubric's "<5 s initial load". **Needs you**: set the `DEMO_API_URL` repository variable, or the workflow stays inert. |
| P1.8 | ✅ `npm run verify:demo` | Checks a deployment from the outside the way a visitor meets it — health and how long it took, a browser-shaped CORS preflight from the client origin, one click of the demo, the room it lands in, a second visitor joining by link, and a refresh on the room URL — and prints the thing to change rather than the thing that failed. Exits non-zero, `--json` for scripts. This is how Gate A gets verified instead of eyeballed. |
| P1.9 | ✅ Deployment checks at boot | `config/deployment.js` reports the misconfigurations that are invisible from the inside (placeholder `JWT_SECRET`, an origin still saying localhost, verification on with no mail transport, short `ADMIN_TOKEN`) and sets `trust proxy` in production, without which every visitor behind the platform proxy shares one rate-limit budget and the demo button starts refusing after ~30 clicks. Also visible via `GET /api/admin/stats`. |
| P1.6 | Real TURN for the demo | Metered/Twilio free credential or self-hosted coturn; `VITE_TURN_*` vars already wired. For `turns:` you need a certificate. `npm run check:turn` verifies reachability, the credential and the allocation before you rely on it, and `npm run turn:up` runs a local coturn (in `turn/`) so the whole relay path can be exercised without an account. What is left here is a *hosted* relay for the deployed demo. |
| P1.7 | Two-network smoke test (phone hotspot + wifi) | This is the "real multi-user session" the video needs, and the only way to prove NAT traversal between two actual networks. The relay half is now provable locally (see P1.6), so run `check:turn` first: if it passes, a failure here is the network path between the peers, not the relay. |

**Gate A:** an anonymous visitor opens the HTTPS URL, clicks once, and is in a
room with working video; two peers on different networks connect.

Half of it is verified locally today: the whole stack runs under `npm run dev`,
one click provisions a guest, and the room opens populated (sample chat, summary,
action items) with `npm run verify:demo` reporting 6 of 6 against the local API
and client. What is left is the deployed URL, which needs the accounts above, and
the cross-network half, which needs a second device.

## Phase 2 — Technical depth  ·  25%

| ID | Task | Notes |
|---|---|---|
| P2.1 | ✅ Test runner + harness | Node's built-in `node:test` — **no new dependency on the server**. `test/helpers/app.js` boots the real `src/index.js` on a free port with `fake-db.js` swapping the Mongoose models and the DB connector out, so the suites also cover the real middleware order, the 404 and the error handler. Nothing needs MongoDB, Docker, a `.env` or a paid account. |
| P2.2 | ✅ Suites: auth, meeting access, moderation, socket relay scoping, ICE queue | Fifteen suites and 165 tests at the end of this phase. The gaps closed were the ones a demo never surfaces: a socket payload with **no argument at all** (which used to throw inside an async listener and tell the client nothing), a chat flood, the meeting-creation cap, and the wildcard-origin case. |
| P2.3 | ✅ Client unit tests — **decided: vitest** | One dev dependency, scoped to `src/lib`: `webrtc.js` and the caps the client mirrors from the server (a mirror nothing else enforced — the test reads the server's file from disk). 100% of lines and ~95% of branches today, over the four `src/lib` modules. Components are deliberately untested: a renderer with a mocked socket mostly asserts that React works, and the demo path is rehearsed in a browser instead. |
| P2.4 | ✅ ESLint + Prettier + `npm run lint` / `npm run format:check` | ESLint was already in both packages. One Prettier config and ignore file at the **root**, covering both packages *and* `scripts/`, so there is a single source of truth instead of two that can disagree. Enabling the check meant formatting the tree once, in its own commit. |
| P2.5 | ✅ GitHub Actions CI | Four jobs: server (lint + coverage), format, scripts (STUN vectors, no install step) and client (lint + coverage + build). No database service anywhere, so it doubles as the P1.5 keep-alive host. Each test job `tee`s its output and publishes the counts, the failing test names and coverage beside its floor to the **run summary page** — GitHub serves job logs only to an authenticated request, so this is what makes the numbers readable by whoever is grading, and it is written on red runs too. `scripts/test/ci-workflow.test.mjs` holds the two invariants that fail silently: a `tee` without `set -o pipefail` reports green on a failing suite, and capturing output without publishing it hides the numbers again. |
| P2.6 | ✅ Security hardening | Rate caps for chat, meeting creation, room codes and signalling payloads alongside the existing transcript/title/chat limits; a `*` origin is stripped rather than honoured (a browser refuses a wildcard on a credentialed request, so honouring it means silently allowing nothing) and reported at boot; and the decorative `role` field was **deleted** rather than enforced — a claim no route reads reads as an authorization model that isn't there. |
| P2.7 | ✅ Observability | `lib/logger.js` (JSON in production, readable locally, credential-shaped field names redacted, `LOG_LEVEL=silent` for tests) plus `middleware/observability.js`: a request id echoed in `X-Request-Id` and in every error body, one log line per completed request, and one error handler that classifies before it answers — a body over the limit is a `413` rather than a `500`, a CORS rejection is a `403` that names the setting, and a stack stays in the log. **Sentry is out**: it needs an account and a key, which the no-paid-service rule forbids for a judge's clone. |

**Gate B:** CI green on a fresh clone with no database; lint clean; a defensible
coverage number. All three hold locally: the server runs at ~92% of lines and 86%
of branches, `client/src/lib` at 100% / 95.3%, and both floors are enforced by the
`test:coverage` scripts, so CI fails if they slip. Every job runs without MongoDB,
Docker or a `.env`. The coverage number is also *published* rather than
inferable: each job writes its counts and percentages to the run summary, so the
claim is checkable from the run page without a token. What is left is running it
on GitHub rather than here.

## Phase 3 — Feature gaps, ordered by demo value per unit of effort  ·  20% collectively

| ID | Task | Size | Spec ref |
|---|---|---|---|
| P3.1 | ✅ Screen sharing — `getDisplayMedia` swapped into the existing connection with `replaceTrack` (no renegotiation, no second stream), in place of the camera so a camera toggle during a share doesn't mute the screen. The room is told who is sharing, and a shared tile stops cropping. | S | F-02, Day 12 |
| P3.2 | ✅ Action-item tracking — host *or* participant, by position, persisted, and broadcast to the room so a tick is live rather than a refresh away. | S | F-05 |
| P3.3 | ✅ Dashboard search over the fields the row shows, and a Markdown export of a meeting's summary, action items and chat. | S | F-05 |
| P3.4 | Shared notes + typing indicators | M | F-04, Day 11 |
| P3.5 | `@mention` notifications in chat | M | Day 20 |
| P3.6 | Recording (canvas-composited `MediaRecorder` → WebM download) | M | F-02, Day 12 |
| P3.7 | **F-06: Team workspaces + Kanban board + "send action items to the board"** | L | F-06, Days 18-19 |
| P3.8 | F-07: light analytics (meetings held/attended, duration, items completed) with plain SVG charts — no charting dependency | M | F-07 |
| P3.9 | Live transcription via the browser's free Web Speech API, feeding the existing summarize endpoint | M-L | F-03, Day 15 |

P3.7 is the biggest remaining spec gap and the AI→task pipeline is a genuine
differentiator worth a demo segment, so it is the headline feature of this phase.
P3.9 is deliberately placed last and must stay optional/flagged: Whisper needs a
paid key or a GPU, which conflicts with the no-paid-deps rule.

**Still to do in this phase:** P3.4 (shared notes + typing indicators), P3.5
(`@mention` notifications), P3.6 (recording), P3.7 (the F-06 headline) and P3.8
(analytics) — plus P3.9 last, and only if it stays clearly optional.

**Gate C:** features frozen; each item works in the deployed demo and has a test
where the logic is non-trivial. The three landed items each carry tests where the
logic is theirs — the action-item route and the `media-state` relay in the server
suite, the track-swapping and the Markdown/Search helpers in vitest — and were
rehearsed in a browser against the local stack (tick a box, reload, it is still
ticked; mute in one guest, the other guest's tile says so). The deployed-demo
half of the gate is still the deploy itself.

## Phase 4 — Documentation & presentation  ·  20% + 10%

| ID | Task |
|---|---|
| P4.1 | Architecture diagram (Excalidraw/Draw.io → PNG): client, API, Socket.io, MongoDB, TURN, AI providers, deploy topology |
| P4.2 | README polish: live demo link **and demo credentials at the top**, architecture, test/lint commands, deployment notes, screenshots, roadmap, known limits |
| P4.3 | The project report PDF (Deliverable 1, 8-15 pages, following the spec's 10-section outline) — reuse the gap analysis as the "what is deferred and why" section |
| P4.4 | 5-10 screenshots/GIFs of a real multi-user session + Lighthouse scores on the live URL |
| P4.5 | 3-7 min demo video: two-person meeting → screen share → chat → AI summary/action items → board → analytics → then the deployed URL, tests, and CI run |
| P4.6 | Final hygiene: CI badge, license, verify both `.env.example` files match the code |

**Gate D:** submission package complete — URL, repo, README, report PDF, video.

## Phase 5 — Stretch (only if 0-4 land)

- **P5.1 TypeScript.** Spec's stack line, but lowest rubric ROI here; if pursued,
  do `checkJs` + JSDoc on the server first.
- **P5.2 Redis adapter + sticky sessions** to make the "Socket.io clustering"
  NFR claim true. Required before any multi-instance deploy — the moderation
  eviction path reaches sockets through an in-process `io` reference, so it does
  not work across instances today.
- **P5.3 SFU media server** (LiveKit/mediasoup) for the 50-participant claim.

### Explicit non-goals this milestone
Kubernetes/Helm, Prometheus/Grafana, OAuth2, SFU, and any claim of 500-5,000
concurrent participants. Documented as deferred instead — an honest "not yet,
here's why" reads better than a checkbox that falls over in the demo.

## Risks

| Risk | Mitigation |
|---|---|
| Free-tier cold start undermines the 30% demo | P1.5 keep-alive ping; video backup per the spec's own fallback rule |
| Mesh video caps out around 6 peers (spec wants 50+) | Document the limit; never demo more than 4-5 tiles |
| Live transcription accuracy vs the spec's ">85%" | Do not claim accuracy; label it experimental and state what was measured |
| Single-process socket state | No horizontal scaling until P5.2; say so in the report |
| AI-generated docs/video vs the plagiarism rule | Docs, video, and reflection must be your own words and your own demo |
| Feature work squeezing out the 70% | Gate A and B close before Phase 3 starts |

## Needs you (accounts)

- GitHub repo (public) to push to; Render + Vercel + Atlas accounts.
- A `DEMO_API_URL` repository variable, or the keep-alive workflow does nothing.
- TURN credentials for the deployed demo (the local coturn in `turn/` proves the relay path without one).
- Decision still open: commit the brief `Zidio Web.pdf` or keep it out (P0.3).

## Decisions taken

- **Client tests (P2.3):** vitest, one dev dependency, scoped to `src/lib`. The
alternative — leaving the client untested and saying so — was rejected because
`webrtc.js` is exactly the file where a bug is invisible until two peers fail to
connect, and there is no error to read when it happens.
- **Prettier (P2.4):** one config at the repository root rather than one per
package, because two configs that can disagree are worse than none.
- **The `role` field (P2.6):** deleted. Nobody read it; keeping it would have
meant inventing an admin path to justify it, which is Phase 3 work at best.
- **Sentry (P2.7):** not adopted. Optional in the plan, and it would put a key
and an account between a judge and a working clone.
