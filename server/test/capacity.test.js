/**
 * The guest-room cap: a volume bound that backs up the age-based sweep, so the
 * demo stays finite even if the sweep never runs.
 *
 * Room creation is driven through the service directly, so the arithmetic is
 * tested without spending the /demo rate-limit budget. The live-room test uses a
 * real socket, because "someone is in there" is the one input a stub can't fake.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, store, baseUrl, tokenFor } = require('./helpers/app.js');
const { connect, joinRoom, sleep } = require('./helpers/sockets.js');
const { startDemo } = require('../src/services/guest.js');

const CAP_ENV = 'DEMO_MAX_GUEST_ROOMS';
const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function reset() {
  store.users.length = 0;
  store.meetings.length = 0;
}

/** Rooms whose host is (or was) a guest — the cap's unit. */
const guestRoomCodes = () =>
  store.meetings
    .filter((m) => store.users.some((u) => String(u._id) === String(m.host) && u.isGuest))
    .map((m) => m.roomCode);

const setCreatedAt = (roomCode, date) => {
  store.meetings.find((m) => m.roomCode === roomCode).createdAt = date;
};

/** Runs a test with the cap set, then restores the harness default. */
async function withCap(value, fn) {
  process.env[CAP_ENV] = value;
  try {
    await fn();
  } finally {
    process.env[CAP_ENV] = '200';
  }
}

describe('guest room capacity', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('evicts the oldest guest room once the cap is reached', async () => {
    reset();

    await withCap('2', async () => {
      const first = await startDemo();
      const second = await startDemo();
      // Make "oldest" unambiguous rather than relying on creation order.
      setCreatedAt(first.meeting.roomCode, daysAgo(3));
      setCreatedAt(second.meeting.roomCode, daysAgo(2));

      const third = await startDemo();

      assert.equal(
        store.meetings.some((m) => m.roomCode === first.meeting.roomCode),
        false,
        'the oldest room made way'
      );
      assert.ok(store.meetings.some((m) => m.roomCode === second.meeting.roomCode));
      assert.ok(store.meetings.some((m) => m.roomCode === third.meeting.roomCode));
      assert.equal(guestRoomCodes().length, 2, 'and the cap holds');
      // The evicted guest goes with its room, exactly as the sweep would leave it.
      assert.equal(
        store.users.some((u) => String(u._id) === String(first.user._id)),
        false
      );
    });
  });

  test('never evicts a room someone is sitting in', async () => {
    reset();

    await withCap('1', async () => {
      const live = await startDemo();

      const socket = await connect(
        baseUrl(),
        tokenFor({ id: String(live.user._id), name: live.user.name })
      );
      try {
        await joinRoom(socket, live.meeting.roomCode);

        const second = await startDemo();

        assert.ok(
          store.meetings.some((m) => m.roomCode === live.meeting.roomCode),
          'the occupied room survives'
        );
        assert.ok(store.meetings.some((m) => m.roomCode === second.meeting.roomCode));
        assert.equal(guestRoomCodes().length, 2, 'the cap is exceeded rather than cutting a demo off');
      } finally {
        socket.disconnect();
      }
      await sleep(150);
    });
  });

  test("never counts or evicts a real account's meeting", async () => {
    reset();

    await withCap('1', async () => {
      store.users.push({
        _id: 'real-user',
        name: 'Real User',
        email: 'real@test.dev',
        passwordHash: 'x',
        role: 'member',
        isGuest: false,
        createdAt: new Date(),
      });
      store.meetings.push({
        _id: 'real-room',
        title: 'A real meeting',
        roomCode: 'real-0000-000',
        host: 'real-user',
        participants: ['real-user'],
        banned: [],
        status: 'live',
        chatMessages: [],
        transcript: '',
        summary: '',
        actionItems: [],
        createdAt: new Date(),
        async save() {
          return this;
        },
      });

      const first = await startDemo();
      const second = await startDemo();

      assert.ok(store.meetings.some((m) => m._id === 'real-room'), "a real user's room is not a candidate");
      assert.equal(
        store.meetings.some((m) => m.roomCode === first.meeting.roomCode),
        false,
        'the older guest room made way instead'
      );
      assert.ok(store.meetings.some((m) => m.roomCode === second.meeting.roomCode));
      assert.equal(guestRoomCodes().length, 1);
    });
  });

  test('can be switched off', async () => {
    reset();

    await withCap('0', async () => {
      await startDemo();
      await startDemo();
      await startDemo();

      assert.equal(guestRoomCodes().length, 3, 'cap disabled — nothing is evicted');
    });
  });
});
