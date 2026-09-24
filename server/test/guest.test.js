/**
 * The "Try the demo" path: one click, no sign-up, and a real anonymous guest.
 *
 * Its own file rather than a block in auth.test.js because of the rate limiter —
 * /signup, /login and /demo share a 30-requests-per-15-minutes budget per IP
 * (see routes/auth.js), and auth.test.js already spends over half of it. A fresh
 * process here gets a fresh limiter and a fresh in-memory store.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, store } = require('./helpers/app.js');

const guests = () => store.users.filter((u) => u.isGuest);

describe('demo access (anonymous guests, no sign-up)', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('one call creates a guest with a usable token and a room of their own', async () => {
    const { status, body } = await api('/api/auth/demo', { method: 'POST' });

    assert.equal(status, 200);
    assert.equal(typeof body.token, 'string');
    assert.equal(typeof body.roomCode, 'string');
    assert.equal(body.user.isGuest, true);
    assert.match(body.user.name, /^Guest [a-z2-9]{4}$/i);
    assert.match(body.user.email, /^guest-[0-9a-f]+@guest\.intellimeet\.dev$/);
    assert.equal(body.user.passwordHash, undefined);

    // The token is a real one, and the guest's dashboard shows only their room.
    const meetings = await api('/api/meetings', { token: body.token });
    assert.equal(meetings.status, 200);
    assert.equal(meetings.body.length, 1);
    assert.equal(meetings.body[0].roomCode, body.roomCode);
  });

  test('each visitor gets a different identity and a different room', async () => {
    const before = guests().length;

    const first = await api('/api/auth/demo', { method: 'POST' });
    const second = await api('/api/auth/demo', { method: 'POST' });

    assert.notEqual(first.body.user.id, second.body.user.id);
    assert.notEqual(first.body.roomCode, second.body.roomCode);
    assert.equal(guests().length, before + 2);
  });

  test('a guest has no password anyone can log in with', async () => {
    const { body } = await api('/api/auth/demo', { method: 'POST' });
    const stored = store.users.find((u) => String(u._id) === String(body.user.id));

    assert.ok(stored);
    assert.equal(stored.isGuest, true);
    // A real bcrypt hash, but of a random secret nobody holds.
    assert.match(stored.passwordHash, /^\$2[aby]\$/);
    assert.equal(await stored.comparePassword('anything'), false);
    assert.equal(await stored.comparePassword(''), false);

    const attempt = await api('/api/auth/login', {
      method: 'POST',
      body: { email: stored.email, password: 'anything' },
    });
    assert.equal(attempt.status, 401);
  });

  test('a new guest room arrives with the sample meeting', async () => {
    const { body } = await api('/api/auth/demo', { method: 'POST' });

    const room = await api(`/api/meetings/room/${body.roomCode}`, { token: body.token });

    assert.equal(room.status, 200);
    assert.equal(String(room.body.host), String(body.user.id));
    assert.ok(room.body.chatMessages.length >= 3);
    assert.ok(room.body.transcript.length > 0);
    assert.ok(room.body.summary.length > 0);
    assert.ok(room.body.actionItems.length > 0);
  });

  test('a guest can join an existing room through its link', async () => {
    const host = await api('/api/auth/demo', { method: 'POST' });
    const joiner = await api('/api/auth/demo', {
      method: 'POST',
      body: { roomCode: host.body.roomCode },
    });

    assert.equal(joiner.status, 200);
    assert.equal(joiner.body.roomCode, host.body.roomCode);
    assert.notEqual(joiner.body.user.id, host.body.user.id);
    assert.equal(joiner.body.user.isGuest, true);

    const meeting = store.meetings.find((m) => m.roomCode === host.body.roomCode);
    const participantIds = meeting.participants.map(String);
    assert.ok(participantIds.includes(String(host.body.user.id)));
    assert.ok(participantIds.includes(String(joiner.body.user.id)));
    // They join as a participant: the room keeps the host who created it.
    assert.equal(String(meeting.host), String(host.body.user.id));
  });

  test('joining a room that does not exist is a 404 and creates no account', async () => {
    const usersBefore = store.users.length;

    const res = await api('/api/auth/demo', { method: 'POST', body: { roomCode: 'no-such-room' } });

    assert.equal(res.status, 404);
    assert.equal(store.users.length, usersBefore);
  });

  test('roomCode must be a string', async () => {
    const res = await api('/api/auth/demo', { method: 'POST', body: { roomCode: 123 } });

    assert.equal(res.status, 400);
  });

  test('the demo path can be turned off for a deployment', async () => {
    process.env.DEMO_LOGIN_ENABLED = 'false';
    try {
      const res = await api('/api/auth/demo', { method: 'POST' });
      assert.equal(res.status, 403);
    } finally {
      process.env.DEMO_LOGIN_ENABLED = '';
    }
  });
});
