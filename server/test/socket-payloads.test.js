/**
 * What a socket may send, and what happens when it sends something else.
 *
 * Two failure modes are covered here, and they are different problems:
 *
 *   1. A *malformed* payload. The handlers used to destructure their argument in
 *      the signature (`async ({ roomCode }) => …`), which throws on a client that
 *      emits with no argument at all — and a throw inside an async listener is an
 *      unhandled rejection, so the client is told nothing and hangs. Every
 *      payload is now guarded, and this suite is what proves it.
 *
 *   2. An *outsized* payload. The signalling relay never looks inside an SDP,
 *      but "opaque" is not "unbounded": without a cap two members could use the
 *      relay to move arbitrary amounts of data at the server's expense. Same for
 *      chat, which costs a database write and a broadcast per message.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, signup, createMeeting, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, waitForEvent, sleep } = require('./helpers/sockets.js');
const limits = require('../src/config/limits.js');

describe('socket payload guards', () => {
  let host;

  before(async () => {
    await start();
    host = await signup('Host', 'payload-host@test.dev');
  });

  after(async () => {
    await stop();
  });

  async function fixture() {
    const meeting = await createMeeting(host.token, 'Payloads');
    return meeting;
  }

  test('a join with no payload is answered, and leaves the socket usable', async () => {
    const meeting = await fixture();
    const socket = await connect(baseUrl(), host.token);

    const refusal = waitForEvent(socket, 'error-message');
    socket.emit('join-room');

    assert.match((await refusal).error, /valid roomCode/);

    // The socket is not wedged: the same connection can still join properly.
    await joinRoom(socket, meeting.roomCode);
    socket.disconnect();
  });

  test('a room code that is not a string, or is over the cap, is refused', async () => {
    const socket = await connect(baseUrl(), host.token);

    for (const roomCode of [
      { roomCode: 12 },
      { roomCode: 'r'.repeat(limits.MAX_ROOM_CODE_CHARS + 1) },
      { roomCode: { $ne: null } },
      { roomCode: '' },
    ]) {
      const refusal = waitForEvent(socket, 'error-message');
      socket.emit('join-room', roomCode);
      // eslint-disable-next-line no-await-in-loop
      assert.match((await refusal).error, /valid roomCode/, JSON.stringify(roomCode));
    }

    socket.disconnect();
  });

  test('a chat emitted with no payload is ignored rather than crashing the server', async () => {
    const meeting = await fixture();
    const socket = await connect(baseUrl(), host.token);
    await joinRoom(socket, meeting.roomCode);

    let heard = false;
    socket.on('chat-message', () => {
      heard = true;
    });

    socket.emit('chat-message');
    socket.emit('chat-message', null);
    socket.emit('chat-message', { roomCode: meeting.roomCode });
    await sleep(150);
    assert.equal(heard, false);

    // Still alive and relaying: the guard skipped the bad ones, it didn't break
    // the handler.
    const delivered = waitForEvent(socket, 'chat-message');
    socket.emit('chat-message', { roomCode: meeting.roomCode, text: 'still here' });
    assert.equal((await delivered).text, 'still here');
    socket.disconnect();
  });

  test('an oversized signalling payload is refused and never relayed', async () => {
    const meeting = await fixture();
    const alice = await connect(baseUrl(), host.token);
    const bob = await connect(baseUrl(), host.token);
    await joinRoom(alice, meeting.roomCode);
    await joinRoom(bob, meeting.roomCode);

    let relayed = false;
    bob.on('signal', () => {
      relayed = true;
    });

    const refusal = waitForEvent(alice, 'error-message');
    alice.emit('signal', {
      to: bob.id,
      data: { type: 'offer', sdp: 'v=0'.repeat(limits.MAX_SIGNAL_CHARS) },
    });

    assert.match((await refusal).error, /Signalling payloads are limited/);
    await sleep(150);
    assert.equal(relayed, false);

    alice.disconnect();
    bob.disconnect();
  });

  test('a normal offer still reaches its target', async () => {
    const meeting = await fixture();
    const alice = await connect(baseUrl(), host.token);
    const bob = await connect(baseUrl(), host.token);
    await joinRoom(alice, meeting.roomCode);
    await joinRoom(bob, meeting.roomCode);

    const arrived = waitForEvent(bob, 'signal');
    alice.emit('signal', {
      to: bob.id,
      data: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1' },
    });

    const signal = await arrived;
    assert.equal(signal.from, alice.id);
    assert.equal(signal.data.type, 'offer');
    assert.match(signal.data.sdp, /v=0/);

    alice.disconnect();
    bob.disconnect();
  });

  test('a chat flood is cut off without costing the room a write per message', async () => {
    const meeting = await fixture();
    const flooder = await signup('Flooder', 'flooder@test.dev');
    const socket = await connect(baseUrl(), flooder.token);
    await joinRoom(socket, meeting.roomCode);

    // The cap is data, not a literal in the handler, so the test can shrink it
    // instead of sending thirty messages.
    const original = limits.CHAT_RATE_LIMIT.max;
    limits.CHAT_RATE_LIMIT.max = 3;
    try {
      const sent = [];
      for (let i = 0; i < 3; i += 1) {
        const delivered = waitForEvent(socket, 'chat-message');
        socket.emit('chat-message', { roomCode: meeting.roomCode, text: `message ${i}` });
        // eslint-disable-next-line no-await-in-loop
        sent.push((await delivered).text);
      }
      assert.deepEqual(sent, ['message 0', 'message 1', 'message 2']);

      const refusal = waitForEvent(socket, 'error-message');
      socket.emit('chat-message', { roomCode: meeting.roomCode, text: 'one too many' });

      assert.match((await refusal).error, /sending messages too quickly/);
    } finally {
      limits.CHAT_RATE_LIMIT.max = original;
      socket.disconnect();
    }
  });
});
