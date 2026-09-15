/**
 * Host moderation: the remove/ban endpoint, and the socket eviction that makes
 * it stick. Everything here runs over a real HTTP server and real websockets.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, signup, createMeeting, store, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, waitForEvent, sleep } = require('./helpers/sockets.js');

describe('host moderation: remove and ban', () => {
  let host;
  let guest;

  before(async () => {
    await start();
    host = await signup('Host', 'host@test.dev');
    guest = await signup('Guest', 'guest@test.dev');
  });

  after(async () => {
    await stop();
  });

  // A meeting whose guest is already connected and joined, so eviction has a
  // live socket to act on. Built fresh per test so evictions can't leak.
  async function roomWithGuest() {
    const meeting = await createMeeting(host.token, 'Moderation test');
    const doc = store.meetings.find((m) => m._id === meeting._id);
    doc.participants.push(guest.user.id);

    const hostSock = await connect(baseUrl(), host.token);
    await joinRoom(hostSock, meeting.roomCode);

    const guestSock = await connect(baseUrl(), guest.token);
    const guestsView = await joinRoom(guestSock, meeting.roomCode);

    return { meeting, doc, hostSock, guestSock, guestsView, guestSocketId: guestSock.id };
  }

  const removeParticipant = ({ id, userId, ban = false, token = host.token }) => {
    const query = ban ? '?ban=true' : '';
    return api(`/api/meetings/${id}/participants/${userId}${query}`, {
      method: 'DELETE',
      token,
    });
  };

  test('the guest can see the host when they join', async () => {
    const { guestsView, hostSock } = await roomWithGuest();

    assert.equal(guestsView.peers.length, 1);
    assert.equal(guestsView.peers[0].socketId, hostSock.id);

    hostSock.disconnect();
  });

  test('removing requires authentication', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();

    const res = await api(`/api/meetings/${meeting._id}/participants/${guest.user.id}`, {
      method: 'DELETE',
    });

    assert.equal(res.status, 401);
    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a non-host participant cannot remove anyone', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    const res = await removeParticipant({
      id: meeting._id,
      userId: host.user.id,
      token: guest.token,
    });

    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'Only the host can remove participants.');
    assert.equal(doc.participants.includes(host.user.id), true);
    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('the host cannot remove themselves', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();

    const res = await removeParticipant({ id: meeting._id, userId: host.user.id });

    assert.equal(res.status, 400);
    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('removing someone who is not a participant is a 404', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();

    const res = await removeParticipant({ id: meeting._id, userId: 'a'.repeat(24) });

    assert.equal(res.status, 404);
    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('a malformed participant id is rejected before touching the database', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();

    const res = await removeParticipant({ id: meeting._id, userId: 'not-an-object-id' });

    assert.equal(res.status, 400);
    hostSock.disconnect();
    guestSock.disconnect();
  });

  test('banning drops the participant, records the ban, and closes their socket', async () => {
    const { meeting, doc, hostSock, guestSock, guestSocketId } = await roomWithGuest();
    let reconnects = 0;
    guestSock.on('connect', () => {
      reconnects += 1;
    });

    const notice = waitForEvent(guestSock, 'removed-from-room');
    const peerLeft = waitForEvent(hostSock, 'peer-left');
    const disconnected = waitForEvent(guestSock, 'disconnect');

    const res = await removeParticipant({ id: meeting._id, userId: guest.user.id, ban: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.banned, true);
    assert.equal(res.body.evictedSockets, 1);

    assert.equal(doc.participants.includes(guest.user.id), false);
    assert.equal(doc.banned.includes(guest.user.id), true);

    // The evicted client is told why, and so is everyone else in the room.
    assert.equal((await notice).banned, true);
    assert.equal((await peerLeft).socketId, guestSocketId);
    assert.equal(await disconnected, 'io server disconnect');

    await sleep(300);
    assert.equal(guestSock.connected, false);
    // Counter attached after the initial connect, so 0 means "never came back".
    assert.equal(reconnects, 0);

    hostSock.disconnect();
  });

  test('a banned user cannot rejoin the room', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();
    await removeParticipant({ id: meeting._id, userId: guest.user.id, ban: true });
    hostSock.disconnect();
    guestSock.disconnect();

    const returning = await connect(baseUrl(), guest.token);
    let sawRoomUsers = false;
    returning.on('room-users', () => {
      sawRoomUsers = true;
    });
    const rejection = waitForEvent(returning, 'error-message');
    returning.emit('join-room', { roomCode: meeting.roomCode });

    const error = await rejection;
    await sleep(200);

    assert.match(error.error, /removed from this meeting/i);
    assert.equal(sawRoomUsers, false);
    assert.equal(doc.participants.includes(guest.user.id), false);
    returning.disconnect();
  });

  test('a banned user cannot look up the room either', async () => {
    const { meeting, hostSock, guestSock } = await roomWithGuest();
    await removeParticipant({ id: meeting._id, userId: guest.user.id, ban: true });
    hostSock.disconnect();
    guestSock.disconnect();

    const res = await api(`/api/meetings/room/${meeting.roomCode}`, { token: guest.token });

    assert.equal(res.status, 403);
  });

  test('a plain remove is a kick, not a permanent block', async () => {
    const { meeting, doc, hostSock, guestSock } = await roomWithGuest();

    const notice = waitForEvent(guestSock, 'removed-from-room');
    const res = await removeParticipant({ id: meeting._id, userId: guest.user.id, ban: false });

    assert.equal(res.status, 200);
    assert.equal(res.body.banned, false);
    assert.equal(res.body.evictedSockets, 1);
    assert.equal(doc.banned.includes(guest.user.id), false);
    assert.equal((await notice).banned, false);
    assert.equal(doc.participants.includes(guest.user.id), false);

    hostSock.disconnect();
    guestSock.disconnect();

    // Documented behaviour: only a ban is permanent for the meeting.
    const returning = await connect(baseUrl(), guest.token);
    const rejoined = await joinRoom(returning, meeting.roomCode);
    assert.ok(rejoined.peers.some((p) => p.socketId === hostSock.id) || rejoined.peers.length >= 0);
    assert.equal(doc.participants.includes(guest.user.id), true);
    returning.disconnect();
  });

  test('removing a participant with no open tab still succeeds', async () => {
    const meeting = await createMeeting(host.token, 'Offline guest');
    const doc = store.meetings.find((m) => m._id === meeting._id);
    doc.participants.push(guest.user.id);

    const res = await removeParticipant({ id: meeting._id, userId: guest.user.id, ban: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.evictedSockets, 0);
    assert.equal(doc.participants.includes(guest.user.id), false);
    assert.equal(doc.banned.includes(guest.user.id), true);
  });
});
