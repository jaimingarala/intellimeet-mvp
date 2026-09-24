#!/usr/bin/env node
/**
 * Answers "does the deployed demo actually work?" from the outside, in one
 * command, before anyone else opens the URL.
 *
 * Why this exists: the live demo is the highest-weighted part of the submission
 * and the only part that cannot be checked on the machine it was built on. Every
 * way it goes wrong is silent from inside the process — CORS that only a browser
 * enforces, an origin still saying localhost, a free tier that spun down, a
 * `JWT_SECRET` nobody set, a client host without the SPA rewrite — and each of
 * them is a five-minute fix once it is named and an afternoon of guessing when it
 * is not.
 *
 * So this walks the path a visitor takes, in order, and stops being clever about
 * it: fetch the health endpoint, make a browser-shaped preflight from the client
 * origin, click "Try the demo" the way the login page does, read back the room it
 * landed in, join that room again the way a shared link does, and open the room
 * URL on the client host to prove a refresh does not 404.
 *
 * It creates real data — two guest accounts and one room per run — which is why
 * it says so and why the guests are flagged `isGuest`: the retention sweep takes
 * them back out. Two POSTs is also well inside the auth rate limit.
 *
 * Dependency-free on purpose, like scripts/check-turn.mjs and scripts/dev.mjs:
 * Node's own `fetch` is the entire client.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- output ------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, value) => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const color = {
  ok: (s) => paint('32', s),
  bad: (s) => paint('31', s),
  warn: (s) => paint('33', s),
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
};
const say = (line = '') => process.stdout.write(`${line}\n`);

function fail(message) {
  say(`${color.bad('✖')} ${message}`);
  process.exit(2);
}

// --- requests ----------------------------------------------------------------

/**
 * One request, with the failures returned rather than thrown: what a check needs
 * to report is usually *how* it failed, and an exception with a stack trace is
 * how that gets lost.
 */
async function request(url, { method = 'GET', headers = {}, body, timeoutMs, redirect = 'follow' } = {}) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not everything answers JSON — the client host answers HTML, which is the
      // point of the last check.
    }
    return { ok: true, status: res.status, headers: res.headers, text, json, ms: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      ms: Date.now() - started,
    };
  }
}

/**
 * What a dead request usually means, said in terms of the thing to change. The
 * real cause is one level down: a failed `fetch` says only "fetch failed" and
 * hides the code (ECONNREFUSED, ENOTFOUND, a TLS refusal) in `cause`.
 */
function connectionHint(response) {
  const err = response.error;
  const code = err?.cause?.code ?? err?.code ?? '';
  const detail = err?.cause?.message ?? err?.message ?? 'unknown error';
  const everything = `${code} ${err?.message ?? ''} ${detail}`;

  if (err?.name === 'TimeoutError' || /TIMEOUT|ETIMEDOUT|abort/i.test(everything)) {
    return 'no reply within the timeout — a free tier takes about a minute to wake from its 15-minute spin-down; rerun with a longer --timeout';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `the hostname did not resolve (${code}) — check the URL for a typo, and whether the service exists yet`;
  }
  if (code === 'ECONNREFUSED') {
    return 'nothing is listening there (ECONNREFUSED) — check the URL and port against the host\'s dashboard';
  }
  if (/CERT|TLS|SSL/i.test(everything)) {
    return `the TLS handshake failed (${detail}) — check the service URL rather than the certificate`;
  }
  return `the request failed: ${detail}`;
}

// --- config ------------------------------------------------------------------

/** Minimal KEY=value reader, same shape as the one in scripts/check-turn.mjs. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const trimSlash = (value) => String(value ?? '').trim().replace(/\/+$/, '');

/** An empty environment variable has to fall through to the next source, not win. */
const firstNonEmpty = (...values) => values.find((value) => trimSlash(value) !== '') ?? '';

/** `npm run verify:demo -- api.example.com` should not need a scheme typed out. */
function asUrl(value, label) {
  const raw = trimSlash(value);
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    fail(`${label} is not a URL: ${value}`);
    return null;
  }
}

const USAGE = `
Usage: npm run verify:demo [options]

  --api <url>        base URL of the deployed API
                     (default: DEMO_API_URL, then VITE_API_URL from client/.env)
  --client <url>     the deployed client URL, to check that a room refresh works
  --origin <url>     the origin a browser will come from
                     (default: --client, then APP_BASE_URL from server/.env)
  --timeout <ms>     how long to wait for one reply (default: 20000)
  --target <ms>      the load time the rubric asks for (default: 5000)
  --json             print the result as JSON instead
  -h, --help         show this
`;

function parseArgs(argv) {
  const options = { api: null, client: null, origin: null, timeoutMs: 20000, targetMs: 5000, json: false };
  const takesValue = { '--api': 'api', '--client': 'client', '--origin': 'origin', '--timeout': 'timeoutMs', '--target': 'targetMs' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      say(USAGE);
      process.exit(0);
    } else if (arg === '--json') {
      options.json = true;
    } else if (takesValue[arg]) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      options[takesValue[arg]] = value;
      i += 1;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, ...rest] = arg.split('=');
      if (!takesValue[flag]) fail(`unknown option ${flag}`);
      options[takesValue[flag]] = rest.join('=');
    } else {
      fail(`unknown option ${arg}`);
    }
  }

  options.timeoutMs = Number(options.timeoutMs);
  options.targetMs = Number(options.targetMs);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) fail('--timeout must be a positive number of milliseconds');
  if (!Number.isFinite(options.targetMs) || options.targetMs <= 0) fail('--target must be a positive number of milliseconds');
  return options;
}

// --- checks ------------------------------------------------------------------

const step = (name, ok, detail, extra = {}) => ({ name, ok, detail, ...extra });

/**
 * The health endpoint, retried the way the keep-alive workflow retries it: a
 * free tier that has spun down needs about a minute and may answer 502 or 503
 * while it wakes, and a single probe would report a working deployment as broken.
 */
async function checkHealth(api, options) {
  const attempts = 3;
  let response = null;
  let total = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Sequential on purpose: retrying a wake-up only means anything in order.
    // eslint-disable-next-line no-await-in-loop
    response = await request(`${api}/api/health`, { timeoutMs: options.timeoutMs });
    total += response.ms;
    if (response.ok && response.status === 200) break;
    if (attempt < attempts) {
      // Wait about as long as one request is allowed to take before retrying: a
      // caller that shortened --timeout is in a hurry, and a real cold start is
      // what --timeout exists for.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, Math.min(5000, options.timeoutMs)));
    }
  }

  const seconds = (total / 1000).toFixed(1);
  const steps = [];

  if (!response.ok) {
    steps.push(step('health', false, connectionHint(response)));
    return steps;
  }

  if (response.status !== 200) {
    steps.push(
      step(
        'health',
        false,
        `HTTP ${response.status} after ${seconds}s — the service is not answering a health check`,
        {
          hint:
            response.status === 502 || response.status === 503
              ? 'the process is up but not ready: usually MONGO_URI (wrong string, or Atlas Network Access not allowing 0.0.0.0/0 for Render) — read the Render logs'
              : 'check the Render logs; the deploy may have failed or be mid-restart',
        }
      )
    );
    return steps;
  }

  const body = response.json;
  if (!body || body.status !== 'ok') {
    steps.push(step('health', false, `200 but the body is not a health payload: ${response.text.slice(0, 120)}`));
    return steps;
  }
  if (body.service !== 'intellimeet-api') {
    steps.push(
      step('health', false, `200 from "${body.service ?? 'an unnamed service'}" — this URL is not the IntelliMeet API`)
    );
    return steps;
  }

  // The one number the rubric names: "<5s initial load". A cold free tier misses
  // it by an order of magnitude, which is the whole reason the keep-alive
  // workflow exists.
  const slow = total > options.targetMs;
  steps.push(
    step(
      'health',
      true,
      `200 in ${seconds}s — ${body.service}`,
      slow
        ? {
            hint: `slower than the ${options.targetMs / 1000}s target, which reads as a broken app to a first-time visitor: set DEMO_API_URL so .github/workflows/keepalive.yml pings it every 10 minutes, or point a free external pinger at it`,
          }
        : {}
    )
  );
  return steps;
}

/** The preflight a browser sends before a cross-origin POST, with the client's origin. */
async function checkCors(api, origin, options) {
  if (!origin) {
    return [step('cors', false, 'no origin to test with — pass --origin or --client', { soft: true })];
  }

  const response = await request(`${api}/api/auth/demo`, {
    method: 'OPTIONS',
    timeoutMs: options.timeoutMs,
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });

  if (!response.ok) {
    return [step('cors', false, `${connectionHint(response)} (while asking about ${origin})`)];
  }

  const allowed = response.headers.get('access-control-allow-origin');
  const credentials = response.headers.get('access-control-allow-credentials');

  if (allowed !== origin) {
    return [
      step('cors', false, `the API answered ${response.status} but allowed "${allowed ?? 'nothing'}" instead of ${origin}`, {
        hint: `set CLIENT_ORIGIN on the API to ${origin} — exactly, no trailing slash, comma-separated for more than one — and redeploy. It is sync:false in render.yaml, so it is set in the dashboard, not the file.`,
      }),
    ];
  }
  if (credentials !== 'true') {
    return [
      step('cors', false, `allowed ${origin} but without Access-Control-Allow-Credentials`, {
        hint: 'the API enables credentials in src/index.js; a proxy stripping the header would explain this',
      }),
    ];
  }

  return [step('cors', true, `preflight allowed ${origin} with credentials`)];
}

/**
 * Click "Try the demo": one POST with no body, from the client's origin, and read
 * back the room it landed in.
 */
async function checkDemo(api, origin, options) {
  const response = await request(`${api}/api/auth/demo`, {
    method: 'POST',
    body: {},
    timeoutMs: options.timeoutMs,
    ...(origin ? { headers: { Origin: origin } } : {}),
  });

  const steps = [];
  if (!response.ok) {
    steps.push(step('demo', false, `the one-click demo did not answer: ${connectionHint(response)}`));
    return { steps, guest: null };
  }

  if (response.status === 403) {
    steps.push(
      step('demo', false, '403 — the demo path is switched off on this deployment', {
        hint: 'DEMO_LOGIN_ENABLED=false: unset it (or set it to true) on the API host and redeploy. This is the path the "core functionality without sign-up" rubric weight is about.',
      })
    );
    return { steps, guest: null };
  }
  if (response.status === 429) {
    steps.push(
      step('demo', false, '429 — the one-click path is rate limited right now', {
        hint: 'either genuinely busy, or TRUST_PROXY is off so every visitor behind the platform proxy shares one IP budget. A judge seeing this reads it as a broken button.',
      })
    );
    return { steps, guest: null };
  }
  if (response.status >= 500) {
    steps.push(
      step('demo', false, `${response.status} — the API could not provision a guest`, {
        hint: 'read the host logs. A missing JWT_SECRET fails every session route, and a missing MONGO_URI fails writes.',
      })
    );
    return { steps, guest: null };
  }
  if (response.status !== 200 || !response.json?.token || !response.json?.roomCode) {
    steps.push(
      step('demo', false, `${response.status} with an unexpected body: ${response.text.slice(0, 120)}`)
    );
    return { steps, guest: null };
  }

  const guest = { token: response.json.token, roomCode: response.json.roomCode, ms: response.ms };
  steps.push(
    step('demo', true, `one click provisioned a guest in room ${color.bold(guest.roomCode)} (${(guest.ms / 1000).toFixed(1)}s)`)
  );
  return { steps, guest };
}

/** The room a guest lands in must arrive populated, or the demo opens empty. */
async function checkSeededRoom(api, guest, options) {
  const response = await request(`${api}/api/meetings/room/${guest.roomCode}`, {
    headers: { Authorization: `Bearer ${guest.token}` },
    timeoutMs: options.timeoutMs,
  });

  if (!response.ok) return [step('seeded', false, `${connectionHint(response)} while reading room ${guest.roomCode}`)];
  if (response.status !== 200) {
    return [step('seeded', false, `reading room ${guest.roomCode} answered ${response.status}: ${response.text.slice(0, 120)}`)];
  }

  const meeting = response.json;
  const chat = meeting.chatMessages?.length ?? 0;
  const items = meeting.actionItems?.length ?? 0;
  const hasSummary = typeof meeting.summary === 'string' && meeting.summary.trim().length > 0;

  if (chat === 0 || !hasSummary || items === 0) {
    return [
      step('seeded', false, `the room arrived with ${chat} chat message(s), ${items} action item(s) and ${hasSummary ? 'a summary' : 'no summary'}`, {
        hint: 'the sample meeting behind services/demoContent.js is what fills those; an empty room makes the chat and AI tabs look broken on arrival',
      }),
    ];
  }

  return [
    step('seeded', true, `the room arrives populated: ${chat} chat message(s), a summary, ${items} action item(s)`, {
      participants: meeting.participants?.length ?? 0,
      meetingId: meeting._id,
    }),
  ];
}

/**
 * The other half of "no sign-up": a room link has to turn a stranger into a second
 * participant. Same endpoint the login page uses when there is a room code in the
 * URL.
 */
async function checkGuestLink(api, origin, guest, before, options) {
  const response = await request(`${api}/api/auth/demo`, {
    method: 'POST',
    body: { roomCode: guest.roomCode },
    timeoutMs: options.timeoutMs,
    ...(origin ? { headers: { Origin: origin } } : {}),
  });

  if (!response.ok) return [step('link', false, `joining by room code failed: ${connectionHint(response)}`)];
  if (response.status !== 200 || response.json?.roomCode !== guest.roomCode) {
    return [
      step('link', false, `POST /api/auth/demo { roomCode } answered ${response.status} with room ${response.json?.roomCode ?? 'nothing'}`),
    ];
  }

  const after = await request(`${api}/api/meetings/room/${guest.roomCode}`, {
    headers: { Authorization: `Bearer ${response.json.token}` },
    timeoutMs: options.timeoutMs,
  });
  const participants = after.json?.participants?.length;

  if (!after.ok || after.status !== 200 || typeof participants !== 'number' || participants <= before) {
    return [
      step('link', false, `a second visitor got a token but the room still shows ${participants ?? before} participant(s)`, {
        hint: 'a shared link has to add the visitor as a participant of that room — see joinGuestToRoom in services/guest.js',
      }),
    ];
  }

  return [step('link', true, `a second visitor joined the same room with no account (${before} → ${participants} participants)`)];
}

/** A refresh on a room URL is the most likely 404 a visitor can find. */
async function checkClientDeepLink(client, guest, options) {
  if (!client) {
    return [step('client', false, 'no client URL to check — pass --client <url>', { soft: true })];
  }

  const response = await request(`${client}/room/${guest.roomCode}`, { timeoutMs: options.timeoutMs });

  if (!response.ok) return [step('client', false, connectionHint(response))];
  if (response.status !== 200) {
    return [
      step('client', false, `a room URL answered ${response.status} on the client host`, {
        hint: 'the client host needs an SPA rewrite of unknown paths to index.html — vercel.json has it; other hosts need their own rules',
      }),
    ];
  }
  if (!/<div[^>]+id=["']root["']/i.test(response.text)) {
    return [
      step('client', false, 'the room URL returned 200 but not the app shell', {
        hint: 'the response is not the built index.html — check the host\'s output directory (client/dist) and its rewrite rule',
      }),
    ];
  }

  return [step('client', true, `/room/${guest.roomCode} served the app shell, so a refresh works`)];
}

// --- main --------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const clientEnv = readEnvFile(path.resolve(root, 'client/.env'));
  const serverEnv = readEnvFile(path.resolve(root, 'server/.env'));

  const api = asUrl(
    firstNonEmpty(options.api, process.env.DEMO_API_URL, process.env.VITE_API_URL, clientEnv.VITE_API_URL),
    '--api'
  );
  const client = asUrl(firstNonEmpty(options.client, process.env.DEMO_CLIENT_URL), '--client');
  const origin = asUrl(
    firstNonEmpty(options.origin, client, process.env.APP_BASE_URL, serverEnv.APP_BASE_URL),
    '--origin'
  );

  if (!options.json) {
    say('');
    say(`  ${color.bold('IntelliMeet')} ${color.dim('— does the deployed demo actually work?')}`);
  }

  if (!api) {
    fail(
      'No API URL. Pass --api https://your-api.onrender.com, set DEMO_API_URL, or fill VITE_API_URL in client/.env.'
    );
  }

  const results = [];
  // Reported as a footnote rather than a step: the run leaves real data behind,
  // and saying so is the difference between a tool and a surprise.
  let created = null;

  const health = await checkHealth(api, options);
  results.push(...health);

  // Everything after this needs a live API; say so once instead of five times.
  if (health[0].ok) {
    results.push(...(await checkCors(api, origin, options)));

    const { steps: demoSeps, guest } = await checkDemo(api, origin, options);
    results.push(...demoSeps);

    if (guest) {
      created = '1 guest room + 2 guest accounts';
      const seeded = await checkSeededRoom(api, guest, options);
      results.push(...seeded);
      results.push(...(await checkGuestLink(api, origin, guest, seeded[0].participants ?? 0, options)));
      results.push(...(await checkClientDeepLink(client, guest, options)));
    }
  }

  if (options.json) {
    const failed = results.filter((result) => !result.ok && !result.soft);
    say(JSON.stringify({ api, client, origin, ok: failed.length === 0, steps: results }, null, 2));
    process.exit(failed.length === 0 ? 0 : 1);
  }

  say('');
  for (const result of results) {
    const mark = result.ok ? color.ok('✓') : result.soft ? color.warn('·') : color.bad('✗');
    say(`  ${mark} ${paint('2', result.name.padEnd(9))}${result.detail}`);
    if (result.hint) say(`    ${color.warn('→')} ${color.warn(result.hint)}`);
  }

  const hard = results.filter((result) => !result.soft);
  const passed = hard.filter((result) => result.ok).length;
  const failed = hard.length - passed;

  say('');
  say(
    `  ${failed === 0 ? color.ok('✓') : color.bad('✖')} ${passed} of ${hard.length} checks passed` +
      (failed ? ` — ${failed} to fix above` : '.')
  );

  if (api.startsWith('http://') && origin?.startsWith('https://')) {
    say(
      `  ${color.warn('!')} the API is http:// and the client is https://: the browser blocks that as mixed content.`
    );
  }
  if (created) {
    say(`  ${color.dim('data created')}  ${created}, taken back out by guest retention (GUEST_RETENTION_HOURS).`);
  }

  say('');
  say(`  ${color.dim('Not covered')}  whether two *different* networks can reach each other: that needs two devices on two`);
  say('                connections (see the two-network smoke test in the README) and a TURN relay,');
  say('                which `npm run check:turn` can verify from one machine.');
  say('');

  process.exit(failed === 0 ? 0 : 1);
}

export { asUrl, checkDemo, parseArgs, readEnvFile };

// Importing this file (from its test) must not run the checks.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    say('');
    say(`${color.bad('✖')} ${err.stack || err.message}`);
    process.exit(2);
  });
}
