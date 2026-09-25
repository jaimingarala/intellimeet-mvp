/**
 * Checks the STUN codec behind `npm run check:turn` against the published test
 * vectors in RFC 5769.
 *
 * Why this is worth a test of its own: a hand-written MESSAGE-INTEGRITY that is
 * subtly wrong looks perfectly reasonable and fails against *every* real TURN
 * server, so `check:turn` would report a false failure and send whoever ran it
 * hunting for a network problem that doesn't exist. The vectors below are
 * byte-for-byte what the IETF says a correct implementation emits, including
 * values deliberately sized to require attribute padding.
 *
 * Appendix A of RFC 5769 gives the same messages as C string literals.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ATTR,
  CLASS,
  METHOD,
  longTermKey,
  messageType,
  parseMessage,
  readAddress,
  verifyMessageIntegrity,
  withMessageIntegrity,
} from '../check-turn.mjs';

// 2.1 Sample Request (short-term credential, FINGERPRINT after MESSAGE-INTEGRITY)
const SAMPLE_REQUEST =
  '00010058' +
  '2112a442' +
  'b7e7a701bc34d686fa87dfae' +
  '80220010' +
  '5354554e207465737420636c69656e74' +
  '00240004' +
  '6e0001ff' +
  '80290008' +
  '932ff9b151263b36' +
  '00060009' +
  '6576746a3a68367659202020' +
  '00080014' +
  '9aeaa70cbfd8cb56781ef2b5b2d3f249c1b571a2' +
  '80280004' +
  'e57a3bcf';

// 2.2 Sample IPv4 Response (mapped address 192.0.2.1:32853)
const SAMPLE_IPV4_RESPONSE =
  '0101003c' +
  '2112a442' +
  'b7e7a701bc34d686fa87dfae' +
  '8022000b' +
  '7465737420766563746f7220' +
  '00200008' +
  '0001a147' +
  'e112a643' +
  '00080014' +
  '2b91f599fd9e90c38c7489f92af9ba53f06be7d7' +
  '80280004' +
  'c07d4c96';

// 2.3 Sample IPv6 Response (mapped address [2001:db8:1234:5678:11:2233:4455:6677]:32853)
const SAMPLE_IPV6_RESPONSE =
  '01010048' +
  '2112a442' +
  'b7e7a701bc34d686fa87dfae' +
  '8022000b' +
  '7465737420766563746f7220' +
  '00200014' +
  '0002a147' +
  '0113a9faa5d3f179bc25f4b5bed2b9d9' +
  '00080014' +
  'a382954e4be67bf11784c97c8292c275bfe3ed41' +
  '80280004' +
  'c8fb0b4c';

// 2.4 Sample Request with Long-Term Authentication
const SAMPLE_LONG_TERM_REQUEST =
  '00010060' +
  '2112a442' +
  '78ad3433c6ad72c029da412e' +
  '00060012' +
  'e3839ee38388e383aae38383e382afe382b90000' +
  '0015001c' +
  '662f2f3439396b39353464364f4c33346f4c39465354767936347341' +
  '0014000b' +
  '6578616d706c652e6f726700' +
  '00080014' +
  'f67024656dd64a3e02b8e0712e85c9a28ca89666';

// The documented parameters for 2.4. The username is given as code points
// because RFC 5769 spells it as six katakana characters, and the password is the
// SASLprep-processed form ("TheMatrIX") rather than the raw, punctuated one.
const LONG_TERM_USERNAME = String.fromCodePoint(0x30de, 0x30c8, 0x30ea, 0x30c3, 0x30af, 0x30b9);
const LONG_TERM_PASSWORD = 'TheMatrIX';
const LONG_TERM_REALM = 'example.org';
const SHORT_TERM_PASSWORD = 'VOkJxbRl1RmTxUk/WvJxBt';

const bytes = (hex) => Buffer.from(hex, 'hex');
const utf8 = (value) => Buffer.from(value, 'utf8');

/** Everything before the trailing MESSAGE-INTEGRITY attribute. */
function unsigned(messageHex, trailingHexLength) {
  return bytes(messageHex).subarray(0, (messageHex.length - trailingHexLength) / 2);
}

test('matches the MESSAGE-INTEGRITY of RFC 5769 §2.1, a short-term credential request', () => {
  const signed = withMessageIntegrity(
    unsigned(SAMPLE_REQUEST, 64), // MESSAGE-INTEGRITY (24 bytes) + FINGERPRINT (8)
    utf8(SHORT_TERM_PASSWORD),
  );

  // The RFC's sample carries a FINGERPRINT after MESSAGE-INTEGRITY and so
  // declares 88 bytes; ours ends at MESSAGE-INTEGRITY, so it declares 80. The
  // integrity value itself has to match the RFC's exactly.
  assert.equal(signed.length, 100);
  assert.equal(signed.readUInt16BE(2), 80);
  assert.equal(signed.subarray(76).toString('hex'), SAMPLE_REQUEST.slice(152, 200));
  assert.ok(verifyMessageIntegrity(parseMessage(signed), utf8(SHORT_TERM_PASSWORD)));
});

test('matches RFC 5769 §2.4, a long-term credential request', () => {
  const key = longTermKey(LONG_TERM_USERNAME, LONG_TERM_REALM, LONG_TERM_PASSWORD);
  const signed = withMessageIntegrity(unsigned(SAMPLE_LONG_TERM_REQUEST, 48), key);

  assert.equal(signed.toString('hex'), SAMPLE_LONG_TERM_REQUEST);
  assert.equal(signed.length, 116);
});

test('recomputes the HMAC of RFC 5769 §2.4 from the raw bytes', () => {
  const key = longTermKey(LONG_TERM_USERNAME, LONG_TERM_REALM, LONG_TERM_PASSWORD);
  const parsed = parseMessage(bytes(SAMPLE_LONG_TERM_REQUEST));

  assert.ok(parsed, 'the sample should parse');
  assert.equal(parsed.transactionId.toString('hex'), '78ad3433c6ad72c029da412e');
  assert.ok(verifyMessageIntegrity(parsed, key));
});

test('verifies a short-term response that carries a FINGERPRINT after MESSAGE-INTEGRITY', () => {
  // This is the case that pins the length convention: the HMAC covers the
  // message only up to MESSAGE-INTEGRITY, with the length field adjusted to
  // match, while the bytes on the wire declare the full 60-byte body including
  // the trailing FINGERPRINT. Get that wrong and every real server rejects us.
  const parsed = parseMessage(bytes(SAMPLE_IPV4_RESPONSE));
  assert.equal(parsed.bytes.readUInt16BE(2), 60);
  assert.ok(verifyMessageIntegrity(parsed, utf8(SHORT_TERM_PASSWORD)));
});

test('rejects the wrong credential rather than accepting anything', () => {
  const key = longTermKey(LONG_TERM_USERNAME, LONG_TERM_REALM, 'not-the-password');
  assert.equal(verifyMessageIntegrity(parseMessage(bytes(SAMPLE_LONG_TERM_REQUEST)), key), false);
});

test('decodes the IPv4 XOR-MAPPED-ADDRESS of §2.2', () => {
  const parsed = parseMessage(bytes(SAMPLE_IPV4_RESPONSE));
  const address = readAddress(parsed, ATTR.XOR_MAPPED_ADDRESS, ATTR.MAPPED_ADDRESS);
  assert.deepEqual(address, { address: '192.0.2.1', port: 32853 });
});

test('decodes the IPv6 XOR-MAPPED-ADDRESS of §2.3', () => {
  // Exercises the IPv6 branch, where the address is xored with the cookie and
  // the transaction id concatenated.
  const parsed = parseMessage(bytes(SAMPLE_IPV6_RESPONSE));
  const address = readAddress(parsed, ATTR.XOR_MAPPED_ADDRESS, ATTR.MAPPED_ADDRESS);
  assert.deepEqual(address, {
    address: '2001:db8:1234:5678:11:2233:4455:6677',
    port: 32853,
  });
});

test('parses attribute padding without losing the following attribute', () => {
  // §2.1's SOFTWARE is 16 bytes (no padding) but its USERNAME is 9, padded with
  // three spaces — if padding is mishandled the trailing attributes are lost.
  const parsed = parseMessage(bytes(SAMPLE_REQUEST));
  const types = parsed.attributes.map((entry) => entry.type);

  assert.deepEqual(types, [
    0x8022, // SOFTWARE
    0x0024, // PRIORITY
    0x8029, // ICE-CONTROLLED
    0x0006, // USERNAME
    0x0008, // MESSAGE-INTEGRITY
    0x8028, // FINGERPRINT
  ]);
  const username = parsed.attributes[3].value;
  assert.equal(username.subarray(0, 9).toString('utf8'), 'evtj:h6vY');
});

test('packs the interleaved method and class bits correctly', () => {
  // The famous ones: an Allocate success response is 0x0103, not 0x0302.
  assert.equal(messageType(METHOD.allocate, CLASS.success), 0x0103);
  assert.equal(messageType(METHOD.allocate, CLASS.error), 0x0113);
  assert.equal(messageType(METHOD.binding, CLASS.request), 0x0001);
  assert.equal(messageType(METHOD.binding, CLASS.success), 0x0101);
});
