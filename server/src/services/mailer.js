/**
 * Outbound mail, kept deliberately small.
 *
 * The only message the app sends is the "prove this address is yours" link, so
 * this is not a templating layer — it is one function with a couple of
 * transports and an honest answer about which one ran.
 *
 * Delivery, in order of preference:
 *
 *   1. `MAIL_WEBHOOK_URL` — a POST of `{ to, subject, text, link }` as JSON.
 *      Every hosted provider offers an HTTP send endpoint (or you can point it
 *      at a local catcher), and using one keeps this dependency-free.
 *   2. The console, when not in production. Enough to complete a demo without
 *      an SMTP server.
 *   3. Nothing, in production with no transport configured — and deliberately
 *      *not* the link: a verification link printed to a production log is a
 *      working credential anyone with log access can spend.
 *
 * There is no SMTP transport because there is no mail library in this project;
 * SMTP by hand (TLS, AUTH, MIME) is a dependency-sized problem, not a function.
 */
// Dev and test convenience: what would have been sent, so a suite (or you) can
// follow the link without a mail server. Never recorded in production — these
// are working credentials.
const OUTBOX_LIMIT = 20;
let outbox = [];

const isProduction = () => process.env.NODE_ENV === 'production';
const isMailerConfigured = () => Boolean(process.env.MAIL_WEBHOOK_URL);

/** The public origin this app is reached at, for links inside emails. */
function appBaseUrl() {
  return (process.env.APP_BASE_URL || 'http://localhost:5173').replace(/\/+$/, '');
}

/** Where a verification email points. The SPA route, not an API path. */
function buildVerificationLink(token) {
  return `${appBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
}

function record(message) {
  outbox.push(message);
  if (outbox.length > OUTBOX_LIMIT) outbox = outbox.slice(-OUTBOX_LIMIT);
}

/**
 * Send one message. Never throws: a claim that already wrote the account must
 * not be rolled back because a third party was unreachable — the caller reports
 * the failure and the user can ask for another link. Returns what happened, so
 * the route can say so rather than guessing.
 */
async function sendMail({ to, subject, text, link }) {
  const message = { to, subject, text, link, at: new Date() };

  if (!isMailerConfigured()) {
    if (isProduction()) {
      console.warn(
        `[mailer] MAIL_WEBHOOK_URL is not set — no mail sent to ${to}. ` +
          'Verification links cannot be delivered on this deployment.'
      );
      return { delivered: false, transport: 'none' };
    }
    console.log(`[mailer] no transport configured; would send to ${to}\n${text}`);
    record(message);
    return { delivered: true, transport: 'console' };
  }

  try {
    const res = await fetch(process.env.MAIL_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.MAIL_WEBHOOK_TOKEN
          ? { Authorization: `Bearer ${process.env.MAIL_WEBHOOK_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ to, subject, text, link }),
    });
    if (!res.ok) {
      console.error(`[mailer] ${process.env.MAIL_WEBHOOK_URL} answered ${res.status} for ${to}`);
      return { delivered: false, transport: 'webhook', error: `HTTP ${res.status}` };
    }
    record(message);
    return { delivered: true, transport: 'webhook' };
  } catch (err) {
    console.error('[mailer]', err.message);
    return { delivered: false, transport: 'webhook', error: err.message };
  }
}

/** What has been "sent" locally. Tests read it to follow a verification link. */
function getOutbox() {
  return [...outbox];
}

/** The most recent message to an address, which is what a test usually wants. */
function lastMailTo(email) {
  const wanted = String(email).toLowerCase();
  return [...outbox].reverse().find((m) => m.to.toLowerCase() === wanted) || null;
}

function clearOutbox() {
  outbox = [];
}

/** The token from a link, so a caller doesn't have to know the link's shape. */
function tokenFromLink(link) {
  try {
    return new URL(link).searchParams.get('token');
  } catch {
    return null;
  }
}

module.exports = {
  appBaseUrl,
  buildVerificationLink,
  clearOutbox,
  getOutbox,
  isMailerConfigured,
  lastMailTo,
  sendMail,
  tokenFromLink,
};
