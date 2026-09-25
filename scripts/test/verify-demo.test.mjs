/**
 * Pins what `npm run verify:demo` reports about a deployment it cannot see.
 *
 * The script's whole value is that it names the thing to fix, so these tests run
 * a fake deployment that is wrong in specific ways and assert that the *reason*
 * survives — not merely that the exit code is non-zero. A checker that says "✗"
 * and stops is no better than the browser console it is meant to replace.
 *
 * The fake API is deliberately literal about CORS: it answers the preflight with
 * whatever origin it was configured to allow, the way a real one would when
 * CLIENT_ORIGIN disagrees with where the client actually lives.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify-demo.mjs');

/** A deployment that behaves, with the behaviour knobs a test wants to break. */
function createApi({ allowedOrigin, demoStatus = 200, seeded = true } = {}) {
  const rooms = new Map();
  const state = { demoCalls: 0, preflights: 0 };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const allow = allowedOrigin === undefined ? req.headers.origin : allowedOrigin;

    if (allow) res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

    if (req.method === 'OPTIONS') {
      state.preflights += 1;
      res.writeHead(204).end();
      return;
    }

    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'intellimeet-api',
          time: new Date().toISOString(),
        }),
      );
      return;
    }

    if (url.pathname === '/api/auth/demo' && req.method === 'POST') {
      state.demoCalls += 1;
      if (demoStatus !== 200) {
        res.writeHead(demoStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'nope' }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        const roomCode = body.roomCode ?? 'abcd-2345';
        const room = rooms.get(roomCode) ?? {
          _id: 'm1',
          roomCode,
          title: 'IntellMeet live demo',
          participants: [],
          chatMessages: seeded
            ? [
                { senderName: 'Guest', text: 'hi' },
                { senderName: 'Guest', text: 'there' },
              ]
            : [],
          summary: seeded ? 'A short demo meeting.' : '',
          actionItems: seeded ? [{ text: 'Ship it', assignee: 'Unassigned', done: false }] : [],
        };
        room.participants.push(`guest-${room.participants.length + 1}`);
        rooms.set(roomCode, room);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'guest-token', user: { name: 'Guest' }, roomCode }));
      });
      return;
    }

    if (url.pathname.startsWith('/api/meetings/room/') && req.headers.authorization) {
      const roomCode = url.pathname.split('/').pop();
      const room = rooms.get(roomCode);
      if (!room) {
        res
          .writeHead(404, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: 'no room' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(room));
      return;
    }

    res
      .writeHead(404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'Not found.' }));
  });

  return { server, state };
}

/** Enough of a client host: the app shell, or the 404 of a missing SPA rewrite. */
function createClient({ deepLinks = true } = {}) {
  const server = http.createServer((req, res) => {
    if (!deepLinks && req.url !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });

  return { server };
}

function listen(server) {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(server.address().port)),
  );
}

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, ...args], {
      env: {
        ...process.env,
        NO_COLOR: '1',
        DEMO_API_URL: '',
        DEMO_CLIENT_URL: '',
        VITE_API_URL: '',
        APP_BASE_URL: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

/** Wire up one fake deployment, run the checker against it, and report back. */
async function verifyAgainst({ api: apiOptions, client: clientOptions, json = false } = {}) {
  const api = createApi(apiOptions);
  const client = createClient(clientOptions);
  const apiPort = await listen(api.server);
  const clientPort = await listen(client.server);

  try {
    const args = [
      '--api',
      `http://127.0.0.1:${apiPort}`,
      '--client',
      `http://127.0.0.1:${clientPort}`,
      '--timeout',
      '3000',
    ];
    if (json) args.push('--json');
    return { ...(await run(args)), state: api.state };
  } finally {
    api.server.close();
    client.server.close();
  }
}

test('a deployment that works passes every check', async () => {
  const { code, stdout, state } = await verifyAgainst();

  assert.equal(code, 0);
  assert.match(stdout, /✓ health\s+200 in/);
  assert.match(stdout, /✓ cors\s+preflight allowed http:\/\/127\.0\.0\.1:\d+ with credentials/);
  assert.match(stdout, /✓ demo\s+one click provisioned a guest in room abcd-2345/);
  assert.match(
    stdout,
    /✓ seeded\s+the room arrives populated: 2 chat message\(s\), a summary, 1 action item\(s\)/,
  );
  assert.match(
    stdout,
    /✓ link\s+a second visitor joined the same room with no account \(1 → 2 participants\)/,
  );
  assert.match(stdout, /✓ client\s+\/room\/abcd-2345 served the app shell/);
  assert.match(stdout, /6 of 6 checks passed/);

  // Two guests, one room: the path a visitor and their invitee actually take.
  assert.equal(state.demoCalls, 2);
  assert.equal(state.preflights, 1);
});

test('an origin the API does not allow is reported as CLIENT_ORIGIN, not as a CORS error', async () => {
  const { code, stdout } = await verifyAgainst({
    api: { allowedOrigin: 'https://elsewhere.example' },
  });

  assert.equal(code, 1);
  assert.match(
    stdout,
    /✗ cors\s+the API answered 204 but allowed "https:\/\/elsewhere\.example" instead of/,
  );
  assert.match(stdout, /→ set CLIENT_ORIGIN on the API to http:\/\/127\.0\.0\.1:\d+/);
});

test('a switched-off demo path is named as the demo switch, not as a failed request', async () => {
  const { code, stdout } = await verifyAgainst({ api: { demoStatus: 403 } });

  assert.equal(code, 1);
  assert.match(stdout, /✗ demo\s+403 — the demo path is switched off on this deployment/);
  assert.match(stdout, /DEMO_LOGIN_ENABLED=false/);

  // Nothing downstream of the failed click is reported as a failure of its own.
  assert.doesNotMatch(stdout, /✗ seeded/);
  assert.doesNotMatch(stdout, /✗ client/);
});

test('a rate-limited demo button is reported with the shared-budget cause', async () => {
  const { code, stdout } = await verifyAgainst({ api: { demoStatus: 429 } });

  assert.equal(code, 1);
  assert.match(stdout, /✗ demo\s+429/);
  assert.match(stdout, /TRUST_PROXY is off/);
});

test('a guest room that arrives empty is reported as the seeded content', async () => {
  const { code, stdout } = await verifyAgainst({ api: { seeded: false } });

  assert.equal(code, 1);
  assert.match(
    stdout,
    /✗ seeded\s+the room arrived with 0 chat message\(s\), 0 action item\(s\) and no summary/,
  );
  assert.match(stdout, /services\/demoContent\.js/);
});

test('a client host without the SPA rewrite is reported as the rewrite', async () => {
  const { code, stdout } = await verifyAgainst({ client: { deepLinks: false } });

  assert.equal(code, 1);
  assert.match(stdout, /✗ client\s+a room URL answered 404 on the client host/);
  assert.match(stdout, /SPA rewrite of unknown paths to index\.html/);

  // The API half still passed — the report has to keep the two halves apart.
  assert.match(stdout, /✓ health/);
  assert.match(stdout, /✓ demo/);
});

test('a dead API is reported as a dead API, without pretending the rest of the demo ran', async () => {
  // A port nothing is listening on: the free tier that never woke up, or the
  // service URL that was never right.
  const { code, stdout } = await run(['--api', 'http://127.0.0.1:9', '--timeout', '1000']);

  assert.equal(code, 1);
  assert.match(stdout, /✗ health\s+\S/); // some actionable reason, not a bare "failed"
  assert.match(stdout, /\d+ to fix above/);
  assert.match(stdout, /0 of 1 checks passed/);
  // Five meaningless follow-up failures would bury the one that matters.
  assert.doesNotMatch(stdout, /✗ cors/);
  assert.doesNotMatch(stdout, /✗ demo/);
});

test('--json carries the same verdict for a script to read', async () => {
  const { code, stdout } = await verifyAgainst({ json: true });

  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.steps.length, 6);
  assert.deepEqual(
    report.steps.map((s) => s.name),
    ['health', 'cors', 'demo', 'seeded', 'link', 'client'],
  );
});
