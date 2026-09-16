# Deploying IntelliMeet

MongoDB Atlas (free M0) + Render (free web service) + Vercel. No paid service is
required for the demo: the AI summarizer falls back to a free offline one when
`OPENAI_API_KEY` is unset, and STUN alone covers most network pairs.

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

Two free-tier behaviours to expect. The service **sleeps after ~15 minutes idle
and takes ~50 seconds to wake**, which is long enough to look like a broken
demo — a scheduled keep-alive request every 10 minutes avoids it. And `PORT` is
assigned by Render; the server reads it, so never hardcode one.

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
   both are correct the browser gets opaque CORS failures.

`rewrites` in `vercel.json` sends unknown paths to `index.html`. Without it a
refresh on a room URL such as `/room/ab12-cdef-3456` returns Vercel's 404
instead of the meeting room. Vercel checks the filesystem before applying
rewrites, so hashed assets under `/assets/` are still served normally.

## Environment reference

Server (Render):

| Variable | Required | Notes |
|---|---|---|
| `MONGO_URI` | yes | Atlas `mongodb+srv://…` string |
| `JWT_SECRET` | yes | Any long random value; keep out of Git |
| `CLIENT_ORIGIN` | yes | Comma-separated allowed origins, exact, no trailing slash |
| `JWT_EXPIRES_IN` | no | Defaults to `7d` |
| `OPENAI_API_KEY` | no | Unset → offline summarizer |
| `OPENAI_MODEL` | no | Defaults to `gpt-4o-mini` |
| `PORT` | no | Injected by Render |

Client (Vercel):

| Variable | Required | Notes |
|---|---|---|
| `VITE_API_URL` | yes | Render service URL |
| `VITE_STUN_URLS` | no | Defaults to a public STUN server |
| `VITE_TURN_URLS` | no | Needed only for peers behind strict/symmetric NAT |
| `VITE_TURN_USERNAME` | no | |
| `VITE_TURN_CREDENTIAL` | no | Served to the browser — use short-lived credentials |

## Verify the deployment

- `curl https://<service>.onrender.com/api/health` returns 200.
- Open the Vercel URL, sign up, start a meeting.
- Open the room URL in a second tab — chat and video should connect. Two tabs on
  the same machine prove signalling; two devices on different networks prove
  ICE. Only the second case needs TURN.
- Hard-refresh on a `/room/<code>` URL to confirm the SPA rewrite works.
- Watch the browser console: `blocked by CORS policy` means `CLIENT_ORIGIN` and
  the Vercel origin disagree.

## Local development

No `docker-compose.yml` is needed, unlike the legacy repo. `npm run dev` starts
`mongod` itself, keeping data in `.data/mongodb` (run `scripts/dev.mjs`), and
pointing `MONGO_URI` at Atlas switches it to the remote cluster. There is no
Redis to run locally because there is no Redis adapter.
