/**
 * One log shape for the whole server.
 *
 * Before this, every failure was a `console.error('[tag]', err)` — which is a
 * stack trace with no request attached, no way to filter it, and no way to tell
 * a production line from a local one. What a reviewer (or an operator at 2am)
 * needs is the opposite: one event per line, in a fixed shape, carrying the
 * request id of the request that caused it.
 *
 * Deliberate choices:
 *
 *   • No dependency. `pino`/`winston` would bring a tree of packages for what is
 *     a `JSON.stringify` and a level check, and this project's rule is that a
 *     judge can clone and run it without a paid service or a large install.
 *
 *   • JSON in production, human-readable elsewhere. `LOG_FORMAT` overrides.
 *     A platform's log viewer wants machine-readable lines; a terminal wants
 *     `12:04:31.882 info  GET /api/health 200 4ms`.
 *
 *   • Scrubbing on the way in, not on the way out. Any field whose *name* looks
 *     like a credential is replaced with `[redacted]`, and long strings are
 *     truncated, so a stack trace or a request body logged by mistake cannot
 *     put a password, a bearer token or a verification link into a platform's
 *     log retention. See `scrub`.
 *
 *   • Stacks go to the log, never to the response. The HTTP error handler
 *     (`middleware/observability.js`) reports a request id and a sentence; the
 *     stack stays server-side.
 *
 * Every function here reads the environment at call time, which is what lets a
 * test flip `LOG_LEVEL` for one case without re-requiring the module.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** `LOG_LEVEL=silent` — used by the test harness so 134 suites stay readable. */
const SILENT = Number.POSITIVE_INFINITY;

/** Longest string kept intact; anything longer is truncated with its real size. */
const MAX_STRING_CHARS = 500;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 3;

/** A field whose name matches this is replaced rather than logged. */
const SENSITIVE_KEY = /pass|secret|token|api[-_]?key|authoriz|cookie|credential|bearer/i;

/**
 * The threshold this process logs at. Unknown values fall back to `info` rather
 * than `debug` so a typo can't accidentally turn on per-request debugging in
 * production.
 */
function activeLevel(env = process.env) {
  const raw = String(env.LOG_LEVEL ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'silent' || raw === 'off' || raw === 'none') return SILENT;
  if (Object.prototype.hasOwnProperty.call(LEVELS, raw)) return LEVELS[raw];
  return LEVELS.info;
}

/** `json`, `pretty`, or the default for this NODE_ENV. */
function outputFormat(env = process.env) {
  const raw = String(env.LOG_FORMAT ?? '')
    .trim()
    .toLowerCase();
  if (raw === 'json' || raw === 'pretty') return raw;
  return env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

/**
 * A plain-object view of an Error. `cause` is unwrapped because that is where a
 * wrapped network failure keeps its real reason (ECONNREFUSED, ENOTFOUND), and
 * without it "fetch failed" is the whole story.
 */
function describeError(err, { stack = true } = {}) {
  if (!err || typeof err !== 'object') return { message: String(err) };

  const out = { name: err.name || 'Error', message: err.message };
  const status = err.status ?? err.statusCode;
  if (status !== undefined) out.status = status;
  if (err.code !== undefined) out.code = err.code;
  // body-parser tags its rejections ('entity.too.large', 'entity.parse.failed'),
  // and that tag is what the error handler maps to a status.
  if (err.type !== undefined) out.type = err.type;
  if (err.cause) out.cause = describeError(err.cause, { stack: false });
  if (stack && err.stack) out.stack = err.stack;
  return out;
}

/**
 * Make an arbitrary value safe to log: drop credential-shaped keys, truncate
 * long strings and lists, and cap how deep it walks. A cyclic object can't get
 * here (socket payloads are parsed JSON), and depth is capped regardless.
 */
function scrub(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING_CHARS
      ? `${value.slice(0, MAX_STRING_CHARS)}…(${value.length} chars)`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) return describeError(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => scrub(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS
      ? [...items, `…(${value.length - MAX_ARRAY_ITEMS} more)`]
      : items;
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return '[too deep]';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function prettyLine(entry) {
  const { time, level, msg, ...fields } = entry;
  const clock = time.slice(11, 23);
  const suffix = Object.entries(fields)
    .map(([key, value]) => {
      const rendered =
        value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `${key}=${rendered}`;
    })
    .join(' ');
  return `${clock} ${level.padEnd(5)} ${msg}${suffix ? ` ${suffix}` : ''}`;
}

/**
 * Write one event. Returns the entry as logged, or null when the level is
 * filtered out — which is what lets a test assert on both halves.
 *
 * The reserved keys are spread last, so a field called `msg` can't rewrite the
 * message.
 */
function emit(level, message, fields, env = process.env) {
  if (LEVELS[level] < activeLevel(env)) return null;

  const entry = {
    ...(fields ? scrub(fields) : {}),
    time: new Date().toISOString(),
    level,
    msg: message,
  };

  const line = outputFormat(env) === 'json' ? JSON.stringify(entry) : prettyLine(entry);
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  sink(line);
  return entry;
}

const log = {
  debug: (message, fields) => emit('debug', message, fields),
  info: (message, fields) => emit('info', message, fields),
  warn: (message, fields) => emit('warn', message, fields),
  error: (message, fields) => emit('error', message, fields),
};

module.exports = { LEVELS, activeLevel, describeError, log, outputFormat, scrub };
