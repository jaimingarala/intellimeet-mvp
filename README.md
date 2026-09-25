# IntellMeet — MVP

A trimmed, actually-runnable slice of the IntellMeet spec: real-time video
meetings, in-meeting chat, and AI-generated summaries + action items — built
on the MERN stack, with no paid services required to run it end to end.

## What's in the MVP (and what's deliberately deferred)

The original spec (Zidio submission doc) targets 500–5,000 concurrent
participants, Kubernetes autoscaling, 99.95% uptime, and live Whisper
transcription. That's a multi-quarter infra project, not a 28-day student
build — so this MVP keeps the product idea intact but cuts the scope to what
one person can actually run and demo:

| Spec feature | MVP status |
|---|---|
| JWT auth, signup/login | ✅ Full |
| One-click demo (no sign-up) | ✅ Anonymous guests, one per visitor, each with their own room or joining by link. A guest can later **claim** the session to keep what it built; the address it attaches is verified by email before it can sign in. |
| Real-time video (WebRTC) | ✅ Mesh peer-to-peer, good for small rooms (2–6 people). Not SFU-based, so it won't scale to 50+ participants — that needs a media server (mediasoup/LiveKit), noted below as a next step. |
| Real-time chat | ✅ Full, via Socket.io, persisted per meeting |
| AI meeting intelligence | ✅ Real feature, not a mock: paste a transcript (or leave it blank to summarize the chat log) and get a summary + action items. Uses OpenAI if you set `OPENAI_API_KEY`; otherwise falls back to a free, offline extractive summarizer so the whole app runs with zero API cost. |
| Post-meeting dashboard | ✅ Meeting history, status, revisit summaries |
| Host moderation (remove/ban) | ✅ Host-only endpoint; removing a participant also closes their socket so their video tile drops for everyone. A ban is stored on the meeting, so it survives a reload or reconnect. |
| Team workspaces / Kanban boards | ❌ Not in this MVP — separate feature, next milestone |
| Analytics dashboard | ❌ Not in this MVP |
| Redis caching, Kubernetes, Prometheus/Grafana | ❌ Not needed at MVP scale; see "Scaling up" below |
| Live audio transcription (Whisper) | ❌ Deferred — needs either a paid Whisper API or local GPU. The summarizer works today on pasted/typed notes so the AI feature is demoable now. |

This scoping-down is the honest version of the plan — the doc's day-by-day
schedule assumes infra (Kubernetes, load testing, 99.95% SLA) that doesn't
make sense to build before you have a single user. Ship this, demo it, then
add exactly the pieces above as they become the actual bottleneck.

## Project structure

```
intellimeet-mvp/
  server/   Node/Express API + Socket.io signaling + MongoDB models
  client/   React + Vite frontend
```

## Running it locally

### 1. Prerequisites

- Node.js 22+ (that is what CI runs and what the test runner needs).
- MongoDB — **optional for the one-command path below**, which starts a local
  `mongod` for you when nothing is listening. Otherwise use a free
  [MongoDB Atlas](https://www.mongodb.com/atlas) cluster.

### 2. One command (whole stack)

```bash
npm run setup   # installs server/ and client/ dependencies
npm run dev     # MongoDB + API + Vite client
```

`npm run dev` does the parts that used to need two terminals and a note about
ports:

- starts MongoDB if nothing is listening on the address in `server/.env`
  (`mongod`, with data in `.data/mongodb` so it survives restarts and a log at
  `.data/mongodb/mongod.log`), and leaves an already-running instance — or an
  Atlas URI — alone;
- picks free ports for the API and the client, so a second copy of the stack
  doesn't die with `EADDRINUSE` and nothing has to be hand-edited when 5000 is
  already taken;
- passes the API's real port to the client as `VITE_API_URL` and the client's
  origin to the API as `CLIENT_ORIGIN`, so the two always agree and CORS keeps
  working even when the ports shift;
- prefixes each process's output (`mongo`, `api`, `web`), reloads the API on save
  via `node --watch`, and stops everything on Ctrl+C.

It also creates a missing `.env` from the matching `.env.example`, and tells you
when a real `JWT_SECRET` still needs setting.

### 3. Or run the pieces separately

**Backend**

```bash
cd server
cp .env.example .env
# edit .env: set MONGO_URI and a random JWT_SECRET
npm install
npm run dev
```

The API + Socket.io server starts on `http://localhost:5000`. Check
`http://localhost:5000/api/health` for a heartbeat.

**Frontend**

```bash
cd client
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:5173`. Sign up, click "Start meeting," and open the
room URL in a second browser tab (or another device on the same network) to
test video + chat between two participants.

### 4. Try the demo (no sign-up)

The login page has a **Try the demo** button: one click provisions an anonymous
**guest** and drops them into a room of their own — no account, and no shared
credentials to type. Each visitor therefore gets a distinct identity and a
distinct room, so two people clicking the button never collide. A new guest room
is seeded with a short sample meeting — a chat log, the transcript behind it, and
the summary and action items — so the chat and the AI tab show real content on
arrival instead of an empty screen.

**Guest rooms are joined by link.** Anyone who opens a room URL without signing
in becomes a new guest *in that room*, so **Copy invite link** in the room header
is all it takes to get a second person — on another device or network — into the
same meeting and exercise the two-peer video path. Guests join as participants,
never as the host, so they can't end or moderate a room they were invited to.

**A guest can keep what it built.** From the room (or the dashboard), **Save
this session** asks for a name, email and password and turns the guest into a
real account. The user id is untouched, so the rooms, chat and AI summaries are
already theirs — nothing is copied or re-created — and the account is out of
guest retention's reach from then on. The credentials then work on the ordinary
login form.

Until they do that, a guest cannot be logged into: the password hash is of a
random value that is never stored or disclosed. Guests are ordinary members
otherwise, flagged with `isGuest` so they can be told apart (and aged out)
later. Set `DEMO_LOGIN_ENABLED=false` in `server/.env` to remove the path
entirely, and `DEMO_TITLE` to change the title a guest's room gets.

**Guest data is swept on a timer.** Each guest is a stored user and a stored
room, so a background job removes guests — and the rooms they own, chat, summary
and action items included — once they are older than `GUEST_RETENTION_HOURS`
(default 24), and releases any seat they held in someone else's room. It runs
shortly after boot (so a host that sleeps still catches up on wake) and then
every `GUEST_RETENTION_INTERVAL_MINUTES` (default 60). Only accounts flagged
`isGuest` are ever touched; set `GUEST_RETENTION_ENABLED=false` to keep guests
indefinitely.

Its lookups are indexed — `{ isGuest, createdAt }` on users, and `host`,
`participants` and `banned` on meetings — so each run is an index scan rather
than a collection scan, and stays that way as the demo accumulates data.
Mongoose builds them when the app connects; for a collection that is already
large, create them out-of-band instead of on a cold start.

Age is not the only test, though: **a demo that is still running is never cut
off mid-session.** Anything with a connected socket is left for the next sweep —
the guest themselves, and the host of a room that still has someone in it even
when that host has already left and only an invited visitor is sitting there
(deleting the host would take the room down with them). The sweep logs what it
kept. That check reads live Socket.io state, so it only works in-process — a
sweep run from cron cannot see who is connected, which is the main reason this
runs inside the server rather than beside it.

**There is also a count bound, which holds even when the sweep doesn't.**
`DEMO_MAX_GUEST_ROOMS` (default 200) caps how many guest rooms exist at once:
when a new demo room would exceed it, the oldest room that *nobody is in* is
evicted — the same cascade as the sweep, guest and chat and all. A room in use is
never evicted to make space; if every room is occupied the cap is exceeded rather
than turning a visitor away, so growth is then bounded by real concurrency. Set
`DEMO_MAX_GUEST_ROOMS=0` to drop the bound, and read the current count against it
from `GET /api/admin/stats`.

#### Sweeping from cron instead of the timer

The in-process timer is the default. If a platform would rather have an external
scheduler — or the process sleeps too often for a timer to fire reliably — set
`ADMIN_TOKEN` to a long random value and drive the sweep from cron:

```bash
cd server
ADMIN_TOKEN=... npm run sweep:guests
```

That command drives two endpoints, both requiring the `x-admin-token` header and
both absent (returning `404`) while `ADMIN_TOKEN` is unset, so a deployment that
doesn't want this surface has nothing listening:

- `GET /api/admin/stats` — retention config, who is connected right now, how many
guest accounts are stored, and what the last sweep did.
- `POST /api/admin/sweep` — runs the sweep and returns what it removed.

**The sweep deliberately does not run in the cron process itself.** Deciding
whether a demo is still going needs Socket.io's live state, which a separate
process cannot see; a script that opened MongoDB directly would cheerfully delete
a room someone is sitting in. Triggering the endpoint keeps one process and one
view of who is connected.

One more limit before pointing a public URL at this: `/demo` provisions a user
per call, and `/claim` converts one, so both share the signup/login rate limit
(30 requests per 15 minutes per IP) — a whole office behind one NAT shares that
budget.

#### Checking a deployed demo

```bash
npm run verify:demo -- --api https://<service>.onrender.com --client https://<app>.vercel.app
```

This is the deployment half of the checks in this document: it walks the path a
visitor takes against the real URL — the health endpoint and what it took to
answer, a browser-shaped CORS preflight from the client's origin, one click of
"Try the demo", the room it landed in (sample chat, summary and action items
included), a second visitor joining that room by link, and a refresh on
`/room/<code>` to prove the SPA rewrite — and reports the thing to change rather
than the thing that failed. It exits non-zero if any step does, and creates two
guest accounts and a room per run, which guest retention sweeps up afterwards.
`DEPLOYMENT.md` has the same walkthrough with the accounts it needs.

### Claiming verifies the address

`/claim` is the one path that attaches an address nobody has proven, and the
risk is specific: a squatter typing a stranger's email would otherwise reserve
it, and because email is the login key, could later sign in under an address
that isn't theirs — or at least block the real owner from claiming it.

So a claim lands in a *pending* state. The address is recorded, a single-use
token is emailed to it, and **login is refused until that token comes back**:
holding the token is the proof, since the only way to get one is to receive mail
at the address. Everything else is unaffected — the claimant keeps the session
and the rooms, chat and summaries they built, because the user id never changes.

- `POST /api/auth/verify-email` — spends the link (`{ token }`). It deliberately
  does **not** return a session: the link proves the address, the password signs
  you in. A forwarded email can't be traded for a logged-in browser.
- `POST /api/auth/resend-verification` — sends a replacement link, and answers
  identically whether or not the address exists, so it can't be used to ask
  "does this person have an account?".

Only the token's hash is stored, so a database leak yields no working links, and
a token is bound to the address it was sent to, so it can't be replayed against
a different one. Issuing a new token replaces the old, so an earlier link dies
the moment a later one is sent.

Mail goes out over `MAIL_WEBHOOK_URL` (a JSON POST — every provider offers one,
and it keeps the project dependency-free). With it unset, the server logs the
message in dev and sends nothing in production, since a verification link in a
production log is a working credential. Set `EMAIL_VERIFICATION_REQUIRED=false`
to skip the pending state entirely, for a deployment that can't send mail.

### 5. Optional: TURN for strict NATs

By default the client uses only public STUN, which discovers each peer's
address but cannot relay media. Two peers behind strict or symmetric NATs
(corporate networks, some mobile carriers) then fail to connect. Point the
client at a TURN relay to fix that:

```
# client/.env
VITE_TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
VITE_TURN_USERNAME=intellimeet
VITE_TURN_CREDENTIAL=change_this_turn_password
```

Any TURN server works — self-hosted [coturn](https://github.com/coturn/coturn),
Twilio, Metered, etc. These values reach the browser, so for anything public
prefer short-lived credentials minted by the backend over a static password.

#### Checking the relay before you need it

```bash
npm run check:turn
```

This talks TURN to the servers in `client/.env` directly and reports three things
per URL: that the host answers, that it demands credentials (and which realm),
and that *our* credentials allocate a relay address. One host is enough — no
second network, no browser:

```
turn:turn.example.com:3478 (udp)
 ✓ reachable   STUN answered — this host appears as 203.0.113.5:41234
 ✓ challenge   realm "intellimeet.test", nonce issued for intellimeet
 ✓ relay       allocated 198.51.100.7:53512 (lifetime 600s)
```

Exit status is 0 if at least one relay allocated. Every failure comes with the
thing to change rather than a number: `401`/`403`/`441` point at the credentials
(and at `--secret` if the server uses coturn's `use-auth-secret`, where the
credential must be a time-limited HMAC token rather than the shared password),
`508` means the relay is out of capacity, and a timeout points at a firewall.
`--insecure` skips TLS verification for a self-signed development relay,
`-v` dumps every message exchanged, and `--help` lists the rest.

What it does **not** prove is that the relay forwards media, which needs a peer
the server can reach. That half stays with the smoke test below — this exists to
rule out the boring reasons it would fail.

#### A local relay, for proving the media path

No account is needed to exercise a real relay: `turn/docker-compose.yml` runs
coturn on this machine. Docker is the only requirement — no accounts, and no
Docker settings to change.

```bash
npm run turn:up      # npm run turn:logs to watch it, turn:down to stop it
```

Only the listening port is published, which is enough because of how relay-only
media actually travels: a browser never sends straight to the other peer's relay
address, it sends to its own allocation and the server forwards. Both allocations
live in this one container, so the forwarding never leaves it and the relay port
range does not have to be reachable from the host. (coturn is told
`--external-ip=127.0.0.1` so that the relay address it advertises is one the
browser can reach; without it coturn would advertise the container's own address
and a call would allocate and then silently fail.)

The relay's credentials are throwaway and live in `turn/turnserver.conf`, so put
the same three values in `client/.env`:

```
VITE_TURN_URLS=turn:127.0.0.1:3478
VITE_TURN_USERNAME=intellimeet
VITE_TURN_CREDENTIAL=devpassword
```

`npm run check:turn` should then report `reachable`, `challenge` and `relay`.
That confirms the client's configuration matches the running relay, which is the
first thing worth ruling out when a call fails.

Now set `VITE_ICE_TRANSPORT_POLICY=relay`, restart the client, and open a room in
two tabs. The nuance worth being precise about: relay-only forbids host and STUN
candidates, so both tabs must go through coturn *even though they share a
machine*, and both tiles should badge **via TURN**. That makes it a genuine
end-to-end proof of the relay — allocation, permissions and media forwarding —
and it is the half `check:turn` cannot reach, because a tool on one host can ask
for an allocation but has no second peer to send media to.

What it still cannot tell you is whether two *different* networks can reach each
other: the relay is on this machine, so it says nothing about NAT traversal in
the wild. That remains the two-network test below. What it buys is being able to
debug the relay half locally first, which is the half that usually fails for
boring reasons. `npm run turn:down` stops it.

#### Proving it: the two-network smoke test

A localhost two-tab test normally proves nothing about TURN — both tabs gather
host candidates and connect directly without ever touching the relay. The one
exception is the local relay above with the policy forced to `relay`, where there
is nowhere else to go. What no single machine can tell you is whether two
different networks can reach each other, so this test has to be two networks:

1. Configure a real `VITE_TURN_*` (above), confirm it with `npm run check:turn`,
   and restart the client.
2. Set `VITE_ICE_TRANSPORT_POLICY=relay` and restart again. This forbids direct
   connections, so a call can only succeed *through* TURN — if it connects now,
   the relay carried the media. The room shows an amber **via TURN** badge on
   each peer when that is what happened, and a banner confirming relay-only mode.
3. Put the two peers on genuinely different paths — one on wifi, one on a phone
   hotspot is the cheapest version. Avoid two devices behind the same NAT if you
   can; that is the case that would have worked without TURN anyway.
4. Both should see each other's tile, an amber **via TURN** badge, and hear each
   other. Hover the badge for the candidate types that were used.
5. Set `VITE_ICE_TRANSPORT_POLICY` back to empty for normal use. Leaving it on
   routes every call through the relay: correct but slower and metered.

If it fails, the tile says so instead of going quietly black: **no path** means
ICE found nothing, and the title carries the `icecandidateerror` code — a
`401`/`403` there is almost always wrong `VITE_TURN_CREDENTIAL`, and a `701`
means the relay address was unreachable. A **direct** badge during step 4 means
the policy didn't take effect (the client wasn't restarted). Run `check:turn`
first either way: if it passes, the problem is the network path between the two
peers, not the relay itself.

### 6. Optional: real AI summaries

By default, the "Generate summary" button uses a free offline summarizer —
no API key needed, works immediately. To use GPT-quality summaries instead,
set in `server/.env`:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini
```

No other code changes needed — the backend automatically prefers OpenAI when
the key is present and falls back gracefully if the call ever fails.

## Host controls: removing or banning a participant

Only the meeting's host can evict anyone; participants get a `403`.

```bash
# Remove (kick) a participant — dropped from the room, socket closed.
curl -X DELETE http://localhost:5000/api/meetings/<meetingId>/participants/<userId> \
  -H "Authorization: Bearer <hostToken>"

# Remove *and* ban — they cannot rejoin this meeting at all.
curl -X DELETE "http://localhost:5000/api/meetings/<meetingId>/participants/<userId>?ban=true" \
  -H "Authorization: Bearer <hostToken>"
```

A body of `{"ban":true}` works the same as `?ban=true`, and the response is
`{ userId, banned, evictedSockets, participants }`.

The difference between the two modes matters:

- **Remove** is a session-level kick. The evicted browser gets a
  `removed-from-room` Socket.io event, leaves the room, and stops retrying — but
  nothing is stored, so they can join again by reloading.
- **Ban** is recorded in the meeting's `banned` list. It is checked when a
  socket joins, when the room is looked up, and when chat is posted, so a banned
  user stays out across reloads, new tabs, and server restarts.

## Limits and abuse protection

The caps live in one place — `server/src/config/limits.js` — and the client
mirrors the two user-facing ones in `client/src/lib/limits.js` so the UI stops a
user before the server has to.

| What | Cap | Enforced by |
|---|---|---|
| Pasted transcript | 20,000 characters | `POST /api/meetings/:id/summarize` → `413` |
| Chat-derived transcript | 20,000 characters, keeping the most recent end | same route, applied while building the fallback |
| Chat message | 2,000 characters | socket `chat-message` → `error-message` to the sender |
| Chat messages | 30 per minute **per user** | socket `chat-message` → `error-message` to the sender |
| Meeting title | 120 characters | `POST /api/meetings` → `413` |
| Request body | 1 MB | `express.json({ limit: '1mb' })` |
| Room code (socket) | 64 characters, must be a string | socket `join-room` → `error-message` |
| Signalling payload | 20,000 characters of JSON | socket `signal` → `error-message`, never relayed |
| Summaries | 10 per 15 minutes **per user** | `express-rate-limit` → `429` |
| Meetings created | 30 per 15 minutes **per user** | `express-rate-limit` → `429` |
| Signup / login / demo attempts | 30 per 15 minutes per IP | `express-rate-limit` → `429` |

Size violations are `413`, malformed values are `400`, and rate-limited
responses carry a `RateLimit-*` header set.

Worth knowing before deploying:

- The summarize limit is **per user, not per IP**, because every call can hit the
  OpenAI API and cost money. Both limiter stores are in-memory, so the budget is
  per server process; a multi-instance deploy needs a shared store (Redis). The
  IP-keyed limits also need `trust proxy` set, or every visitor behind a platform
  proxy looks like the same address and they all share one bucket — production
  trusts one hop by default (override with `TRUST_PROXY`), which is what stops
  thirty demo clicks from anywhere in the world exhausting the budget for the
  rest of the afternoon.
- A participant has to be *in* the room (joined over the socket) to send chat,
  not merely listed on the meeting.
- Chat **history** is not capped yet: `$push` grows a meeting's `chatMessages`
  array without bound. Fine for an MVP, but a retention policy
  (`$push` with `$slice`) is worth adding before rooms run for hours.
- CORS comes from `CLIENT_ORIGIN`, but it is the browser's rule, not ours: it
  stops a page from *reading* our responses, not a script from calling the API,
  and the server always answers. Every route authorises on its own — JWT, plus
  host-or-participant membership — which is the boundary that actually matters.
  The configuration mistake that is worth catching (a `*` origin, which a browser
  refuses on a credentialed request) is reported at boot and in
  `GET /api/admin/stats`.
- A signalling payload is relayed without being inspected (that is what makes
  the relay cheap and codec-agnostic), but it is length-capped: "opaque" is not
  the same as "unbounded".
- `npm audit` reports advisories in the client's tree that are **not** fixed
  here: `react-router-dom` 6.x (two open-redirect / SSR-hydration issues, fixed
  in 7.x) and, in devDependencies only, `esbuild`/`vite` and Vitest's mock server.
  The server's tree is clean. Deferred because the React Router fix is a major
  version that re-touches every screen — this app navigates only to
  server-generated room codes and does not server-render, so the reachable path
  is narrow, but "narrow" is not "nothing" and it should be done before this
  handles real accounts.
- Anyone who can read a meeting can currently overwrite its transcript and
  summary — only the host is prevented from being removed. Restricting summary
  generation to the host is a product decision, not yet made.

## Logging and errors

Every request is given an id — its own, or the `X-Request-Id` a proxy sent —
which comes back in the response header and in every error body:

```json
{ "error": "Internal server error.", "requestId": "0f6d1a3e-…" }
```

That is the difference between a visitor saying "it broke" and you finding the
line that broke it. One line is logged per completed request and one per
failure: `json` in production (what a platform's log viewer wants) and
`pretty` in development, configurable with `LOG_FORMAT` and `LOG_LEVEL`.

Failures are classified before they are reported: an API that answers `500` for a
body over the size limit sends you looking for a bug that doesn't exist, so that
is a `413`. Stacks go to the log, never to the response, and
fields whose *names* look like credentials (`password`, `token`, `authorization`,
`apiKey`, …) are redacted on the way in. `GET /api/admin/stats` reports the
level, format and `trustProxy` setting this process is actually using.

## Contributing

Work happens on a branch per task and lands through a pull request — see
[CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the commit-message
convention, and the exact commands CI runs. `main` is kept green by
`.github/workflows/ci.yml`, which on every push and pull request lints and tests
both packages against a coverage floor, checks formatting with Prettier, builds
the client, and re-runs the STUN test vectors. Nothing in it needs a database,
Docker, or a paid account.

## Scaling up from here (in priority order)

1. **SFU for video** — swap the WebRTC mesh for a media server (LiveKit,
   mediasoup, or Daily/Twilio if you want managed) once rooms need more than
   ~6 concurrent video participants.
2. **Live transcription** — pipe meeting audio to OpenAI's Whisper API (or a
   self-hosted `faster-whisper` if you have GPU access) instead of relying on
   pasted notes.
3. **Team workspaces & Kanban** — add a `Project`/`Task` model and board UI;
   the action-item extraction already produces the right shape of data to
   seed tasks from.
4. **Deployment** — a single Docker Compose file (API + client + MongoDB) is
   enough until you have real usage; hold off on Kubernetes/Helm until
   there's a concrete scaling reason for it.
5. **Observability** — add Sentry for error tracking before load testing or
   scaling infra; it's cheap to add and pays for itself immediately.

## Notes on the underlying spec doc

The uploaded planning document (`Zidio Web.pdf`) is a submission-guidelines
template combined with a project brief for a program called LogicVeda /
Zidio Development. It states plainly that AI-generated project content
results in disqualification for any stipend — worth keeping in mind: this
codebase is a scaffold and a starting point for you to build on, understand,
and extend in your own words, not something to submit as-is.
