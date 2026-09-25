/**
 * Claiming a guest session: turning a throwaway demo identity into a real
 * account without losing what was built in the demo.
 *
 * Its own file for the same reason as guest.test.js — /claim shares the
 * 30-requests-per-15-minutes-per-IP auth budget, and a fresh process keeps each
 * suite well clear of it.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, store } = require('./helpers/app.js');
const { purgeStaleGuests } = require('../src/services/guestRetention.js');

const newGuest = () => api('/api/auth/demo', { method: 'POST' });

describe('claiming a guest session', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('turns a guest into a real account that keeps its room', async () => {
    const guest = await newGuest();
    const { roomCode, token, user } = guest.body;

    const claimed = await api('/api/auth/claim', {
      method: 'POST',
      token,
      body: { name: 'Priya Sharma', email: 'priya@example.com', password: 'password123' },
    });

    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.user.isGuest, false);
    assert.equal(claimed.body.user.email, 'priya@example.com');
    assert.equal(claimed.body.user.name, 'Priya Sharma');
    assert.equal(claimed.body.user.passwordHash, undefined);
    // The address is attached but not yet proven — see email-verification.test.js
    // for the confirmation itself; what matters here is that the identity and
    // everything hanging off it survived. That's this id.
    assert.equal(claimed.body.user.emailVerified, false);
    // Same person — that identity is what carries the room across.
    assert.equal(claimed.body.user.id, user.id);

    // The room built during the demo is still theirs, contents intact.
    const room = await api(`/api/meetings/room/${roomCode}`, { token: claimed.body.token });
    assert.equal(room.status, 200);
    assert.equal(String(room.body.host), String(user.id));
    assert.ok(room.body.summary.length > 0);

    // And the new token is a real one: it works everywhere a session does.
    assert.equal((await api('/api/meetings', { token: claimed.body.token })).status, 200);

    // The address is reserved but isn't a usable identity yet: login names the
    // account and refuses it, which is what stops a claim on a stranger's
    // address from becoming a way in. (email-verification.test.js proves the
    // refusal lifts once the emailed link comes back.)
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'priya@example.com', password: 'password123' },
    });
    assert.equal(login.status, 403);
    assert.equal(login.body.code, 'email_unverified');

    // The guest placeholder password no longer applies either.
    const wrong = await api('/api/auth/login', {
      method: 'POST',
      body: { email: 'priya@example.com', password: 'intellimeet-demo' },
    });
    assert.equal(wrong.status, 401);
  });

  test('a claimed account is no longer subject to guest retention', async () => {
    const guest = await newGuest();
    const { roomCode, token, user } = guest.body;

    const claimed = await api('/api/auth/claim', {
      method: 'POST',
      token,
      body: { email: 'kept@example.com', password: 'password123' },
    });
    assert.equal(claimed.status, 200);

    // Pretend the session had been open past the retention window.
    const stored = store.users.find((u) => String(u._id) === String(user.id));
    stored.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const result = await purgeStaleGuests();

    assert.equal(result.guests, 0);
    assert.ok(
      store.users.some((u) => String(u._id) === String(user.id)),
      'the claimed account survives',
    );
    assert.ok(
      store.meetings.some((m) => m.roomCode === roomCode),
      'and so does the room it owns',
    );
  });

  test('rejects a short password or a missing email, and changes nothing', async () => {
    const guest = await newGuest();

    const short = await api('/api/auth/claim', {
      method: 'POST',
      token: guest.body.token,
      body: { email: 'short@example.com', password: 'abc' },
    });
    const noEmail = await api('/api/auth/claim', {
      method: 'POST',
      token: guest.body.token,
      body: { password: 'password123' },
    });

    assert.equal(short.status, 400);
    assert.equal(noEmail.status, 400);

    const stored = store.users.find((u) => String(u._id) === String(guest.body.user.id));
    assert.equal(stored.isGuest, true, 'a rejected claim leaves the guest a guest');
  });

  test('refuses an email that already belongs to an account', async () => {
    await api('/api/auth/signup', {
      method: 'POST',
      body: { name: 'Already Here', email: 'taken@example.com', password: 'password123' },
    });
    const guest = await newGuest();

    const claimed = await api('/api/auth/claim', {
      method: 'POST',
      token: guest.body.token,
      body: { email: 'taken@example.com', password: 'password123' },
    });

    assert.equal(claimed.status, 409);
  });

  test('an existing account cannot claim itself again', async () => {
    const real = await api('/api/auth/signup', {
      method: 'POST',
      body: { name: 'Real User', email: 'real@example.com', password: 'password123' },
    });

    const res = await api('/api/auth/claim', {
      method: 'POST',
      token: real.body.token,
      body: { email: 'other@example.com', password: 'password123' },
    });

    assert.equal(res.status, 403);
  });

  test('claiming requires a session at all', async () => {
    const res = await api('/api/auth/claim', {
      method: 'POST',
      body: { email: 'nobody@example.com', password: 'password123' },
    });

    assert.equal(res.status, 401);
  });
});
