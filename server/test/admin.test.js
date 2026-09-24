/**
 * Operator endpoints: the status view and the on-demand sweep trigger.
 *
 * The point of triggering the sweep over HTTP, rather than from a script that
 * talks to MongoDB, is that the sweep has to run where the sockets are — so the
 * live-session tests here use real websockets against the real entry point.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, store, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, sleep } = require('./helpers/sockets.js');

const TOKEN = 'test-admin-token';
const auth = { headers: { 'x-admin-token': TOKEN } };
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const stats = () => api('/api/admin/stats', auth);
const sweep = () => api('/api/admin/sweep', { method: 'POST', ...auth });

/** A demo guest, aged past the 24h window so a sweep would take it. */
async function staleGuest() {
  const guest = await api('/api/auth/demo', { method: 'POST' });
  store.users.find((u) => String(u._id) === String(guest.body.user.id)).createdAt = daysAgo(2);
  return guest.body;
}

describe('admin: sweep trigger and stats', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('is invisible until an admin token is configured', async () => {
    delete process.env.ADMIN_TOKEN;
    try {
      assert.equal((await api('/api/admin/stats')).status, 404);
      assert.equal((await api('/api/admin/sweep', { method: 'POST' })).status, 404);
    } finally {
      process.env.ADMIN_TOKEN = TOKEN;
    }
  });

  test('rejects a missing or wrong token', async () => {
    assert.equal((await api('/api/admin/stats')).status, 403);
    assert.equal((await api('/api/admin/stats', { headers: { 'x-admin-token': 'nope' } })).status, 403);
    assert.equal((await api('/api/admin/sweep', { method: 'POST' })).status, 403);
  });

  test('reports the retention config, live sessions and the guest count', async () => {
    const res = await stats();

    assert.equal(res.status, 200);
    // The harness disables the timer; the endpoint reports what it finds.
    assert.equal(res.body.retention.enabled, false);
    assert.equal(res.body.retention.hours, 24);
    assert.deepEqual(res.body.live, { users: 0, rooms: 0 });
    assert.equal(typeof res.body.guests, 'number');
    assert.equal(res.body.lastSweep, null, 'no sweep has run in this process yet');
  });

  test('runs the sweep on demand and reports what it removed', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    const guest = await staleGuest();

    const res = await sweep();

    assert.equal(res.status, 200);
    assert.equal(res.body.swept.guests, 1);
    assert.equal(res.body.swept.rooms, 1);
    assert.equal(res.body.swept.skipped, 0);
    // The last-sweep record is what the stats endpoint reports.
    assert.equal(res.body.stats.lastSweep.guests, 1);
    assert.equal(typeof res.body.stats.lastSweep.at, 'string');
    assert.equal(res.body.stats.guests, 0);
    assert.equal(store.meetings.some((m) => m.roomCode === guest.roomCode), false);
  });

  test('will not sweep a room someone is still sitting in', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    const guest = await staleGuest();

    const socket = await connect(baseUrl(), guest.token);
    try {
      await joinRoom(socket, guest.roomCode);

      const res = await sweep();

      assert.equal(res.status, 200);
      // This is the whole reason the trigger is an endpoint: the sweep runs in
      // the server, so it can see the live socket a cron process cannot.
      assert.equal(res.body.swept.guests, 0);
      assert.equal(res.body.swept.skipped, 1);
      assert.equal(res.body.stats.live.rooms, 1);
      assert.ok(
        store.meetings.some((m) => m.roomCode === guest.roomCode),
        'the live room survives a sweep triggered from outside'
      );
    } finally {
      socket.disconnect();
    }
    await sleep(150);
  });
});
