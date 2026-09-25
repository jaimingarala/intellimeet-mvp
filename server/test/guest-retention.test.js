/**
 * Guest retention: the sweep that keeps the demo path from growing the database
 * forever.
 *
 * The sweep is driven directly here — the harness boots the real entry point
 * with GUEST_RETENTION_ENABLED=false so a background timer can't race these
 * assertions.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, store, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, sleep } = require('./helpers/sockets.js');
const { purgeStaleGuests } = require('../src/services/guestRetention.js');

const daysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

function guestDoc(id, createdAt) {
  return {
    _id: id,
    name: `Guest ${id}`,
    email: `${id}@guest.intellimeet.dev`,
    passwordHash: '$2a$10$stubbed',
    isGuest: true,
    createdAt,
  };
}

function roomDoc(id, { roomCode, host, participants = [], banned = [] }) {
  return {
    _id: id,
    title: 'IntellMeet live demo',
    roomCode,
    host,
    participants,
    banned,
    status: 'live',
    chatMessages: [{ senderName: 'Maya', text: 'a sample message' }],
    transcript: 'sample notes',
    summary: 'sample summary',
    actionItems: [{ assignee: 'Priya', text: 'a sample action', done: false }],
    createdAt: new Date(),
    async save() {
      return this;
    },
  };
}

describe('guest retention', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('removes guests past the window, their rooms, and their seats elsewhere', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    store.users.push(guestDoc('old-guest', daysAgo(2)), guestDoc('fresh-guest', new Date()), {
      _id: 'real-user',
      name: 'Real User',
      email: 'real@test.dev',
      passwordHash: '$2a$10$stubbed',
      isGuest: false,
      createdAt: daysAgo(30),
    });
    store.meetings.push(
      roomDoc('old-room', {
        roomCode: 'aaa-bbbb-ccc',
        host: 'old-guest',
        participants: ['old-guest'],
      }),
      roomDoc('fresh-room', {
        roomCode: 'ddd-eeee-fff',
        host: 'fresh-guest',
        participants: ['fresh-guest'],
      }),
      roomDoc('real-room', {
        roomCode: 'ggg-hhhh-iii',
        host: 'real-user',
        participants: ['real-user', 'old-guest'],
        banned: ['old-guest'],
      }),
    );

    const result = await purgeStaleGuests();

    // Deleting a room takes its chat, summary and action items with it.
    assert.deepEqual(result, { guests: 1, rooms: 1, seats: 1, skipped: 0 });
    assert.deepEqual(
      store.users.map((u) => u._id),
      ['fresh-guest', 'real-user'],
    );
    assert.deepEqual(
      store.meetings.map((m) => m._id),
      ['fresh-room', 'real-room'],
    );

    // And the guest is gone from the room it had merely joined, ban included.
    const realRoom = store.meetings.find((m) => m._id === 'real-room');
    assert.deepEqual(realRoom.participants, ['real-user']);
    assert.deepEqual(realRoom.banned, []);
  });

  test('finds nothing to do on a second run', async () => {
    assert.deepEqual(await purgeStaleGuests(), { guests: 0, rooms: 0, seats: 0, skipped: 0 });
  });

  test('honours a custom window', async () => {
    store.users.push(guestDoc('recent-guest', daysAgo(0.5)));

    const result = await purgeStaleGuests({ olderThanMs: 60 * 60 * 1000 });

    assert.equal(result.guests, 1);
    assert.equal(
      store.users.some((u) => u._id === 'recent-guest'),
      false,
    );
  });

  // ---- live sessions ------------------------------------------------------
  //
  // These drive real websockets, because "someone is still connected" is not
  // something a stub can answer: the guard reads Socket.io's live state.

  test('leaves alone a guest whose room still has someone in it', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    const guest = await api('/api/auth/demo', { method: 'POST' });
    const { roomCode, token, user } = guest.body;

    // Past the window, but mid-demo.
    store.users.find((u) => String(u._id) === String(user.id)).createdAt = daysAgo(2);

    const socket = await connect(baseUrl(), token);
    try {
      await joinRoom(socket, roomCode);

      const result = await purgeStaleGuests();

      assert.equal(result.guests, 0, 'nothing is deleted while the room is occupied');
      assert.equal(result.skipped, 1);
      assert.ok(
        store.users.some((u) => String(u._id) === String(user.id)),
        'the guest survives',
      );
      assert.ok(
        store.meetings.some((m) => m.roomCode === roomCode),
        'and so does the room it is sitting in',
      );
    } finally {
      socket.disconnect();
    }
    await sleep(150);
  });

  test('leaves the host alive while someone else is still in their room', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    const host = await api('/api/auth/demo', { method: 'POST' });
    const visitor = await api('/api/auth/demo', {
      method: 'POST',
      body: { roomCode: host.body.roomCode },
    });

    // Both are stale; only the visitor has a tab open. The host is the one the
    // sweep would delete the room out from under.
    for (const id of [host.body.user.id, visitor.body.user.id]) {
      store.users.find((u) => String(u._id) === String(id)).createdAt = daysAgo(2);
    }

    const socket = await connect(baseUrl(), visitor.body.token);
    try {
      await joinRoom(socket, host.body.roomCode);

      const result = await purgeStaleGuests();

      assert.equal(result.guests, 0);
      assert.equal(result.skipped, 2, 'both the visitor and the absent host are spared');
      assert.ok(
        store.meetings.some((m) => m.roomCode === host.body.roomCode),
        'the room survives with its host',
      );
      assert.equal(
        String(store.meetings.find((m) => m.roomCode === host.body.roomCode).host),
        String(host.body.user.id),
      );
    } finally {
      socket.disconnect();
    }
    await sleep(150);
  });

  test('sweeps a room on the next run, once the room empties', async () => {
    store.users.length = 0;
    store.meetings.length = 0;

    const guest = await api('/api/auth/demo', { method: 'POST' });
    store.users.find((u) => String(u._id) === String(guest.body.user.id)).createdAt = daysAgo(2);

    const socket = await connect(baseUrl(), guest.body.token);
    await joinRoom(socket, guest.body.roomCode);
    assert.equal((await purgeStaleGuests()).guests, 0, 'held while the tab is open');

    socket.disconnect();
    await sleep(200); // let the server notice the disconnect

    const result = await purgeStaleGuests();

    assert.equal(result.guests, 1);
    assert.equal(
      store.meetings.some((m) => m.roomCode === guest.body.roomCode),
      false,
      'the room goes once nobody is in it',
    );
  });
});
