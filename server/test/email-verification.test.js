/**
 * Email verification on the claim path.
 *
 * A guest may attach any address; this is what stops that address becoming an
 * identity. The suite follows the real flow — read the link out of the mailer's
 * outbox and spend it — rather than poking the model directly, so it covers the
 * token plumbing and not just the flag.
 *
 * Its own file, for the usual reason: these routes share the auth rate-limit
 * budget, and a fresh process keeps the suite well clear of the ceiling.
 */
const { describe, test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, store } = require('./helpers/app.js');
const mailer = require('../src/services/mailer.js');
const { hashToken } = require('../src/services/emailVerification.js');

const newGuest = () => api('/api/auth/demo', { method: 'POST' });

const claim = (token, body) =>
  api('/api/auth/claim', { method: 'POST', token, body: { password: 'password123', ...body } });

const verify = (token) => api('/api/auth/verify-email', { method: 'POST', body: { token } });

/** The one-time token a recipient would click, taken from the sent message. */
function linkTokenFor(email) {
  const mail = mailer.lastMailTo(email);
  assert.ok(mail, `no verification email was sent to ${email}`);
  const token = mailer.tokenFromLink(mail.link);
  assert.ok(token, 'the emailed link carries a token');
  return token;
}

const storedFor = (id) => store.users.find((u) => String(u._id) === String(id));

describe('email verification on claim', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  beforeEach(() => mailer.clearOutbox());

  test('a claim holds the address pending and emails a one-time link', async () => {
    const guest = await newGuest();
    const { roomCode, token, user } = guest.body;

    const claimed = await claim(token, { name: 'Priya Sharma', email: 'priya@example.com' });

    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.user.isGuest, false);
    assert.equal(claimed.body.user.email, 'priya@example.com');
    assert.equal(claimed.body.user.emailVerified, false, 'the address is not trusted yet');

    // The client is told what happened and when the link dies, but the link
    // itself is only ever in the email.
    assert.equal(claimed.body.verification.required, true);
    assert.equal(claimed.body.verification.email, 'priya@example.com');
    assert.equal(claimed.body.verification.delivered, true);
    assert.equal(claimed.body.verification.token, undefined);
    const ttlHours = (new Date(claimed.body.verification.expiresAt) - Date.now()) / 3600000;
    assert.ok(ttlHours > 23 && ttlHours <= 24, `expires in about a day, got ${ttlHours}h`);

    // The mail went to the address being claimed, and points at the SPA route.
    const mail = mailer.lastMailTo('priya@example.com');
    assert.match(mail.link, /^http:\/\/localhost:5173\/verify-email\?token=/);

    // Only the hash is kept: the row is useless to whoever reads the database.
    const stored = storedFor(user.id);
    const linkToken = mailer.tokenFromLink(mail.link);
    assert.equal(stored.emailVerified, false);
    assert.equal(stored.emailVerification.tokenHash, hashToken(linkToken));
    assert.notEqual(stored.emailVerification.tokenHash, linkToken);
    assert.equal(stored.emailVerification.sentTo, 'priya@example.com');

    // Meanwhile the session that claimed still owns the demo room it built.
    const room = await api(`/api/meetings/room/${roomCode}`, { token: claimed.body.token });
    assert.equal(room.status, 200);
    assert.ok(room.body.summary.length > 0);
  });

  test('login is refused until the address is confirmed', async () => {
    const guest = await newGuest();
    const claimed = await claim(guest.body.token, { email: 'pending@example.com' });
    assert.equal(claimed.status, 200);

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'pending@example.com', password: 'password123' },
    });

    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'email_unverified');
    assert.equal(login.body.email, 'pending@example.com');
    assert.equal(login.body.token, undefined);
  });

  test('the emailed link confirms the address, and then login works', async () => {
    const guest = await newGuest();
    const { roomCode, user } = guest.body;
    const claimResult = await claim(guest.body.token, { email: 'confirm@example.com' });
    assert.equal(claimResult.status, 200);

    const confirmed = await verify(linkTokenFor('confirm@example.com'));

    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.user.emailVerified, true);
    assert.equal(confirmed.body.user.id, user.id, 'same account, address proven');
    // The link proves the address; it is deliberately not a session.
    assert.equal(confirmed.body.token, undefined);

    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'confirm@example.com', password: 'password123' },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.id, user.id);

    // What the demo built is still attached to that identity.
    const room = await api(`/api/meetings/room/${roomCode}`, { token: login.body.token });
    assert.equal(room.status, 200);

    // And nothing is left pending.
    assert.equal(storedFor(user.id).emailVerification, undefined);
    assert.equal(storedFor(user.id).emailVerified, true);
  });

  test('the link works once', async () => {
    const guest = await newGuest();
    const claimed = await claim(guest.body.token, { email: 'once@example.com' });
    assert.equal(claimed.status, 200);
    const token = linkTokenFor('once@example.com');

    assert.equal((await verify(token)).status, 200);

    const again = await verify(token);
    assert.equal(again.status, 400);
    assert.equal(again.body.code, 'verification_invalid');
  });

  test('an expired link is refused, and a resend replaces it', async () => {
    const guest = await newGuest();
    const { user } = guest.body;
    const claimed = await claim(guest.body.token, { email: 'expired@example.com' });
    assert.equal(claimed.status, 200);
    const firstToken = linkTokenFor('expired@example.com');

    // Pretend the link sat in an inbox for too long.
    storedFor(user.id).emailVerification.expiresAt = new Date(Date.now() - 60_000);

    const stale = await verify(firstToken);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.code, 'verification_expired');
    assert.equal(storedFor(user.id).emailVerification, undefined, 'the dead token is dropped');

    const resend = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: { email: 'expired@example.com' },
    });
    assert.equal(resend.status, 200);

    const secondToken = linkTokenFor('expired@example.com');
    assert.notEqual(secondToken, firstToken, 'a resend mints a new token');

    // The superseded link is dead the moment a newer one is issued.
    const superseded = await verify(firstToken);
    assert.equal(superseded.status, 400);
    assert.equal(superseded.body.code, 'verification_invalid');

    assert.equal((await verify(secondToken)).status, 200);
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'expired@example.com', password: 'password123' },
    });
    assert.equal(login.status, 200);
  });

  test('a link minted for one address cannot confirm a different one', async () => {
    const guest = await newGuest();
    const { user } = guest.body;
    const claimed = await claim(guest.body.token, { email: 'first@example.com' });
    assert.equal(claimed.status, 200);

    // Standing in for an email change that doesn't exist yet — the invariant is
    // that a link only ever proves the address it was sent to.
    storedFor(user.id).email = 'second@example.com';

    const attempt = await verify(linkTokenFor('first@example.com'));
    assert.equal(attempt.status, 400);
    assert.equal(attempt.body.code, 'verification_invalid');
    assert.equal(storedFor(user.id).emailVerified, false);
  });

  test('a resend reveals nothing about which addresses exist', async () => {
    const unknown = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: { email: 'nobody@example.com' },
    });

    const guest = await newGuest();
    const { user } = guest.body;
    const claimed = await claim(guest.body.token, { email: 'waiting@example.com' });
    assert.equal(claimed.status, 200);
    const pending = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: { email: 'waiting@example.com' },
    });

    assert.equal(unknown.status, 200);
    assert.equal(pending.status, 200);
    assert.deepEqual(unknown.body, pending.body, 'the same answer either way');
    assert.ok(linkTokenFor('waiting@example.com'), 'and the real one still gets a link');

    // A confirmed account is not re-sent anything.
    assert.equal((await verify(linkTokenFor('waiting@example.com'))).status, 200);
    assert.equal(storedFor(user.id).emailVerified, true);
    mailer.clearOutbox();
    const settled = await api('/api/auth/resend-verification', {
      method: 'POST',
      body: { email: 'waiting@example.com' },
    });
    assert.equal(settled.status, 200);
    assert.deepEqual(settled.body, unknown.body);
    assert.equal(mailer.lastMailTo('waiting@example.com'), null, 'no mail for a verified account');

    // A malformed request is still a 400: that is about the request, not about
    // whether the address exists.
    const bad = await api('/api/auth/resend-verification', { method: 'POST', body: {} });
    assert.equal(bad.status, 400);
  });

  test('the pending state is skipped when verification is switched off', async () => {
    process.env.EMAIL_VERIFICATION_REQUIRED = 'false';
    try {
      const guest = await newGuest();
      const claimed = await claim(guest.body.token, { email: 'trusted@example.com' });

      assert.equal(claimed.status, 200);
      assert.equal(claimed.body.user.emailVerified, true);
      assert.equal(claimed.body.verification, undefined, 'nothing to verify, nothing to report');
      assert.equal(mailer.lastMailTo('trusted@example.com'), null, 'and no mail is sent');

      const login = await api('/api/auth/login', {
        method: 'POST',
        body: { email: 'trusted@example.com', password: 'password123' },
      });
      assert.equal(login.status, 200);
    } finally {
      process.env.EMAIL_VERIFICATION_REQUIRED = 'true';
    }
  });
});
