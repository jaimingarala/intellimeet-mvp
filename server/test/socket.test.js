/**
 * The socket protocol itself: join, chat relay, and moderation events.
 *
 * The moderation suite covers the REST remove/ban endpoint and the eviction of
 * a live socket; this suite covers the protocol that rooms run on — what a
 * client sees when someone joins, sends chat, or leaves, what the server
 * refuses to relay, and what an evicted user's sockets are told.
 *
 * Everything runs over real websockets against the real src/index.js with the
 * Mongoose models stubbed, so no MongoDB is needed.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioClient } = require('socket.io-client');

const {
  start,
  stop,
  api,
  signup,
  createMeeting,
  store,
  tokenFor,
  baseUrl,
} = require('./helpers/app.js');
const { connect, joinRoom, waitForEvent, sleep } = require('./helpers/sockets.js');

/**
 * Like waitForEvent, but for events that may legitimately never arrive
 * (e.g. a first joiner hears no 'peer-joined'). Resolves null on timeout
 * instead of failing the test, and keeps the window short so a missing
 * event doesn't slow the suite down.
 */
function maybeEvent(socket, event, timeoutMs = 400) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/** Connects a raw client with an arbitrary (or missing) handshake token. */
function connectRaw(url, token) {
  return ioClient(url, {
    auth: token === undefined ? {} : { token },
    transports: ['websocket'],
    forceNew: true,
  });
}

/** Resolves with the handshake error message, or a note if it connected. */
function handshakeResult(url, token) {
  return new Promise((resolve) => {
    const socket = connectRaw(url, token);
    socket.on('connect_error', (err) => {
      resolve(String(err?.message || err));
      socket.close();
    });
    socket.on('connect', () => {
      resolve(`unexpectedly connected as ${socket.id}`);
      socket.close();
    });
  });
}

describe('socket protocol: join, chat relay and moderation events', () => {
  let host;
  let guest;

  before(async () => {
    await start();
    host = await signup('Host', 'socket-host@test.dev');
    guest = await signup('Guest', 'socket-guest@test.dev');
  });

  after(async () => {
    await stop();
  });

  async function createRoom() {
    const meeting = await createMeeting(host.token, 'Socket protocol test');
    const doc = store.meetings.find((m) => m._id === meeting._id);
    return { meeting, doc };
  }

  /**
   * Host + guest in the room, built fresh per test so sockets can't leak.
   * `hostPeerJoined` is what the host was told when the guest joined.
   */
  async function roomWithGuest() {
    const { meeting, doc } = await createRoom();
    const hostSock = await connect(baseUrl(), host.token);
    const hostView = await joinRoom(hostSock, meeting.roomCode);
    const guestSock = await connect(baseUrl(), guest.token);
    const peerJoined = maybeEvent(hostSock, 'peer-joined');
    const guestView = await joinRoom(guestSock, meeting.roomCode);
    const hostPeerJoined = await peerJoined;
    return { meeting, doc, hostSock, guestSock, hostView, guestView, hostPeerJoined };
  }

  /** Host alone in the room, so a test can bring in its own second socket. */
  async function roomWithHostOnly() {
    const { meeting, doc } = await createRoom();
    const hostSock = await connect(baseUrl(), host.token);
    await joinRoom(hostSock, meeting.roomCode);
    return { meeting, doc, hostSock };
  }

  // ---------------------------------------------------------------- join --

  test('an unauthenticated handshake is rejected', async () => {
    const message = await handshakeResult(baseUrl(), undefined);
    assert.match(message, /Missing auth token/i);
  });

  test('a tampered token is rejected', async () => {
    const [header, payload] = host.token.split('.');
    const message = await handshakeResult(baseUrl(), `${header}.${payload}.bogus-signature`);
    assert.match(message, /Invalid auth token/i);
  });

  test('joining an unknown room is refused without touching the roster', async () => {
    const before = store.meetings.map((m) => m.participants.length);

    const sock = await connect(baseUrl(), host.token);
    const error = waitForEvent(sock, 'error-message');
    sock.emit('join-room', { roomCode: 'NOPE-00' });

    assert.match((await error).error, /Room not found/i);
    assert.deepEqual(store.meetings.map((m) => m.participants.length), before);
    sock.disconnect();
  });

  test('the first joiner gets an empty peer list and the meeting records them', async () => {
    const { meeting, doc } = await createRoom();
    const sock = await connect(baseUrl(), host.token);
    const view = await joinRoom(sock, meeting.roomCode);

    assert.deepEqual(view.peers, []);
    assert.equal(doc.participants.includes(host.user.id), true);

    sock.disconnect();
  });

  test('the second joiner sees the first, and the first is told about the second', async () => {
    const { doc, hostSock, guestSock, guestView, hostPeerJoined } = await roomWithGuest();

    // The newcomer's roster excludes themselves but includes the earlier peer —
    // and nothing else, so names stay useful and emails stay private.
    assert.deepEqual(guestView.peers, [{ socketId: hostSock.id, name: host.user.name }]);
    assert.deepEqual(Object.keys(guestView.peers[0]).sort(), ['name', 'socketId']);
    // The earlier peer is told exactly who arrived.
    assert.deepEqual(hostPeerJoined, { socketId: guestSock.id, name: guest.user.name });
    // One participant record per user, even after both have joined.
    assert.equal(doc.participants.filter((id) => id === host.user.id).length, 1);
    assert.equal(doc.participants.filter((id) => id === guest.user.id).length, 1);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a pre-added member joining is announced but not duplicated', async () => {
    const { meeting, doc } = await createRoom();
    doc.participants.push(guest.user.id);

    const hostSock = await connect(baseUrl(), host.token);
    await joinRoom(hostSock, meeting.roomCode);
    const peerJoined = maybeEvent(hostSock, 'peer-joined');
    const guestSock = await connect(baseUrl(), guest.token);
    await joinRoom(guestSock, meeting.roomCode);

    assert.deepEqual(await peerJoined, { socketId: guestSock.id, name: guest.user.name });
    assert.equal(doc.participants.filter((id) => id === guest.user.id).length, 1);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a member with two tabs is one participant with two roster entries', async () => {
    const { meeting, doc } = await createRoom();
    const first = await connect(baseUrl(), guest.token);
    await joinRoom(first, meeting.roomCode);
    const second = await connect(baseUrl(), guest.token);
    const secondView = await joinRoom(second, meeting.roomCode);

    // The roster is per-socket, so the guest's second tab sees their first.
    assert.deepEqual(secondView.peers, [{ socketId: first.id, name: guest.user.name }]);
    assert.equal(doc.participants.filter((id) => id === guest.user.id).length, 1);

    first.disconnect();
    second.disconnect();
  });

  test('joining twice with the same socket is idempotent for the roster', async () => {
    const { meeting, doc } = await createRoom();
    const sock = await connect(baseUrl(), guest.token);
    await joinRoom(sock, meeting.roomCode);
    const again = await joinRoom(sock, meeting.roomCode);

    assert.deepEqual(again.peers, []);
    assert.equal(doc.participants.filter((id) => id === guest.user.id).length, 1);

    sock.disconnect();
  });

  // ---------------------------------------------------------- chat relay --

  test('a chat message is relayed to the room and persisted', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    const delivered = waitForEvent(hostSock, 'chat-message');
    guestSock.emit('chat-message', { roomCode: meeting.roomCode, text: '  hello host  ' });

    const message = await delivered;

    // Trimmed once, relayed and stored identically.
    assert.equal(message.text, 'hello host');
    assert.equal(message.senderName, guest.user.name);
    assert.equal(doc.chatMessages.length, 1);
    assert.equal(doc.chatMessages[0].text, 'hello host');
    assert.equal(doc.chatMessages[0].sender, guest.user.id);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('the sender hears their own message back', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();

    const echoed = waitForEvent(guestSock, 'chat-message');
    guestSock.emit('chat-message', { roomCode: meeting.roomCode, text: 'echo me' });

    const message = await echoed;
    assert.equal(message.text, 'echo me');
    assert.equal(message.senderName, guest.user.name);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a blank message is dropped silently', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    let broadcast = false;
    hostSock.on('chat-message', () => {
      broadcast = true;
    });
    guestSock.emit('chat-message', { roomCode: meeting.roomCode, text: '   ' });
    await sleep(150);

    assert.equal(broadcast, false);
    assert.equal(doc.chatMessages.length, 0);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a non-string message is dropped silently', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    let broadcast = false;
    hostSock.on('chat-message', () => {
      broadcast = true;
    });
    guestSock.emit('chat-message', { roomCode: meeting.roomCode, text: { nested: true } });
    await sleep(150);

    assert.equal(broadcast, false);
    assert.equal(doc.chatMessages.length, 0);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a message for a room the sender is not in is dropped silently', async () => {
    const { doc, hostSock, guestSock } = await roomWithGuest();

    let broadcast = false;
    hostSock.on('chat-message', () => {
      broadcast = true;
    });
    guestSock.emit('chat-message', { roomCode: 'NOPE-00', text: 'wrong room' });
    await sleep(150);

    assert.equal(broadcast, false);
    assert.equal(doc.chatMessages.length, 0);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a member who never joined the room cannot broadcast into it', async () => {
    const { meeting, doc, hostSock } = await roomWithHostOnly();

    // On the roster but never joined over the socket: the currentRoom guard
    // fires first, so there is no error event either.
    const listener = await connect(baseUrl(), guest.token);
    doc.participants.push(guest.user.id);
    let broadcast = false;
    hostSock.on('chat-message', () => {
      broadcast = true;
    });
    listener.emit('chat-message', { roomCode: meeting.roomCode, text: 'sneaking in' });
    await sleep(200);

    assert.equal(broadcast, false);
    assert.equal(doc.chatMessages.length, 0);

    listener.disconnect();
    hostSock.disconnect();
  });

  test('a user scrubbed from the roster behind their socket gets a membership error', async () => {
    const { meeting, doc, hostSock } = await roomWithHostOnly();

    // join-room auto-enrolls, so the guest joins and lands on the roster — then
    // the roster is rewritten underneath them (a removal whose eviction lost
    // the race, say). The DB write's membership filter is the backstop.
    const guestSock = await connect(baseUrl(), guest.token);
    await joinRoom(guestSock, meeting.roomCode);
    doc.participants = doc.participants.filter((id) => id !== guest.user.id);

    const error = waitForEvent(guestSock, 'error-message');
    guestSock.emit('chat-message', { roomCode: meeting.roomCode, text: 'still here' });

    assert.match((await error).error, /not a member of this room/i);
    assert.equal(doc.chatMessages.length, 0);

    guestSock.disconnect();
    hostSock.disconnect();
  });

  // ------------------------------------------------------------- leaving --

  test('leaving announces peer-left, and rejoining works without duplication', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    const peerLeft = waitForEvent(hostSock, 'peer-left');
    guestSock.emit('leave-room');

    const departure = await peerLeft;
    assert.equal(departure.socketId, guestSock.id);
    assert.equal(departure.name, guest.user.name);

    const back = await joinRoom(guestSock, meeting.roomCode);
    assert.deepEqual(back.peers, [{ socketId: hostSock.id, name: host.user.name }]);
    assert.equal(doc.participants.filter((id) => id === guest.user.id).length, 1);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a bare disconnect announces peer-left without an explicit leave', async () => {
    const { hostSock, guestSock } = await roomWithGuest();

    // The client clears its own id on disconnect, so capture it first.
    const guestSocketId = guestSock.id;
    const peerLeft = waitForEvent(hostSock, 'peer-left');
    guestSock.disconnect();

    const departure = await peerLeft;
    assert.equal(departure.socketId, guestSocketId);

    hostSock.disconnect();
  });

  test('each tab of a multi-tab member announces its own peer-left', async () => {
    const { meeting, hostSock } = await roomWithHostOnly();

    const tabA = await connect(baseUrl(), guest.token);
    await joinRoom(tabA, meeting.roomCode);
    const tabB = await connect(baseUrl(), guest.token);
    await joinRoom(tabB, meeting.roomCode);

    // Collect rather than awaiting two promises: every listener on the host's
    // socket sees every event, so two waitForEvent calls would both resolve
    // from the first announcement.
    const lefts = [];
    hostSock.on('peer-left', (p) => lefts.push(p));
    const [tabAId, tabBId] = [tabA.id, tabB.id]; // ids clear on disconnect
    tabA.disconnect();
    tabB.disconnect();
    await sleep(300);

    assert.deepEqual(lefts.map((p) => p.socketId).sort(), [tabAId, tabBId].sort());

    hostSock.disconnect();
  });

  // ------------------------------------------------------ signal relay ---

  test('a signal reaches only the addressed peer, stamped with the sender', async () => {
    const { hostSock, guestSock } = await roomWithGuest();

    const received = waitForEvent(guestSock, 'signal');
    const payload = { description: { type: 'offer', sdp: 'v=0...' } };
    hostSock.emit('signal', { to: guestSock.id, data: payload });

    const enveloped = await received;
    assert.equal(enveloped.from, hostSock.id);
    assert.equal(enveloped.name, host.user.name);
    assert.deepEqual(enveloped.data, payload);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a signal to an unknown socket id goes nowhere', async () => {
    const { hostSock, guestSock } = await roomWithGuest();

    let heard = false;
    guestSock.on('signal', () => {
      heard = true;
    });
    hostSock.emit('signal', { to: 'not-a-socket-id', data: { ice: 'candidate' } });
    await sleep(150);

    assert.equal(heard, false);

    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a signal from a socket outside the room is dropped', async () => {
    const { hostSock, guestSock } = await roomWithGuest();

    let heard = false;
    guestSock.on('signal', () => {
      heard = true;
    });

    // An authenticated socket that never joined can know a member's socket id
    // (event payloads carry them), so relaying must require sender membership
    // — the same guard that stops a member probing sockets outside the room.
    const outsider = await connect(baseUrl(), tokenFor({ id: 'e'.repeat(24) }));
    outsider.emit('signal', { to: guestSock.id, data: { ice: 'hostile' } });
    await sleep(150);

    assert.equal(heard, false);

    outsider.disconnect();
    hostSock.disconnect();
    guestSock.disconnect();
  });

  // ------------------------------------------------- moderation events ---

  test('eviction closes every tab of the removed user, and the room is told why', async () => {
    const { meeting, doc, hostSock } = await roomWithHostOnly();

    const tabA = await connect(baseUrl(), guest.token);
    await joinRoom(tabA, meeting.roomCode);
    const tabB = await connect(baseUrl(), guest.token);
    await joinRoom(tabB, meeting.roomCode);

    const noticeA = waitForEvent(tabA, 'removed-from-room');
    const noticeB = waitForEvent(tabB, 'removed-from-room');
    const lefts = [];
    hostSock.on('peer-left', (p) => lefts.push(p));
    const [tabAId, tabBId] = [tabA.id, tabB.id]; // ids clear on disconnect

    const res = await api(`/api/meetings/${meeting._id}/participants/${guest.user.id}?ban=true`, {
      method: 'DELETE',
      token: host.token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.evictedSockets, 2);
    assert.equal(doc.banned.includes(guest.user.id), true);

    assert.equal((await noticeA).banned, true);
    assert.equal((await noticeB).banned, true);
    await sleep(300);
    assert.deepEqual(lefts.map((p) => p.socketId).sort(), [tabAId, tabBId].sort());

    tabA.disconnect();
    tabB.disconnect();
    hostSock.disconnect();
  });

  test('a plain kick announces the removal but records no ban', async () => {
    const { meeting, doc, hostSock } = await roomWithHostOnly();

    const tab = await connect(baseUrl(), guest.token);
    await joinRoom(tab, meeting.roomCode);

    const notice = waitForEvent(tab, 'removed-from-room');
    const res = await api(`/api/meetings/${meeting._id}/participants/${guest.user.id}`, {
      method: 'DELETE',
      token: host.token,
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.evictedSockets, 1);
    assert.equal((await notice).banned, false);
    assert.equal(doc.banned.includes(guest.user.id), false);

    tab.disconnect();
    hostSock.disconnect();
  });

  test('a banned user who reconnects is refused at the door', async () => {
    const { meeting, doc, hostSock } = await roomWithHostOnly();
    // Ban a participant with no tab open — the removal endpoint only knows
    // users who are on the roster.
    doc.participants.push(guest.user.id);

    await api(`/api/meetings/${meeting._id}/participants/${guest.user.id}?ban=true`, {
      method: 'DELETE',
      token: host.token,
    });

    const returning = await connect(baseUrl(), guest.token);
    let sawRoomUsers = false;
    returning.on('room-users', () => {
      sawRoomUsers = true;
    });
    const rejection = waitForEvent(returning, 'error-message');
    returning.emit('join-room', { roomCode: meeting.roomCode });

    assert.match((await rejection).error, /removed from this meeting/i);
    await sleep(150);
    assert.equal(sawRoomUsers, false);
    assert.equal(doc.participants.includes(guest.user.id), false);

    returning.disconnect();
    hostSock.disconnect();
  });
});
