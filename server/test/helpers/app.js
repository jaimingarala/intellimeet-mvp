/**
 * Test harness: boots the *real* server entry point (src/index.js) with the
 * models stubbed, on a free port, and exposes small HTTP / JWT / socket helpers.
 *
 * Booting src/index.js rather than re-assembling an app from the routers means
 * these suites also cover the real middleware order, the 404 and error
 * handlers, and the Socket.io registration. The only pieces replaced are the
 * ones that need infrastructure we don't have in CI (MongoDB).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
// Belt and braces: dotenv loads server/.env on import, so pin these first —
// dotenv never overwrites a variable that is already set. Tests must never
// make a paid OpenAI call, and must never bind the port from .env.
process.env.OPENAI_API_KEY = '';
process.env.PORT = '';
process.env.CLIENT_ORIGIN = 'http://localhost:5173';
// Empty means "enabled" (see services/guest.js), which is what the guest tests
// assert — a local .env that turned the path off must not fail the suite.
process.env.DEMO_LOGIN_ENABLED = '';
// The retention sweep would otherwise query the in-memory models on boot, and
// race suites that manipulate the store. Tests drive purgeStaleGuests directly.
process.env.GUEST_RETENTION_ENABLED = 'false';
process.env.GUEST_RETENTION_HOURS = '24';
// Generous, so a suite creating a handful of demo rooms never trips the cap;
// the capacity suite sets its own value per test.
process.env.DEMO_MAX_GUEST_ROOMS = '200';
// So the admin routes exist (they 404 without a token); the suite that checks
// that default clears this variable itself.
process.env.ADMIN_TOKEN = 'test-admin-token';
// Verification is on for the suites, whatever a local .env says — the claim
// suite asserts the gate, and the email suite turns it off itself for the case
// that exercises the escape hatch.
process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
// Never POST to a real mail provider from a test. With no transport the mailer
// falls back to its in-memory outbox, which is how the suites follow a link.
process.env.MAIL_WEBHOOK_URL = '';
process.env.MAIL_WEBHOOK_TOKEN = '';
// Deterministic links, so a test can assert the URL a recipient would click.
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_VERIFICATION_TTL_HOURS = '24';
// One file is one process, but a suite still shares a single IP budget across
// every signup, login and claim it makes. Generous here so a suite can only trip
// it on purpose; the limiter itself is asserted nowhere in these suites.
process.env.AUTH_RATE_LIMIT_MAX = '10000';
// The server logs one line per request, which would bury 134 suites' output.
// Off here, and `LOG_LEVEL=info npm test` turns it back on for a suite that is
// about the logging itself (see test/observability.test.js, which flips it).
process.env.LOG_LEVEL = 'silent';

const net = require('net');
const jwt = require('jsonwebtoken');

const { install } = require('./fake-db');

const store = install();

let baseUrl = null;
let serverStarted = false;
let io = null;

// src/index.js doesn't export its Socket.io instance, so wrap the module that
// registers it and keep a reference for a clean shutdown.
const socketModulePath = require.resolve('../../src/socket');
const socketModule = require(socketModulePath);
require.cache[socketModulePath].exports = {
  ...socketModule,
  registerSocketHandlers(ioServer) {
    io = ioServer;
    return socketModule.registerSocketHandlers(ioServer);
  },
};

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  // Deliberately sequential: each probe has to finish before the next.
  while (Date.now() < deadline) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastError = err;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`server did not become healthy: ${lastError?.message || 'timeout'}`);
}

async function start() {
  if (serverStarted) return baseUrl;

  process.env.PORT = String(await freePort());
  require('../../src/index.js'); // starts express + Socket.io on process.env.PORT

  baseUrl = `http://127.0.0.1:${process.env.PORT}`;
  await waitForHealth(baseUrl);
  serverStarted = true;
  return baseUrl;
}

async function stop() {
  if (io) io.close();
}

async function api(path, { method = 'GET', token, body, headers } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON responses (shouldn't happen) stay available as `text`.
  }
  return { status: res.status, body: parsed, text };
}

// Mirrors what routes/auth.js signs, so a test can mint a token for a user that
// doesn't exist (useful for "outsider" cases) without a signup round trip.
function tokenFor({ id, name = 'Test User' }) {
  return jwt.sign({ sub: id, name, email: `${id}@test.dev` }, process.env.JWT_SECRET, {
    expiresIn: '1h',
  });
}

async function signup(name, email, password = 'password123') {
  const res = await api('/api/auth/signup', { method: 'POST', body: { name, email, password } });
  return { status: res.status, token: res.body?.token, user: res.body?.user, body: res.body };
}

async function login(email, password) {
  const res = await api('/api/auth/login', { method: 'POST', body: { email, password } });
  return { status: res.status, token: res.body?.token, user: res.body?.user, body: res.body };
}

async function createMeeting(token, title = 'Test meeting') {
  const res = await api('/api/meetings', { method: 'POST', token, body: { title } });
  return res.body;
}

module.exports = {
  start,
  stop,
  api,
  tokenFor,
  signup,
  login,
  createMeeting,
  store,
  baseUrl: () => baseUrl,
};
