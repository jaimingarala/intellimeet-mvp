# Deploying IntelliMeet

MongoDB Atlas (free M0) + Render (free web service) + Vercel. No paid service is
required for the demo: the AI summarizer falls back to a free offline one when
`OPENAI_API_KEY` is unset, and STUN alone covers most network pairs.

The four steps take about half an hour, and step 4 is the one to actually run —
`npm run verify:demo` walks the visitor's path against the deployed URL and names
whatever is wrong with it.

This replaces the June 2026 checklist stored in the `legacy` remote. The stack
is the same shape, but the environment variable names, the service count and the
SPA routing all differ — see the notes in each step.

## Why one service and no Redis

`server/src/index.js` builds one HTTP server, attaches Socket.io to it, and
serves the REST routes from the same Express app. The earlier monorepo split the
API and the socket server into two processes and put a Redis adapter between
them, so its blueprint needed two web services plus a Key Value instance. This
version needs exactly one service, and there is no `redis` dependency in
`server/package.json` to support more than one instance anyway.

That is also the current scaling limit: socket state lives in the process, so
run a single instance. Do not enable autoscaling until an adapter is added.

## 1. MongoDB Atlas

1. Create a free **M0** cluster at <https://cloud.mongodb.com>.
2. **Database Access** → add a user with `readWrite` on this database.
3. **Network Access** → allow `0.0.0.0/0`. Render's free tier has no static
   outbound IPs, so this is required. It is a demo-grade setting: it exposes the
   cluster to the internet, and the only thing protecting it is the password.
4. **Connect** → *Drivers* → copy the `mongodb+srv://…` string and substitute
   the user's password.

Save it as `MONGO_URI` in step 2. Note the name: this project uses `MONGO_URI`,
**not** the `MONGODB_URI` the legacy repo used. The local `.env.example` agrees.

## 2. Render — API + Socket.io

1. **New → Blueprint**, connect this repository. Render reads `render.yaml`.
2. Fill the three secrets it prompts for (they are `sync: false`, so they are
   never read from the repo):
   - `MONGO_URI` — the string from step 1
   - `JWT_SECRET` — any long random string
   - `CLIENT_ORIGIN` — temporarily `http://localhost:5173`; step 3 fixes it
3. Deploy, then confirm `https://<service>.onrender.com/api/health` returns
   `{"status":"ok","service":"intellimeet-api",…}`.

Two free-tier behaviours to expect. The service **spins down after 15 minutes
without inbound traffic and takes about a minute to wake**, which is long enough
to look like a broken demo; `.github/workflows/keepalive.yml` pings
`/api/health` every 10 minutes to keep it warm and needs `DEMO_API_URL` set as a
repository variable. Render counts WebSocket messages as traffic, so an open
meeting room keeps the service awake on its own, and a service kept awake
continuously consumes almost all of the 750 free instance hours a workspace
gets per month — exhaust them and Render suspends every free service until the
next month. `PORT` is assigned by Render; the server reads it, so never
hardcode one.

## 3. Vercel — client

1. **Add New → Project**, import this repository.
2. Leave the root directory as the repository root. `vercel.json` supplies the
   build (`npm --prefix client run build`) and output (`client/dist`), so no
   dashboard overrides are needed. The legacy repo had to reach into
   `node_modules` for Vite's entry point because of workspace bin shims; calling
   the client's own `build` script avoids that entirely.
3. Add `VITE_API_URL=https://<service>.onrender.com` (the Render URL, no
   trailing slash). `VITE_*` values are inlined at build time, so changing one
   requires a redeploy, not just a restart.
4. Deploy, then go back to Render and set `CLIENT_ORIGIN` to the Vercel origin
   and redeploy. **Order matters** — each side needs the other's URL, and until
   both are correct the browser gets opaque CORS failures. Then set the server's
   `APP_BASE_URL` to the same Vercel origin, so a confirmation link points at the
   app rather than at localhost.

`rewrites` in `vercel.json` sends unknown paths to `index.html`. Without it a
refresh on a room URL such as `/room/ab12-cdef-3456` returns Vercel's 404
instead of the meeting room. Vercel checks the filesystem before applying
rewrites, so hashed assets under `/assets/` are still served normally.

## 4. Verify the deployment

```bash
npm run verify:demo -- --api https://<service>.onrender.com --client https://<app>.vercel.app
```

That walks the path a visitor takes and reports each step against the thing that
would be wrong, rather than leaving you to read a browser console: the health
endpoint and how long it took, a browser-shaped CORS preflight from the client's
origin, one click of "Try the demo", the room it landed in (sample chat, summary
and action items included), a second visitor joining that room by link, and a
refresh on `/room/<code>` to prove the SPA rewrite. It exits non-zero if any of
them fails, and creates two guest accounts and a room per run — flagged
`isGuest`, so the retention sweep takes them back out.

The flags default to `DEMO_API_URL`, then `VITE_API_URL` in `client/.env`, and to
`APP_BASE_URL` in `server/.env` for the origin, so the shorter form works once
those are set. `--json` prints the same result for a script.

Also worth setting once under **Settings → Secrets and variables → Actions →
Variables**: `DEMO_API_URL` (a variable, not a secret). It is what
`.github/workflows/keepalive.yml` pings every 10 minutes, and until it is set the
workflow does nothing rather than failing.

Then, by hand, the two things a script cannot see: open the Vercel URL in a
browser and confirm the video tiles connect between two tabs (signalling), and
later between two devices on different networks (ICE — see the TURN section).

## 5. TURN for the deployed demo

Most network pairs connect directly and need no relay. Two peers behind strict or
symmetric NATs do not, and that is the case a demo on someone else's wifi will
find. The client-side variables are `VITE_TURN_URLS`, `VITE_TURN_USERNAME` and
`VITE_TURN_CREDENTIAL`, set in Vercel (they are inlined at build time, so a
change needs a redeploy).

Before trusting a relay, prove it can be used from one host:

```bash
npm run check:turn          # reads client/.env; --urls/--username/--credential override
```

That speaks TURN to the server directly and reports reachability, the
credential challenge and a real allocation, with the fix rather than the error
code when a step fails. `--help` lists the options, and `--secret` mints a
coturn `use-auth-secret` credential instead of using a static password. The whole
relay path can be rehearsed without an account: `npm run turn:up` starts a local
coturn (see `turn/`), and forcing `VITE_ICE_TRANSPORT_POLICY=relay` in a local
client proves media really travels through it — that the relay *forwards*, which
`check:turn` cannot show on its own.

What no single machine can show is whether two different networks reach each
other. That is the two-network smoke test in the README, and it is the run worth
capturing for the demo video.

## 6. Reading the logs

Every request gets an id — its own, or the `X-Request-Id` the proxy in front
sent — and that id comes back on the response. It is also in every error body:

```json
{ "error": "Internal server error.", "requestId": "0f6d1a3e-…" }
```

So "the demo said 500 at 14:02" is searchable: grep the platform's logs for the
id and you get the one line that belongs to it, with the request that caused it.

One line is written per completed request (`json` in production, `pretty` in
development), and one line per failure. The failure lines carry the stack — the
response never does, which is the point: a caller learns that something broke,
not how. Field names that look like credentials (`password`, `token`,
`authorization`, `apiKey`, …) are replaced with `[redacted]` on the way into the
log, so a request body logged by mistake cannot leak one.

Failures are classified before they are reported, which is where a plain Express
app usually gets it wrong:

| What happened | Status | Why it matters |
|---|---|---|
| Body over the 1 MB limit | `413`, not `500` | A `500` sends you looking for a bug that isn't there |
| Malformed JSON | `400` | The client sent it; the log says so without a stack |
| Anything else | `500`, generic message | The stack stays in the log |

An origin that isn't in `CLIENT_ORIGIN` is not an error at all: `cors` simply
omits `Access-Control-Allow-Origin`, and the browser is what refuses to hand the
response to the page. `npm run verify:demo` checks that preflight from the
outside, because that failure is completely invisible in a server log.

`GET /api/admin/stats` reports this process's `logLevel`, `logFormat` and
`trustProxy` alongside the deployment warnings, so you can confirm what a running
deployment is doing without reading its environment.

## Environment reference

Server (Render) — `render.yaml` carries the demo-ready values, and the tables
below are what each one does. `npm run verify:demo` and `GET /api/admin/stats`
both report the misconfigurations that matter.

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | yes | Atlas `mongodb+srv://…` string |
| `JWT_SECRET` | yes | Any long random value; keep out of Git. A short or placeholder value is reported at boot, since a guessable one lets anyone mint a token for any room. |
| `CLIENT_ORIGIN` | yes | Comma-separated allowed origins, exact, no trailing slash |
| `JWT_EXPIRES_IN` | no | Defaults to `7d` |
| `OPENAI_API_KEY` | no | Unset → offline summarizer |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini` |
| `PORT` | no | Injected by Render |
| `TRUST_PROXY` | no | Defaults to one trusted hop in production, which is what the platform proxy is. Both rate limiters are IP-keyed, so turning this off makes every visitor share one budget. |
| `DEMO_LOGIN_ENABLED` | no | Defaults to on. `false` removes the one-click demo path (it answers `403`), which is the path the rubric weights most. |
| `DEMO_TITLE` | no | Title given to the room a guest creates. |
| `DEMO_MAX_GUEST_ROOMS` | no | Defaults to `200`. A count bound on demo rooms, alongside the age-based sweep; `0` disables it. |
| `GUEST_RETENTION_ENABLED` | no | Defaults to on. |
| `GUEST_RETENTION_HOURS` | no | Defaults to `24`: how old a guest is before the sweep removes it and its room. |
| `GUEST_RETENTION_INTERVAL_MINUTES` | no | Defaults to `60`. The sweep runs once shortly after boot, then on this interval. |
| `APP_BASE_URL` | no | The URL people reach the app at; confirmation links point here. Set it to the Vercel origin, or the link goes nowhere. |
| `EMAIL_VERIFICATION_REQUIRED` | no | Defaults to **on**, which refuses login for a claimed address until a mailed link comes back. `render.yaml` sets it to `false` because production sends no mail without a webhook — an account claimed on such a deployment would otherwise stay pending forever. |
| `MAIL_WEBHOOK_URL` | no | JSON `POST { to, subject, text, link }`. Required for real verification mail. |
| `MAIL_WEBHOOK_TOKEN` | no | Bearer token for that webhook. |
| `ADMIN_TOKEN` | no | Enables `GET /api/admin/stats` and `POST /api/admin/sweep` (both `404` without it). Also the way to read this deployment's own config warnings. |
| `LOG_FORMAT` | no | `json` or `pretty`. Defaults to `json` in production, which is what a platform's log viewer wants. |
| `LOG_LEVEL` | no | `debug`, `info` (default), `warn`, `error`, or `silent`. |

Client (Vercel):

| Variable | Required | Notes |
|---|---|---|
| `VITE_API_URL` | yes | Render service URL |
| `VITE_STUN_URLS` | no | Defaults to a public STUN server |
| `VITE_TURN_URLS` | no | Needed only for peers behind strict/symmetric NAT |
| `VITE_TURN_USERNAME` | no | |
| `VITE_TURN_CREDENTIAL` | no | Served to the browser — use short-lived credentials |
| `VITE_ICE_TRANSPORT_POLICY` | no | `relay` forces media through TURN; the way to *prove* a relay carried a call. Leave empty in normal use. |

## Local development

No `docker-compose.yml` is needed, unlike the legacy repo. `npm run dev` starts
`mongod` itself, keeping data in `.data/mongodb` (run `scripts/dev.mjs`), and
pointing `MONGO_URI` at Atlas switches it to the remote cluster. There is no
Redis to run locally because there is no Redis adapter.
