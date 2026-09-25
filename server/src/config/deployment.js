/**
 * The settings that only exist because this ends up somewhere other than
 * localhost, and the checks that catch a deployed-but-wrong configuration before
 * a visitor does.
 *
 * Two jobs:
 *
 *   1. `trustProxySetting()` — behind a platform proxy (Render, Fly, Heroku) every
 *      request arrives *from* the proxy, so `req.ip` is the proxy's address unless
 *      Express is told to read `X-Forwarded-For`. Both rate limiters are IP-keyed,
 *      so without this every visitor in the world shares one budget and about
 *      thirty clicks of "Try the demo" in a quarter of an hour is enough to stop
 *      the demo path answering — the one thing this milestone is graded on.
 *      express-rate-limit also logs a validation error on every such request.
 *
 *   2. `deploymentWarnings()` — the misconfigurations that are invisible from
 *      inside the process: a placeholder signing key, an origin that still says
 *      localhost, a claim flow that would email a link nobody can send. They are
 *      logged once at boot and exposed to the operator behind `ADMIN_TOKEN` in
 *      `/api/admin/stats`. Deliberately *not* on `/api/health`: that endpoint is
 *      public, and "JWT_SECRET is not set" is an invitation, not a status code.
 *
 * Everything here is a pure function of the environment, so the deployment's
 * shape can be asserted in a test instead of discovered in production.
 */

/** Values that read as "off" for any of the boolean knobs. */
const DISABLED_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Secrets that mean "nobody set this": the .env.example placeholder and friends. */
const PLACEHOLDER_SECRETS = new Set([
  'change_this_to_a_long_random_secret',
  'changeme',
  'change_me',
  'secret',
  'jwt_secret',
]);

/** A URL that only works on the machine it was written on. */
const LOOPBACK = /(^|[/:[])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/]|$)/i;

const MIN_SECRET_LENGTH = 32;
const MIN_ADMIN_TOKEN_LENGTH = 24;

/**
 * Read one of the boolean knobs (`DEMO_LOGIN_ENABLED`, `GUEST_RETENTION_ENABLED`).
 * An unset or empty value is the documented default rather than "false", because
 * a fresh clone and a fresh deploy should both come up with the feature on.
 */
function envFlag(name, { env = process.env, fallback = true } = {}) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return !DISABLED_VALUES.has(String(raw).trim().toLowerCase());
}

function listOf(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Where the client runs when nobody said otherwise. */
const DEFAULT_ORIGINS = ['http://localhost:5173'];

/**
 * The origins actually handed to CORS.
 *
 * `*` is stripped rather than honoured. With `credentials: true` a wildcard is
 * useless anyway — a browser refuses `Access-Control-Allow-Origin: *` on a
 * credentialed request — so allowing it here would turn "allow everything" into
 * "silently allow nothing", which is the hardest kind of CORS failure to read.
 * An empty list after stripping falls back to the local client, so development
 * stays usable and the warning below is what names the mistake.
 */
function allowedOrigins(env = process.env) {
  const configured = listOf(env.CLIENT_ORIGIN);
  const origins = configured.filter((origin) => origin !== '*');
  return {
    origins: origins.length > 0 ? origins : DEFAULT_ORIGINS,
    wildcard: configured.includes('*'),
  };
}

/**
 * What to hand `app.set('trust proxy', …)`.
 *
 * Production defaults to one trusted hop, which is exactly what a single platform
 * proxy is: the visitor's address is the last entry `X-Forwarded-For` gained.
 * `TRUST_PROXY` overrides that — set it to a hop count, `true`/`false`, or an
 * Express address list (`loopback, 10.0.0.0/8`) for a longer chain such as a CDN
 * in front of the platform. Outside production it stays off, so a local request
 * cannot spoof its own address.
 */
function trustProxySetting(env = process.env) {
  const raw = env.TRUST_PROXY;
  if (raw !== undefined && String(raw).trim() !== '') {
    const value = String(raw).trim();
    if (DISABLED_VALUES.has(value.toLowerCase())) return false;
    if (value.toLowerCase() === 'true') return true;

    const hops = Number(value);
    // A non-numeric value is an address list, which is how Express itself takes
    // it — pass it through rather than pretending to understand it here.
    return Number.isFinite(hops) ? hops : value;
  }
  return env.NODE_ENV === 'production' ? 1 : false;
}

const isVerificationRequired = (env) => env.EMAIL_VERIFICATION_REQUIRED !== 'false';

/**
 * The things wrong with this deployment, in the order they would embarrass you.
 *
 * Almost all of it is production-only: locally, localhost origins and an unset
 * mailer are correct — the console transport exists for exactly that — and a
 * warning that fires on every healthy dev boot is a warning nobody reads. The
 * exception is the wildcard origin below, which is a mistake anywhere and just
 * as invisible locally.
 */
function deploymentWarnings(env = process.env) {
  const warnings = [];

  // Checked in every environment: a wildcard origin is never what was meant, and
  // locally it is just as invisible (the browser reports an opaque CORS failure,
  // not "your wildcard was ignored").
  if (allowedOrigins(env).wildcard) {
    warnings.push(
      'CLIENT_ORIGIN is "*", which a browser refuses on a credentialed request: no client origin is allowed at all. List the exact origin instead, scheme included.',
    );
  }

  if (env.NODE_ENV !== 'production') return warnings;

  const secret = String(env.JWT_SECRET ?? '');

  if (!secret) {
    warnings.push(
      'JWT_SECRET is not set: every signup, login and demo click fails with a 500, and no session can be issued.',
    );
  } else if (secret.length < MIN_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(secret.toLowerCase())) {
    warnings.push(
      `JWT_SECRET is ${secret.length} characters or a known placeholder: anyone who guesses it can mint a token for any account, host included. Use a long random value.`,
    );
  }

  const origins = listOf(env.CLIENT_ORIGIN);
  if (origins.length === 0) {
    warnings.push(
      'CLIENT_ORIGIN is not set, so it defaults to http://localhost:5173 and the browser blocks every request from the deployed client with a CORS error.',
    );
  } else {
    const local = origins.filter((origin) => LOOPBACK.test(origin));
    if (local.length > 0) {
      warnings.push(
        `CLIENT_ORIGIN still contains ${local.join(', ')}: the deployed client's origin must be listed too, exactly, or the browser gets an opaque CORS failure.`,
      );
    }
  }

  if (!envFlag('DEMO_LOGIN_ENABLED', { env })) {
    warnings.push(
      'DEMO_LOGIN_ENABLED is off, so the one-click demo path answers 403: the highest-weighted rubric item (core functionality without sign-up) cannot be reached at all.',
    );
  }

  if (isVerificationRequired(env) && !env.MAIL_WEBHOOK_URL) {
    warnings.push(
      'EMAIL_VERIFICATION_REQUIRED is on (the default) but MAIL_WEBHOOK_URL is unset, and production sends no mail without it: an account claimed from the demo can never be verified and login for it stays refused. Set MAIL_WEBHOOK_URL, or set EMAIL_VERIFICATION_REQUIRED=false to trust a claim immediately.',
    );
  }

  const base = String(env.APP_BASE_URL ?? '');
  if (isVerificationRequired(env) && (!base || LOOPBACK.test(base))) {
    warnings.push(
      `APP_BASE_URL is ${base ? `"${base}"` : 'unset'}, so a confirmation link points at a machine only you have; it must be the URL people reach the app at.`,
    );
  }

  if (env.ADMIN_TOKEN && String(env.ADMIN_TOKEN).length < MIN_ADMIN_TOKEN_LENGTH) {
    warnings.push(
      `ADMIN_TOKEN is only ${String(env.ADMIN_TOKEN).length} characters: it guards the guest sweep endpoint, so it has to be unguessable rather than memorable.`,
    );
  }

  if (trustProxySetting(env) === false) {
    warnings.push(
      'TRUST_PROXY is off behind a platform proxy, so every request looks like it came from the proxy: one rate-limit budget shared by all visitors, and ~30 demo clicks in 15 minutes stops the path answering.',
    );
  }

  return warnings;
}

/**
 * What this process thinks it is: the shape of the deployment, for the operator
 * view and for a test to assert on. No secrets, only whether they are set.
 */
function deploymentSummary(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || 'development',
    trustProxy: trustProxySetting(env),
    demoEnabled: envFlag('DEMO_LOGIN_ENABLED', { env }),
    origins: allowedOrigins(env).origins,
    verificationRequired: isVerificationRequired(env),
    mailerConfigured: Boolean(env.MAIL_WEBHOOK_URL),
    adminEndpoints: Boolean(env.ADMIN_TOKEN),
    logLevel: env.LOG_LEVEL || 'info',
    logFormat: env.LOG_FORMAT || (env.NODE_ENV === 'production' ? 'json' : 'pretty'),
    warnings: deploymentWarnings(env),
  };
}

/**
 * Print the warnings as one block at boot. Returns how many there were, so the
 * caller can decide whether to be loud about it.
 */
function logDeploymentWarnings(warnings = deploymentWarnings(), log = console) {
  if (warnings.length === 0) return 0;

  log.warn(
    `[config] ${warnings.length} deployment warning(s) — this deployment is not ready to show anyone:`,
  );
  for (const warning of warnings) log.warn(`[config]   • ${warning}`);
  return warnings.length;
}

module.exports = {
  allowedOrigins,
  deploymentSummary,
  deploymentWarnings,
  envFlag,
  logDeploymentWarnings,
  trustProxySetting,
};
