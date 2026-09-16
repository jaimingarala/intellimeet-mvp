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

### 4. Optional: TURN for strict NATs

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

### 5. Optional: real AI summaries

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
| Meeting title | 120 characters | `POST /api/meetings` → `413` |
| Request body | 1 MB | `express.json({ limit: '1mb' })` |
| Summaries | 10 per 15 minutes **per user** | `express-rate-limit` → `429` |
| Signup / login attempts | 30 per 15 minutes per IP | `express-rate-limit` → `429` |

Size violations are `413`, malformed values are `400`, and the rate-limited
summary response carries a `RateLimit-*` header set.

Worth knowing before deploying:

- The summarize limit is **per user, not per IP**, because every call can hit the
  OpenAI API and cost money. Both limiter stores are in-memory, so the budget is
  per server process; a multi-instance deploy needs a shared store (Redis) — and
  behind a proxy, IP-keyed limits need `trust proxy` configured, or every user
  shares one bucket.
- A participant has to be *in* the room (joined over the socket) to send chat,
  not merely listed on the meeting.
- Chat **history** is not capped yet: `$push` grows a meeting's `chatMessages`
  array without bound. Fine for an MVP, but a retention policy
  (`$push` with `$slice`) is worth adding before rooms run for hours.
- Anyone who can read a meeting can currently overwrite its transcript and
  summary — only the host is prevented from being removed. Restricting summary
  generation to the host is a product decision, not yet made.

## Contributing

Work happens on a branch per task and lands through a pull request — see
[CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, the commit-message
convention, and the exact commands CI runs. `main` is kept green by
`.github/workflows/ci.yml`, which lints and tests the server and builds the
client on every push and pull request.

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
