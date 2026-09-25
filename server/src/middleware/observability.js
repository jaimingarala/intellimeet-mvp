/**
 * Request observability, in three small middlewares.
 *
 *   1. `requestContext()` — give every request an id (its own, or the one the
 *      proxy in front passed along) and echo it back in `X-Request-Id`. That id
 *      is what ties a user's "it said 500" report to the exact log line, and it
 *      is returned in every error body for precisely that reason.
 *
 *   2. `requestLogger()` — one line per completed request: method, path, status,
 *      duration, id, who. This is the difference between "the demo is down" and
 *      "GET /api/health answered 503 for 12 minutes", and it is where a
 *      platform's log dashboard gets its signal.
 *
 *   3. `notFoundHandler()` / `errorHandler()` — the last two middlewares. The
 *      error handler turns whatever reaches it into one shape, including the
 *      thing Express' default handler gets wrong for an API: if you do not read
 *      `err.status`, a body over `express.json`'s limit is reported as a 500,
 *      and you go looking for a bug that does not exist. A stack trace is never
 *      in the response — only in the log.
 *
 * Nothing here writes to the response until it has to; a successful request is
 * untouched except for one header and one log line.
 */

const crypto = require('crypto');

const { describeError, log } = require('../lib/logger');

/** A client-supplied request id we are willing to echo. */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Failures Express doesn't give a status, keyed by the tag the middleware that
 * raised them attaches.
 */
const BODY_ERRORS = {
  'entity.too.large': { status: 413, message: 'Request body is too large.' },
  'entity.parse.failed': { status: 400, message: 'Malformed JSON body.' },
  'encoding.unsupported': { status: 415, message: 'Unsupported content encoding.' },
  'request.aborted': { status: 400, message: 'Request aborted before the body arrived.' },
};

/** The sentence a client gets for a status we didn't raise ourselves. */
const GENERIC_ERRORS = {
  400: 'Bad request.',
  401: 'Unauthorized.',
  403: 'Forbidden.',
  404: 'Not found.',
  405: 'Method not allowed.',
  408: 'Request timeout.',
  413: 'Request body is too large.',
  415: 'Unsupported media type.',
  429: 'Too many requests.',
};

/**
 * The status and the client-facing sentence for anything that reaches the error
 * handler. Exported so the mapping can be asserted without provoking each
 * failure through the whole stack.
 */
function classify(err) {
  if (err?.type && BODY_ERRORS[err.type]) return BODY_ERRORS[err.type];

  // Deliberately no branch for a rejected CORS origin. `cors` does not raise one:
  // for an origin it wasn't told about it simply omits
  // `Access-Control-Allow-Origin`, and the *browser* refuses to hand the response
  // to the page. Treating that as a server error would mean inventing a failure
  // to report, and CORS is not an access-control boundary anyway — a non-browser
  // client ignores it entirely, which is why every route authenticates on its
  // own. `allowedOrigins` still warns at boot about the case that is invisible:
  // a `*` origin, which the browser also refuses on a credentialed request.

  const status = Number(err?.status ?? err?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    return { status, message: GENERIC_ERRORS[status] || 'Request failed.' };
  }

  // Anything without a status is a bug in this codebase, and its message is for
  // us, not for whoever is being told the request failed.
  return { status: 500, message: 'Internal server error.' };
}

/** Per-request id: adopt the caller's if it is safe, otherwise mint one. */
function requestContext() {
  return function requestContextMiddleware(req, res, next) {
    const inbound = req.get('x-request-id');
    req.id = REQUEST_ID_SHAPE.test(inbound || '') ? inbound : crypto.randomUUID();
    res.set('X-Request-Id', req.id);
    next();
  };
}

/**
 * Log one line when the request finishes — including when the client hangs up,
 * which is what `close` catches and `finish` never does.
 *
 * Socket.io's own transport requests never appear here, and that is worth
 * knowing: engine.io takes the server's `request` event and only forwards the
 * ones it doesn't own, so its handshake and its ~25-second polling heartbeats
 * bypass Express entirely. The noisiest part of a real-time app is therefore
 * absent from this log by construction rather than by filtering.
 */
function requestLogger() {
  return function requestLoggerMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint();
    let logged = false;

    const done = () => {
      if (logged) return;
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

      log[level]('request', {
        requestId: req.id,
        // `req.path`, not the full URL: a query string can carry a token, and a
        // log is the wrong place for one.
        method: req.method,
        path: req.path,
        status,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.ip,
        userId: req.user?.id,
        // A client that disconnected mid-response: the status is whatever we had
        // reached, so say so rather than reporting a clean 200.
        ...(res.writableEnded ? {} : { aborted: true }),
      });
    };

    res.on('finish', done);
    res.on('close', done);
    next();
  };
}

/** The 404 for anything that matched no route. */
function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found.', requestId: req.id });
}

/**
 * The single error handler. Four-argument signature is how Express recognises it,
 * so the unused `_next` stays.
 */
function errorHandler(err, req, res, _next) {
  const { status, message } = classify(err);
  const scope = 'http';

  if (res.headersSent) {
    // Too late for a status: the response is already going out. Log it — this is
    // the shape of bug that shows up as a truncated response — and close.
    log.error('error after the response had already started', {
      scope,
      requestId: req.id,
      method: req.method,
      path: req.path,
      err: describeError(err),
    });
    return res.end();
  }

  const detail = {
    scope,
    requestId: req.id,
    method: req.method,
    path: req.path,
    status,
    userId: req.user?.id,
  };

  if (status >= 500) {
    // A 5xx is our fault and the stack belongs in the log, where an operator can
    // actually read it.
    log.error('request failed', { ...detail, err: describeError(err) });
  } else {
    // A 4xx is usually the caller's; the tag and the message are enough, and the
    // stack would only bury the request line it matters for.
    log.warn('request rejected', { ...detail, err: describeError(err, { stack: false }) });
  }

  return res.status(status).json({ error: message, requestId: req.id });
}

module.exports = {
  classify,
  errorHandler,
  notFoundHandler,
  requestContext,
  requestLogger,
};
