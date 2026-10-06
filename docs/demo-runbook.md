# Demo runbook — screenshots and the demo video

Two deliverables need a person and a deployed URL: the visual set (5–10
high-quality screenshots or GIFs of a real multi-user session, plus Lighthouse
numbers) and the 3–7 minute demo video. This file is the script for both, so the
result is reproducible rather than whatever happened to be on screen.

**What is blocked, precisely.** The URL does not exist yet: it needs a Render, an
Atlas and a Vercel account, and [`DEPLOYMENT.md`](../DEPLOYMENT.md) is the
walkthrough. Everything else here is ready — the shot list names the exact state
to capture, and the video beats are chosen so that each one demonstrates
something a still frame cannot.

## Before you capture anything

1. **Deploy, then check it from the outside.** Do not start recording against an
   unverified deployment:

   ```bash
   npm run verify:demo -- --api https://<service>.onrender.com --client https://<app>.vercel.app
   ```

   Six checks have to pass: health and how long it took, a browser-shaped CORS
   preflight from the client's origin, one click of the demo, the room it landed
   in, a second visitor joining by link, and a refresh on the room URL. Anything
   it reports is a setting to fix, and it names which one.

2. **Warm the instance and keep it warm.** A sleeping free instance takes about
   50 seconds to answer. The scheduled keep-alive ping handles the idle case, but
   open the landing page once before recording so the first click is fast.

3. **Two participants, two devices or two browsers.** The brief asks for a real
   multi-user session, and the strongest version has the two peers on different
   machines: a laptop and a phone on a hotspot proves the media path, and the
   tiles show genuinely different cameras rather than two windows on one screen.

4. **Housekeeping that ruins takes:** notifications off, one window per browser
   profile, the browser at 100% zoom, and a clean desktop behind the window. For
   the screenshots, capture at the window's natural size (1440×900 is plenty)
   rather than a scaled-up one — upscaled text looks worse than a smaller frame.

5. **Say what is true.** If the call goes through TURN, the tile says so and the
   video should not pretend otherwise. If ICE finds no path, the tile says **no
   path** instead of going black, and that is worth showing rather than hiding.

## Screenshots (5–10)

Save them in `docs/screenshots/` with the names below, so the README and the
report can reference a stable path.

| # | File | Capture exactly this | Why this frame |
|---|---|---|---|
| 1 | `01-landing.png` | The landing page with **Try the demo** visible and no form filled in | The highest-weighted rubric item, readable at a glance |
| 2 | `02-room-two-peers.png` | The room with two participants joined, both tiles live, both names visible | The multi-user session, which is what the brief asks to see |
| 3 | `03-screen-share.png` | A share in progress, with the shared tile uncropped and its **sharing** flag set | The hardest feature to fake in a still image |
| 4 | `04-chat.png` | Two chat messages, one from each participant, with the sender names visible | Real-time chat that was persisted rather than echoed |
| 5 | `05-summary-action-items.png` | The AI tab with a summary and at least three action items, one ticked | The product's differentiator, and the tick is shared state |
| 6 | `06-dashboard-search.png` | The dashboard with several meetings and the search box filtering them | The post-meeting half of the product |
| 7 | `07-export.png` | The exported Markdown open in an editor, with the summary, action items and chat visible | The artifact a team would actually keep |
| 8 | `08-turn-badge.png` | A call badge reading **via TURN**, hover tooltip visible, with `VITE_ICE_TRANSPORT_POLICY=relay` set | Honest evidence of which network path carried the media |
| 9 | `09-ci-summary.png` | The GitHub Actions run page with a job's published test count and coverage visible | The numbers a reviewer can check without a token |
| 10 | `10-lighthouse.png` | The Lighthouse report for the deployed URL, both mobile and desktop scores in frame | The performance claim, measured rather than asserted |

A GIF is worth it for exactly two of these, if you have the tooling: the tick
propagating to the second participant, and a mute labelling the peer's tile.
Both are one-second events that a still frame cannot convey.

## The demo video (3–7 minutes)

Record at 1080p with system audio if you can, otherwise narrate live. The beats
below are ordered so that a viewer who stops watching after two minutes has still
seen the product working, and a viewer who watches to the end has seen the
engineering behind it.

| Time | Beat | What to do | What it proves |
|---|---|---|---|
| 0:00–0:20 | Cold open | The landing page. Say what the product is in one sentence, then click **Try the demo** | No sign-up, no credentials, one click |
| 0:20–0:45 | A guest arrives | Show the room that opens: the sample chat, summary and action items already populated | A demo that has content on arrival rather than an empty screen |
| 0:45–1:30 | Two people meet | **Copy invite link**, open it on the second device, join as a guest. Both tiles live and both names correct | A real multi-user session, across devices |
| 1:30–2:10 | Screen share | Start a share from the laptop, show it appearing uncropped on the phone, then stop it and confirm the camera returns | `replaceTrack` in place, and the camera track held separately |
| 2:10–2:40 | Mute and presence | Mute the phone; point out the label on the other side's tile | The `media-state` event: a remote track carries no display surface |
| 2:40–3:10 | Chat | Send a message from each side; reload one tab and show it is still there | Persisted chat, not a local echo |
| 3:10–4:00 | The AI pass | Open the AI tab, generate a summary from the chat log, then tick an action item and show it tick on the other device | The differentiator, and shared state |
| 4:00–4:40 | Afterwards | Open the dashboard, search for the meeting, export it to Markdown, open the file | The loop closes: the meeting produced a durable artifact |
| 4:40–5:20 | Under the hood | Show the CI run page with the published counts and coverage, then the architecture diagram in the repository | Technical depth, verifiable numbers, no token needed |
| 5:20–6:00 | Honest close | Say what is not built: no SFU, so rooms are for 2–6 peers; no load test yet; no recording or live transcription | Scope is a decision you can defend, not an omission you hid |

Notes that make the difference between a good take and a rushed one:

- **Do not narrate the UI.** "This is the dashboard" wastes the most valuable
  seconds in the video. Narrate the *why*: "the guest never picked a password,
  and the room was already theirs."
- **Keep one meeting for the whole video.** Searching the dashboard for the same
  meeting you just held is a stronger ending than switching to a different one.
- **If something fails on camera, keep it.** The failure states are designed to
  name what went wrong, and showing one is more credible than a run where
  nothing ever does.
- **Two takes is normal.** One pass for the in-meeting half and one for the
  dashboard half avoids a single 6-minute unbroken take.

## Lighthouse

Run it against the deployed client URL, in an incognito window with extensions
off, once for mobile and once for desktop:

1. Open DevTools → Lighthouse → Performance, Accessibility, Best Practices, SEO
   → Analyze page load (mobile), then repeat with Desktop.
2. Record the four numbers for both runs. Do not cherry-pick: if the first load
   is slow because the free instance was asleep, say so and re-run warm — an
   explanation is worth more than a suspicious 100.
3. Fix what is cheap before capturing: image alt text, colour contrast on the
   muted states, and a page title per route. Those are real accessibility points
   and they are quick.
4. Add both screenshots to the report's Visuals section and the numbers to the
   README, replacing the "not measured yet" note there.

## If the deployment is down on submission day

The brief's own backup rule: a high-quality video and screenshots must still
convey full functionality. This runbook is built for that — every beat above is
recorded against a running instance, and `docs/screenshots/` plus the video are
complete evidence on their own. Keep the artifacts local as well as posted, so
the fallback does not depend on the same platform that failed.
