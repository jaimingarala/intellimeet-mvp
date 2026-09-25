/**
 * The observability surface: one id per request, one log line per request, one
 * shape for every failure, and no secrets in any of it.
 *
 * The unit half pins the decisions that are easy to get subtly wrong (which
 * status a body-parser rejection maps to, what "scrubbed" means, when a stack is
 * kept). The integration half drives the running server, because the value of
 * this code is entirely in what a real request produces — a log line with the
 * right id, and an error body a user can quote back.
 *
 * `console` is mocked for the whole suite (LOG_LEVEL is `silent` in the harness)
 * so the assertions are about the log the server would have written.
 */
const { describe, test, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const { start, stop, api, signup, baseUrl } = require('./helpers/app.js');
const { sleep } = require('./helpers/sockets.js');
const { classify } = require('../src/middleware/observability.js');
const { activeLevel, describeError, outputFormat, scrub } = require('../src/lib/logger.js');

/** Everything the server logged, in order. */
const lines = [];
const record = (...args) => lines.push(args.join(' '));

const entries = () =>
  lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const entryFor = (requestId) => entries().find((entry) => entry.requestId === requestId);

describe('the logger', () => {
  test('redacts anything whose name looks like a credential', () => {
    const scrubbed = scrub({
      password: 'hunter2',
      passwordHash: '$2a$10$notThis',
      token: 'abc',
      verificationToken: 'abc',
      authorization: 'Bearer abc',
      apiKey: 'sk-abc',
      cookie: 'session=1',
      credential: 'abc',
      // Kept, because these are the fields that make a log useful.
      userId: 'u1',
      status: 404,
    });

    for (const key of [
      'password',
      'passwordHash',
      'token',
      'verificationToken',
      'authorization',
      'apiKey',
      'cookie',
      'credential',
    ]) {
      assert.equal(scrubbed[key], '[redacted]', `${key} should be redacted`);
    }
    assert.equal(scrubbed.userId, 'u1');
    assert.equal(scrubbed.status, 404);
  });

  test('truncates long strings rather than logging a whole body', () => {
    const long = 'x'.repeat(4000);
    const scrubbed = scrub({ body: long });

    assert.ok(scrubbed.body.length < 600);
    assert.match(scrubbed.body, /\(4000 chars\)$/);
    assert.equal(scrub('short'), 'short');
  });

  test('stops descending rather than turning a deep object into a stack overflow', () => {
    const deep = { a: { b: { c: { d: { e: 'too far' } } } } };

    // Three levels in, one level out: enough for `{ err: { cause: {…} } }`.
    assert.equal(scrub(deep).a.b.c, '[too deep]');
    assert.equal(
      scrub({ err: { cause: { code: 'ECONNREFUSED' } } }).err.cause.code,
      'ECONNREFUSED',
    );
    assert.deepEqual(scrub({ list: [1, 2, 3] }).list, [1, 2, 3]);
    assert.equal(scrub({ list: Array.from({ length: 25 }, (_, i) => i) }).list.length, 21);
    assert.equal(scrub({ list: Array.from({ length: 25 }, (_, i) => i) }).list[20], '…(5 more)');
  });

  test('describes an error, including the cause a wrapped fetch failure hides', () => {
    const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
      code: 'ECONNREFUSED',
    });
    const err = new Error('fetch failed');
    err.cause = cause;
    err.type = 'entity.too.large';

    const described = describeError(err);

    assert.equal(described.name, 'Error');
    assert.equal(described.message, 'fetch failed');
    assert.equal(described.type, 'entity.too.large');
    assert.equal(described.cause.code, 'ECONNREFUSED');
    // The cause's stack is dropped: one stack per entry is enough to find it.
    assert.equal(described.cause.stack, undefined);

    assert.equal(describeError(err, { stack: false }).stack, undefined);
    assert.equal(describeError('just a string').message, 'just a string');
  });

  test('level and format come from the environment, per call', () => {
    assert.equal(activeLevel({}), 20);
    assert.equal(activeLevel({ LOG_LEVEL: 'debug' }), 10);
    assert.equal(activeLevel({ LOG_LEVEL: 'WARN' }), 30);
    // A typo must not turn on debugging in production.
    assert.equal(activeLevel({ LOG_LEVEL: 'verbose' }), 20);
    assert.equal(activeLevel({ LOG_LEVEL: 'silent' }), Number.POSITIVE_INFINITY);

    assert.equal(outputFormat({ NODE_ENV: 'production' }), 'json');
    assert.equal(outputFormat({}), 'pretty');
    assert.equal(outputFormat({ NODE_ENV: 'production', LOG_FORMAT: 'pretty' }), 'pretty');
  });
});

describe('error classification', () => {
  test('a body over the JSON limit is a 413, not a server fault', () => {
    assert.deepEqual(classify({ type: 'entity.too.large' }), {
      status: 413,
      message: 'Request body is too large.',
    });
    assert.equal(classify({ type: 'entity.parse.failed' }).status, 400);
  });

  test('a status the middleware attached passes through, with a sentence for it', () => {
    assert.equal(classify(Object.assign(new Error('nope'), { status: 401 })).status, 401);
    assert.equal(classify(Object.assign(new Error('nope'), { statusCode: 429 })).status, 429);
    assert.equal(
      classify(Object.assign(new Error('nope'), { status: 418 })).message,
      'Request failed.',
    );
  });

  test('anything else is a 500 whose message is not the error', () => {
    const classified = classify(new Error('Cannot read properties of undefined (reading "host")'));

    assert.deepEqual(classified, { status: 500, message: 'Internal server error.' });
    assert.equal(classify(undefined).status, 500);
  });
});

describe('a running server', () => {
  let host;
  let headers;

  before(async () => {
    await start();
    // The suite is about the logging, so turn it on and make it assertable.
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_FORMAT = 'json';
    mock.method(console, 'log', record);
    mock.method(console, 'warn', record);
    mock.method(console, 'error', record);
    host = await signup('Observability', 'obs@test.dev');
  });

  after(async () => {
    mock.restoreAll();
    process.env.LOG_LEVEL = 'silent';
    await stop();
  });

  test('the response carries the id the log line will have', async () => {
    const res = await fetch(`${baseUrl()}/api/health`, {
      headers: { 'x-request-id': 'trace-abc-1' },
    });
    headers = { id: res.headers.get('x-request-id') };
    await res.json();
    await sleep(50);

    assert.equal(headers.id, 'trace-abc-1');

    const entry = entryFor('trace-abc-1');
    assert.equal(entry.msg, 'request');
    assert.equal(entry.level, 'info');
    assert.equal(entry.method, 'GET');
    assert.equal(entry.path, '/api/health');
    assert.equal(entry.status, 200);
    assert.equal(typeof entry.durationMs, 'number');
    assert.ok(entry.durationMs >= 0);
    assert.ok(entry.time, 'an entry is timestamped');
  });

  test('an id we would not want to echo is replaced with one of our own', async () => {
    const res = await fetch(`${baseUrl()}/api/health`, {
      headers: { 'x-request-id': 'x'.repeat(200) },
    });
    const id = res.headers.get('x-request-id');
    await res.json();

    assert.notEqual(id, 'x'.repeat(200));
    assert.match(id, /^[0-9a-f-]{36}$/);
  });

  test('a 404 is a warning in the log and the same shape on the wire', async () => {
    const res = await fetch(`${baseUrl()}/api/no-such-route`);
    const id = res.headers.get('x-request-id');
    const body = await res.json();
    await sleep(50);

    assert.equal(res.status, 404);
    assert.deepEqual(body, { error: 'Not found.', requestId: id });

    const entry = entryFor(id);
    assert.equal(entry.level, 'warn');
    assert.equal(entry.status, 404);
  });

  test('a body over the 1 MB limit is a 413 with an id, not an opaque 500', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'x'.repeat(1_100_000) },
    });
    await sleep(50);

    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'Request body is too large.');
    assert.ok(res.body.requestId);

    const entry = entryFor(res.body.requestId);
    assert.equal(entry.level, 'warn');
    assert.equal(entry.err.type, 'entity.too.large');
  });

  test('malformed JSON is a 400, and the tag survives into the log', async () => {
    const res = await fetch(`${baseUrl()}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"email": "nope"',
    });
    const body = await res.json();
    await sleep(50);

    assert.equal(res.status, 400);
    assert.equal(body.error, 'Malformed JSON body.');

    const entry = entryFor(body.requestId);
    assert.equal(entry.err.type, 'entity.parse.failed');
    // A 4xx is not our fault, so no stack is kept for it.
    assert.equal(entry.err.stack, undefined);
  });

  test('nothing a client sent, and nothing secret, reaches the log', async () => {
    const res = await api('/api/auth/login', {
      method: 'POST',
      headers: { Authorization: 'Bearer ey-really-secret-token' },
      body: { email: 'nobody@test.dev', password: 'hunter2-should-not-be-logged' },
    });
    await sleep(50);

    assert.equal(res.status, 401);
    const written = lines.join('\n');
    assert.equal(written.includes('hunter2-should-not-be-logged'), false);
    assert.equal(written.includes('ey-really-secret-token'), false);
    // The response is not a place for it either.
    assert.equal(res.text.includes('hunter2-should-not-be-logged'), false);
  });

  test('a browser preflight from the client origin still succeeds', async () => {
    // The middleware order changed in this phase (the request id and the request
    // log now run before CORS), so this is the check that they didn't get in
    // each other's way.
    const res = await fetch(`${baseUrl()}/api/meetings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });

    assert.ok(res.status === 200 || res.status === 204, `unexpected status ${res.status}`);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok(res.headers.get('x-request-id'));
  });

  test('an origin that is not allowed gets no CORS header, and no server fault', async () => {
    // This pins what actually happens, which is easy to get wrong when you
    // assume `cors` rejects: it does not raise an error, it just omits the
    // header, and the browser is what refuses. A 4xx/5xx here would mean a
    // setting mistake is being reported as a broken request.
    const res = await fetch(`${baseUrl()}/api/health`, {
      headers: { Origin: 'https://not-the-client.example' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    await res.json();
  });

  test("the socket transport's own traffic never reaches this logger", async () => {
    // engine.io takes the server's `request` event and forwards only the
    // requests it doesn't own, so a socket connection — the handshake, then a
    // poll every ~25 seconds for a client that can't upgrade to WebSocket — is
    // absent from the request log by construction rather than by filtering.
    // Pinned because "no lines" is also what a broken logger looks like, so the
    // client below has to actually connect.
    const before = entries().length;
    const socket = await new Promise((resolve, reject) => {
      const client = ioClient(baseUrl(), {
        auth: { token: host.token },
        transports: ['polling'],
        forceNew: true,
      });
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });
    await sleep(100);

    assert.equal(socket.connected, true, 'a polling client should connect');
    assert.equal(
      entries()
        .slice(before)
        .some((entry) => entry.path?.startsWith('/socket.io')),
      false,
      'transport requests should not appear in the request log',
    );

    socket.disconnect();
  });

  test('the id is logged with whoever was signed in', async () => {
    const res = await fetch(`${baseUrl()}/api/meetings`, {
      headers: { Authorization: `Bearer ${host.token}`, 'x-request-id': 'trace-meetings-1' },
    });
    await res.json();
    await sleep(50);

    assert.equal(entryFor('trace-meetings-1').userId, host.user.id);
  });
});

describe('the error handler itself', () => {
  const {
    errorHandler,
    notFoundHandler,
    requestContext,
  } = require('../src/middleware/observability.js');

  function fakeRes() {
    return {
      headersSent: false,
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
      set(name, value) {
        this.headers = { ...this.headers, [name]: value };
        return this;
      },
      end() {
        this.ended = true;
        return this;
      },
    };
  }

  test('a crash becomes a 500 with an id, and the stack stays in the log', () => {
    const req = { id: 'req-boom', method: 'POST', path: '/api/boom', user: { id: 'u1' } };
    const res = fakeRes();

    errorHandler(new Error('database exploded at line 42'), req, res, () => {});

    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: 'Internal server error.', requestId: 'req-boom' });
    assert.equal(JSON.stringify(res.body).includes('database exploded'), false);
    assert.equal(JSON.stringify(res.body).includes('line 42'), false);
  });

  test('it closes out rather than trying to answer after headers were sent', () => {
    const req = { id: 'req-late', method: 'GET', path: '/api/stream' };
    const res = fakeRes();
    res.headersSent = true;

    errorHandler(new Error('too late'), req, res, () => {});

    assert.equal(res.ended, true);
    assert.equal(res.body, undefined);
  });

  test('the 404 handler uses the id the request context assigned', () => {
    const req = { headers: {}, get: () => undefined };
    const res = fakeRes();

    requestContext()(req, res, () => {});
    notFoundHandler(req, res);

    assert.equal(res.headers['X-Request-Id'], req.id);
    assert.deepEqual(res.body, { error: 'Not found.', requestId: req.id });
  });
});
