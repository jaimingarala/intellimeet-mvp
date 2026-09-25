/**
 * Pins how `check:turn` speaks to a TURN server over TCP, because getting this
 * wrong is invisible until it meets a real server.
 *
 * RFC 5389 §7.2.2: on a connection used for STUN alone, "no framing protocols are
 * used" — each message is read directly, its own header carrying the length. The
 * two-byte length prefix that older TURN-over-TCP write-ups describe is absent
 * from RFC 8656, and coturn treats a prefixed message as a message with a
 * nonsense type and answers nothing.
 *
 * This test exists in this shape for a specific reason: the first version of the
 * TCP transport *did* prefix, and the fake server it was tested against prefixed
 * too, so they agreed and both were wrong. The server below therefore parses the
 * way the RFC says, and checks the bytes the client actually put on the wire.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-turn.mjs');

const MAGIC_COOKIE = 0x2112a442;

const REALM = 'intellimeet.test';

function stunMessage(type, request, attributes) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  request.subarray(8, 20).copy(header, 8); // same transaction id
  return Buffer.concat([header, body]);
}

function attribute(type, value) {
  const padding = (4 - (value.length % 4)) % 4;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value, Buffer.alloc(padding)]);
}

/** A Binding success carrying an XOR-MAPPED-ADDRESS of 203.0.113.9:4444. */
function bindingSuccess(request) {
  const value = Buffer.alloc(8);
  value[1] = 0x01;
  value.writeUInt16BE(4444 ^ (MAGIC_COOKIE >>> 16), 2);
  const cookie = Buffer.alloc(4);
  cookie.writeUInt32BE(MAGIC_COOKIE, 0);
  [203, 0, 113, 9].forEach((byte, i) => {
    value[4 + i] = byte ^ cookie[i];
  });
  return stunMessage(0x0101, request, [attribute(0x0020, value)]);
}

/** The 401 challenge a TURN server sends to an unauthenticated Allocate. */
function unauthorized(request) {
  const errorCode = Buffer.alloc(4 + 'Unauthorized'.length);
  errorCode[2] = 4;
  errorCode[3] = 1;
  errorCode.write('Unauthorized', 4, 'utf8');
  return stunMessage(0x0113, request, [
    attribute(0x0009, errorCode),
    attribute(0x0014, Buffer.from(REALM)),
    attribute(0x0015, Buffer.from('a-nonce-value')),
  ]);
}

/**
 * Enough of a TURN server for the two steps before authentication: answer the
 * Binding, challenge the first Allocate, and then go quiet. Deliberately does
 * not accept anything, so the run still ends in a failure the test asserts on.
 */
function respondTo(request) {
  const type = request.readUInt16BE(0);
  if (type === 0x0001) return bindingSuccess(request);
  if (type === 0x0003 && !request.includes(Buffer.from('someone'))) return unauthorized(request);
  return null;
}

function runChecker(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [checker, ...args], {
      env: {
        ...process.env,
        NO_COLOR: '1',
        VITE_TURN_URLS: '',
        VITE_TURN_USERNAME: '',
        VITE_TURN_CREDENTIAL: '',
      },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

test('reads and writes unframed STUN over TCP, and understands the reply', async () => {
  const firstBytes = [];
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => {
      if (chunk.length < 20) return;
      const total = 20 + chunk.readUInt16BE(2);
      if (chunk.length < total) return;
      const request = chunk.subarray(0, total);
      firstBytes.push(request.readUInt16BE(0));
      const reply = respondTo(request);
      if (reply) socket.write(reply);
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const { code, stdout } = await runChecker([
      '--urls',
      `turn:127.0.0.1:${port}?transport=tcp`,
      '--username',
      'someone',
      '--credential',
      'secret',
      '--timeout',
      '600',
    ]);

    // The MAPPED address came back, so the reply was read the way the RFC
    // describes — which is only possible if the request was written that way too.
    assert.match(stdout, /✓ reachable\s+STUN answered — this host appears as 203\.0\.113\.9:4444/);

    // The Allocate was understood well enough to earn a challenge, so a second
    // TURN request also went over the wire correctly.
    assert.match(stdout, new RegExp(`✓ challenge\\s+realm "${REALM}"`));

    // The bytes themselves: a Binding request, then the Allocate and its
    // authenticated retry — message types, never a two-byte length prefix. This
    // is the assertion that would have caught the original bug, which the earlier
    // fake server happily agreed with because it made the same mistake.
    assert.equal(firstBytes[0], 0x0001, 'the first message should be a Binding request');
    assert.deepEqual(
      firstBytes.slice(1),
      [0x0003, 0x0003],
      `expected the unauthenticated Allocate and its authenticated retry, got ${firstBytes
        .map((type) => `0x${type.toString(16)}`)
        .join(', ')}`,
    );

    // The relay never authenticates anyone, so the run is expected to fail. The
    // failure is the *last* step, which also proves the earlier ones passed.
    assert.equal(code, 1);
    assert.match(stdout, /✗ relay/);
  } finally {
    server.close();
  }
});

test('a genuinely silent TCP port is reported as a timeout, not as success', async () => {
  const server = net.createServer((socket) => socket.on('error', () => {}));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    const { code, stdout } = await runChecker([
      '--urls',
      `turn:127.0.0.1:${port}?transport=tcp`,
      '--username',
      'someone',
      '--credential',
      'secret',
      '--timeout',
      '300',
    ]);

    assert.equal(code, 1);
    assert.match(stdout, /no response within/);
    assert.doesNotMatch(stdout, /✓ relay/);
  } finally {
    server.close();
  }
});
