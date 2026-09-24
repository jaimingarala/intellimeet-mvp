#!/usr/bin/env node
/**
 * Proves a TURN relay works *before* a demo, without needing two networks.
 *
 * Why this exists: TURN is the part of the call path that only fails on other
 * people's networks, and the cross-network smoke test in the README needs a
 * second machine, a second connection and a person. Almost every TURN failure is
 * one of four things — the port is firewalled, the credentials are wrong, the
 * credential format is wrong for how the server authenticates, or the relay is
 * out of capacity — and all four are answerable from a single host by speaking
 * TURN to the server directly.
 *
 * It implements just enough of RFC 5389 (STUN) and RFC 8656 (TURN) to do a
 * Binding request and an authenticated Allocate: the 401 challenge with a realm
 * and nonce, long-term credentials, and MESSAGE-INTEGRITY (HMAC-SHA1). It also
 * *verifies* the integrity of the response rather than trusting it, so a success
 * here means the server accepted our credential — not merely that it answered.
 *
 * Dependency-free on purpose, like scripts/dev.mjs and server/src/services/
 * roomCode.js: Node's own `dgram`, `net` and `tls` are the entire client.
 *
 * What this can't prove: that the relay *forwards* media. Doing so needs a peer
 * the TURN server can reach, so that half stays with the two-network smoke test.
 * This rules out the failure modes that make that test fail for boring reasons.
 */
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --- STUN/TURN protocol ------------------------------------------------------
//
// These primitives are exported so scripts/test/stun.test.mjs can check them
// against the published test vectors in RFC 5769. A hand-written MESSAGE-
// INTEGRITY that is subtly wrong fails every real TURN server while looking
// perfectly reasonable here, so the wire format gets checked against the RFC
// and not only against this file's own server side.

const MAGIC_COOKIE = 0x2112a442;
const HEADER_SIZE = 20;
const INTEGRITY_ATTRIBUTE_SIZE = 24; // 4-byte header + 20-byte HMAC-SHA1

// Request/response classes and the methods this tool needs, from RFC 5389 §6
// and RFC 8656 §4. Method names line up with the constants because the wire
// format interleaves them (see `messageType`).
const CLASS = { request: 0x00, indication: 0x01, success: 0x02, error: 0x03 };
const METHOD = { binding: 0x001, allocate: 0x003 };

const ATTR = {
  MAPPED_ADDRESS: 0x0001,
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  LIFETIME: 0x000d,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
};

const REQUESTED_TRANSPORT_UDP = 17;

/**
 * Pack a method and class into the 14-bit STUN type field. The bits are
 * interleaved on the wire (M11 M10 M9 M8 M7 C1 M6 M5 M4 C0 M3 M2 M1 M0), so the
 * method shifts around the two class bits — which is why this is arithmetic and
 * not `method | class << 4`.
 */
function messageType(method, cls) {
  return (
    (method & 0x000f) |
    ((method & 0x0070) << 1) |
    ((method & 0x0f80) << 2) |
    ((cls & 0x01) << 4) |
    ((cls & 0x02) << 7)
  );
}

function decodeType(type) {
  return {
    cls: ((type >> 4) & 0x01) | ((type >> 7) & 0x02),
    method: (type & 0x000f) | ((type >> 1) & 0x0070) | ((type >> 2) & 0x0f80),
  };
}

const CLASS_NAMES = ['request', 'indication', 'success', 'error'];

/** One TLV attribute, padded to a 4-byte boundary. */
function attribute(type, value) {
  const padding = (4 - (value.length % 4)) % 4;
  const header = Buffer.alloc(4);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(value.length, 2);
  return Buffer.concat([header, value, Buffer.alloc(padding)]);
}

function text(value) {
  return Buffer.from(String(value), 'utf8');
}

function buildMessage({ method, cls, transactionId, attributes = [] }) {
  const body = Buffer.concat(attributes);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt16BE(messageType(method, cls), 0);
  header.writeUInt16BE(body.length, 2);
  header.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(header, 8);
  return Buffer.concat([header, body]);
}

/**
 * Append MESSAGE-INTEGRITY, computed over everything before it.
 *
 * Two things have to agree here and it is easy to get one of them wrong. The
 * HMAC covers the message *including* the integrity attribute's own header, so
 * it is computed with the length field already widened to include it. And the
 * buffer that actually goes on the wire must carry that same widened length —
 * otherwise the receiver stops parsing at the old boundary and never sees the
 * attribute at all, which every real TURN server reports as a version or length
 * mismatch.
 */
function withMessageIntegrity(message, key) {
  const signed = Buffer.from(message);
  signed.writeUInt16BE(message.length - HEADER_SIZE + INTEGRITY_ATTRIBUTE_SIZE, 2);
  const hmac = crypto.createHmac('sha1', key).update(signed).digest();
  return Buffer.concat([signed, attribute(ATTR.MESSAGE_INTEGRITY, hmac)]);
}

/** Long-term credential key: MD5(username ":" realm ":" password). */
function longTermKey(username, realm, password) {
  return crypto.createHash('md5').update(`${username}:${realm}:${password}`, 'utf8').digest();
}

function parseMessage(buffer) {
  if (buffer.length < HEADER_SIZE) return null;
  if (buffer.readUInt32BE(4) !== MAGIC_COOKIE) return null;

  const length = buffer.readUInt16BE(2);
  const total = HEADER_SIZE + length;
  if (buffer.length < total) return null;

  const bytes = buffer.subarray(0, total);
  const attributes = [];
  let offset = HEADER_SIZE;
  while (offset + 4 <= total) {
    const type = bytes.readUInt16BE(offset);
    const size = bytes.readUInt16BE(offset + 2);
    attributes.push({
      type,
      offset,
      value: bytes.subarray(offset + 4, offset + 4 + size),
    });
    offset += 4 + Math.ceil(size / 4) * 4;
  }

  const { method, cls } = decodeType(bytes.readUInt16BE(0));
  return { method, cls, bytes, attributes, transactionId: bytes.subarray(8, 20) };
}

function findAttribute(parsed, type) {
  return parsed.attributes.find((entry) => entry.type === type) ?? null;
}

function attributeText(parsed, type) {
  const entry = findAttribute(parsed, type);
  return entry ? entry.value.toString('utf8') : null;
}

/**
 * Confirm a response really came from the holder of the credential. Without
 * this a 200-byte reply from anything on the port would look like success.
 */
function verifyMessageIntegrity(parsed, key) {
  const entry = findAttribute(parsed, ATTR.MESSAGE_INTEGRITY);
  if (!entry || entry.value.length !== 20) return false;

  const hashed = Buffer.from(parsed.bytes.subarray(0, entry.offset));
  hashed.writeUInt16BE(entry.offset + INTEGRITY_ATTRIBUTE_SIZE - HEADER_SIZE, 2);
  const expected = crypto.createHmac('sha1', key).update(hashed).digest();
  return crypto.timingSafeEqual(expected, entry.value);
}

/**
 * Decode an (XOR-)MAPPED/RELAYED-ADDRESS attribute. The XOR variant hides the
 * port behind the top half of the magic cookie and the address behind the whole
 * cookie (plus the transaction id for IPv6) so that naive NATs don't rewrite the
 * addresses as they rewrite the payload.
 */
function parseAddress(value, transactionId, { xor }) {
  if (value.length < 8) return null;
  const family = value[1];
  let port = value.readUInt16BE(2);
  let address;

  if (family === 0x01) {
    const raw = Buffer.from(value.subarray(4, 8));
    const decoded = xor ? raw.readUInt32BE(0) ^ MAGIC_COOKIE : raw.readUInt32BE(0);
    address = [24, 16, 8, 0].map((shift) => (decoded >>> shift) & 0xff).join('.');
  } else if (family === 0x02) {
    const raw = Buffer.from(value.subarray(4, 20));
    if (xor) {
      const mask = Buffer.concat([Buffer.alloc(4), transactionId]);
      const cookie = Buffer.alloc(4);
      cookie.writeUInt32BE(MAGIC_COOKIE, 0);
      for (let i = 0; i < 16; i += 1) raw[i] ^= (i < 4 ? cookie : mask)[i];
    }
    address = raw
      .toString('hex')
      .replace(/(.{4})(?=.)/g, '$1:')
      .replace(/\b0{1,3}/g, '')
      .toLowerCase();
  } else {
    return null;
  }

  if (xor) port ^= MAGIC_COOKIE >>> 16;
  return { address, port };
}

function formatAddress(entry) {
  if (!entry) return null;
  return entry.address.includes(':') ? `[${entry.address}]:${entry.port}` : `${entry.address}:${entry.port}`;
}

function readAddress(parsed, xorType, plainType) {
  const xorEntry = findAttribute(parsed, xorType);
  if (xorEntry) {
    const decoded = parseAddress(xorEntry.value, parsed.transactionId, { xor: true });
    if (decoded) return decoded;
  }
  const plain = findAttribute(parsed, plainType);
  if (plain) return parseAddress(plain.value, parsed.transactionId, { xor: false });
  return null;
}

/** ERROR-CODE is a class in the top byte and a number in the low 8 bits. */
function readError(parsed) {
  const entry = findAttribute(parsed, ATTR.ERROR_CODE);
  if (!entry || entry.value.length < 4) return { code: 0, reason: 'unknown error' };
  return {
    code: (entry.value[2] & 0x07) * 100 + entry.value[3],
    reason: entry.value.subarray(4).toString('utf8') || 'unknown error',
  };
}

/**
 * Turn a TURN error into the thing the operator should change. This is the part
 * that saves the debugging session; the numeric code alone helps nobody at 4pm
 * before a demo.
 */
function explain(error) {
  switch (error.code) {
    case 400:
      return 'the server rejected the request as malformed — unusual; check the server version';
    case 401:
      return 'the credential was not accepted — check VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL';
    case 403:
      return 'these credentials are not valid for this realm — if the server uses coturn\'s `use-auth-secret`, the credential must be a time-limited HMAC token, not the shared secret (try --secret)';
    case 404:
      return 'realm not found — the username may belong to a different TURN service';
    case 420:
      return 'the server does not support an attribute we sent';
    case 437:
      return 'the allocation was refused for the requested transport';
    case 438:
      return 'the nonce went stale mid-handshake — retrying usually clears this';
    case 441:
      return 'wrong credentials — if the server uses coturn\'s `use-auth-secret`, pass the shared secret with --secret';
    case 442:
      return 'UDP relay is unsupported here — try a TCP transport (turn:…?transport=tcp or turns:…)';
    case 486:
      return 'the server is at its allocation quota';
    case 500:
      return 'server error — check the relay\'s logs';
    case 508:
      return 'the relay has no capacity left (port range or quota exhausted) — the server is alive, so this is a server-side limit';
    default:
      return null;
  }
}

// --- transports --------------------------------------------------------------

/** A tiny awaitable queue over the messages a transport receives. */
function createMessageQueue() {
  const buffered = [];
  const waiters = [];

  function push(message) {
    const waiter = waiters.shift();
    if (!waiter) {
      buffered.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  function next(timeoutMs) {
    if (buffered.length) return Promise.resolve(buffered.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`no response within ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  function fail(error) {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  return { push, next, fail };
}

class UdpTransport {
  constructor({ host, port }) {
    this.host = host;
    this.port = port;
    // STUN retransmits with the same transaction id (RFC 5389 §7.2.1), so a lost
    // datagram doesn't have to look like a dead server.
    this.retransmits = true;
  }

  open() {
    this.queue = createMessageQueue();
    this.socket = dgram.createSocket(net.isIPv6(this.host) ? 'udp6' : 'udp4');
    this.socket.on('message', (message) => this.queue.push(message));
    this.socket.on('error', (err) => this.queue.fail(err));

    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.socket.once('error', onError);
      // A connected socket filters out datagrams from anyone else, which keeps a
      // stranger on the port from answering for the TURN server.
      this.socket.connect(this.port, this.host, () => {
        this.socket.removeListener('error', onError);
        resolve();
      });
    });
  }

  send(message) {
    return new Promise((resolve, reject) => {
      this.socket.send(message, (err) => (err ? reject(err) : resolve()));
    });
  }

  receive(timeoutMs) {
    return this.queue.next(timeoutMs);
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * TURN over TCP or TLS.
 *
 * A dedicated TCP/TLS connection carries STUN/TURN messages back to back with
 * no length prefix: each message's own header gives its length, which is what
 * RFC 5389 §7.2.2 means by "no framing protocols are used in connections to
 * those servers". (The two-byte length prefix that older TURN-over-TCP write-ups
 * describe does not appear in RFC 8656 at all, and coturn rejects it.) The only
 * frames that need demultiplexing are ChannelData, which begin with a channel
 * number rather than a message type.
 */
class StreamTransport {
  constructor({ host, port, secure, insecure }) {
    this.host = host;
    this.port = port;
    this.secure = secure;
    this.insecure = insecure;
    this.pending = Buffer.alloc(0);
    this.retransmits = false; // The stream is reliable; a resend would be a second request.
  }

  open() {
    this.queue = createMessageQueue();

    const options = { host: this.host, port: this.port };
    this.socket = this.secure
      ? tls.connect({
          ...options,
          // An IP address is not a valid SNI name, and verifying against it would
          // fail on a certificate issued for the hostname.
          servername: net.isIP(this.host) ? undefined : this.host,
          rejectUnauthorized: !this.insecure,
        })
      : net.connect(options);

    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => this.queue.fail(err));
    this.socket.on('close', () => this.queue.fail(new Error('the server closed the connection')));

    return new Promise((resolve, reject) => {
      this.socket.once(this.secure ? 'secureConnect' : 'connect', resolve);
      this.socket.once('error', reject);
    });
  }

  /**
   * Split the stream into messages. The first two bytes say which kind: a
   * ChannelData frame starts with a channel number (0x4000-0x7FFF), anything
   * lower is a STUN message whose length is in its own header.
   */
  onData(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      if (this.pending.length < 4) break;
      if (this.pending.readUInt16BE(0) < 0x4000) {
        if (this.pending.length < HEADER_SIZE) break;
        const total = HEADER_SIZE + this.pending.readUInt16BE(2);
        if (this.pending.length < total) break;
        const message = Buffer.from(this.pending.subarray(0, total));
        this.pending = this.pending.subarray(total);
        this.queue.push(message);
      } else {
        // ChannelData: channel number, then its own length. Nothing here binds a
        // channel, so it is skipped rather than delivered.
        const total = 4 + this.pending.readUInt16BE(2);
        if (this.pending.length < total) break;
        this.pending = this.pending.subarray(total);
      }
    }
  }

  send(message) {
    // No prefix, on purpose — see the class comment. A prefix makes every real
    // TURN server read the message type as a length and answer nothing.
    return new Promise((resolve, reject) => {
      this.socket.write(message, (err) => (err ? reject(err) : resolve()));
    });
  }

  receive(timeoutMs) {
    return this.queue.next(timeoutMs);
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      // Already gone.
    }
  }
}

function createTransport(target, options) {
  if (target.transport === 'udp') return new UdpTransport(target);
  return new StreamTransport({
    host: target.host,
    port: target.port,
    secure: target.transport === 'tls',
    insecure: options.insecure,
  });
}

// --- the check ---------------------------------------------------------------

async function exchange(transport, message, transactionId, options) {
  let lastError = new Error('no response');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    await transport.send(message);
    const deadline = Date.now() + options.timeoutMs;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        // eslint-disable-next-line no-await-in-loop
        const buffer = await transport.receive(remaining);
        // One message per try, because each message must be a reply to the
        // transaction we are waiting on, or it is someone else's.
        const parsed = parseMessage(buffer);
        if (parsed && parsed.transactionId.equals(transactionId)) {
          if (options.verbose) {
            say(
              `      ${color.dim('·')} ${color.dim(
                `${CLASS_NAMES[parsed.cls]} 0x${messageType(parsed.method, parsed.cls)
                  .toString(16)
                  .padStart(4, '0')} (${parsed.bytes.length} bytes)`
              )}`
            );
          }
          return parsed;
        }
      } catch (err) {
        lastError = err;
        break;
      }
    }

    lastError = lastError instanceof Error ? lastError : new Error(String(lastError));
    if (!transport.retransmits) break;
  }

  throw lastError;
}

function newTransactionId() {
  return crypto.randomBytes(12);
}

function requestedTransport() {
  const value = Buffer.alloc(4);
  value.writeUInt8(REQUESTED_TRANSPORT_UDP, 0);
  return value;
}

function allocateMessage(transactionId, auth) {
  const attributes = [attribute(ATTR.REQUESTED_TRANSPORT, requestedTransport())];
  if (auth) {
    attributes.push(
      attribute(ATTR.USERNAME, text(auth.username)),
      attribute(ATTR.REALM, text(auth.realm)),
      attribute(ATTR.NONCE, text(auth.nonce))
    );
  }
  return buildMessage({ method: METHOD.allocate, cls: CLASS.request, transactionId, attributes });
}

/**
 * A Binding request: no credentials, no state. Its only job is to separate "this
 * port speaks STUN" from "something is listening but it isn't a STUN server",
 * and to report how the server sees this host.
 */
async function tryBinding(transport, options) {
  const transactionId = newTransactionId();
  try {
    const response = await exchange(
      transport,
      buildMessage({ method: METHOD.binding, cls: CLASS.request, transactionId }),
      transactionId,
      options
    );
    return {
      ok: true,
      reflexive: readAddress(response, ATTR.XOR_MAPPED_ADDRESS, ATTR.MAPPED_ADDRESS),
      software: attributeText(response, ATTR.SOFTWARE),
    };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/** Describe reachability, preferring the binding reply when there was one. */
function reachableDetail(binding, note) {
  if (!binding.ok) return note;
  return (
    `STUN answered — this host appears as ${formatAddress(binding.reflexive) ?? 'an unknown address'}` +
    (binding.software ? ` ${color.dim(`(${binding.software})`)}` : '')
  );
}

/**
 * What a dead exchange usually means. Null when the error speaks for itself — a
 * wrong guess dressed up as advice is worse than no advice.
 */
function transportHint(err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/certificate|self-signed|unable to verify|CERT_/i.test(message)) {
    return 'the TLS certificate was rejected — a self-signed relay needs --insecure; a public one needs a valid certificate';
  }
  if (/closed the connection/i.test(message)) {
    return 'the server accepted the connection then closed it — is this port really a TURN listener?';
  }
  if (/ECONNREFUSED/i.test(message)) {
    return 'nothing is listening on that port — check the host and port';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    return 'the hostname did not resolve — check it for a typo';
  }
  if (/no response within/i.test(message)) {
    return 'no reply — the port is most likely firewalled; a TURN server also needs its relay port range open';
  }
  return null;
}

/**
 * Answer "will this relay work?" for one URL, in three steps: is it a STUN
 * server at all, does it challenge for credentials, and do ours allocate a
 * relay address?
 */
async function checkRelay(target, credentials, options) {
  const steps = [];
  const add = (name, ok, detail, extra = {}) => {
    steps.push({ name, ok, detail, ...extra });
    return steps.length;
  };
  const failStep = (name, detail, extra = {}) => {
    add(name, false, detail, extra);
    return { target, steps, ok: false };
  };

  const transport = createTransport(target, options);
  try {
    await transport.open();
  } catch (err) {
    // A TLS refusal lands here rather than in the exchange below, so the hint
    // has to travel with this failure too.
    const hint = transportHint(err);
    return failStep('reachable', `cannot open the connection: ${err.message}`, hint ? { hint } : {});
  }

  try {
    const binding = await tryBinding(transport, options);

    // TURN must answer an unauthenticated Allocate with 401 (or 438 if its nonce
    // just expired), carrying the realm and nonce the credential is scoped to.
    const challengeId = newTransactionId();
    const challenge = await exchange(
      transport,
      allocateMessage(challengeId),
      challengeId,
      options
    );

    const realm = attributeText(challenge, ATTR.REALM);
    const nonce = attributeText(challenge, ATTR.NONCE);

    if (challenge.cls !== CLASS.error) {
      // Some loopback and test relays allocate anonymously. Nothing was
      // authenticated, so say so rather than implying the credentials worked.
      const relayed = readAddress(challenge, ATTR.XOR_RELAYED_ADDRESS, ATTR.MAPPED_ADDRESS);
      add('reachable', true, reachableDetail(binding, 'TURN answered without a challenge'));
      add('challenge', true, 'not required — this server allocates anonymously', { soft: true });
      add(
        'relay',
        Boolean(relayed),
        relayed ? `${formatAddress(relayed)} (no authentication configured)` : 'no relay address on the response'
      );
      return { target, steps, ok: Boolean(relayed) };
    }

    const error = readError(challenge);
    const hint = explain(error);

    // Anything other than a credential challenge is a failure with its own
    // meaning — usually "the port belongs to something that isn't TURN".
    if ((error.code !== 401 && error.code !== 438) || !realm || !nonce) {
      add('reachable', true, reachableDetail(binding, `TURN answered ${error.code} ${error.reason}`));
      if (!realm || !nonce) {
        add('challenge', false, `challenged with ${error.code} ${error.reason} but no realm or nonce — not a TURN server?`);
      } else {
        add('challenge', false, `${error.code} ${error.reason}${hint ? ` — ${hint}` : ''}`);
      }
      return { target, steps, ok: false };
    }

    add('reachable', true, reachableDetail(binding, 'TURN answered'));
    add('challenge', true, `realm "${realm}", nonce issued for ${color.dim(credentials.username)}`);

    const key = longTermKey(credentials.username, realm, credentials.credential);
    const allocateId = newTransactionId();
    const allocation = await exchange(
      transport,
      withMessageIntegrity(allocateMessage(allocateId, { ...credentials, realm, nonce }), key),
      allocateId,
      options
    );

    if (allocation.cls === CLASS.error) {
      const failure = readError(allocation);
      const advice = explain(failure);
      return failStep('relay', `${failure.code} ${failure.reason}${advice ? ` — ${advice}` : ''}`);
    }

    // The reply has to be signed by whoever holds the credential; a device that
    // says yes to everything must not be able to pass this check.
    if (!verifyMessageIntegrity(allocation, key)) {
      return failStep(
        'relay',
        'the reply failed MESSAGE-INTEGRITY — refusing to trust an unauthenticated response'
      );
    }

    const relayed = readAddress(allocation, ATTR.XOR_RELAYED_ADDRESS, ATTR.MAPPED_ADDRESS);
    if (!relayed) return failStep('relay', 'the allocation succeeded but carried no relay address');

    const lifetime = findAttribute(allocation, ATTR.LIFETIME);
    add(
      'relay',
      true,
      `allocated ${formatAddress(relayed)}` +
        (lifetime && lifetime.value.length >= 4
          ? color.dim(` (lifetime ${lifetime.value.readUInt32BE(0)}s)`)
          : '')
    );
    return { target, steps, ok: true };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (!steps.some((step) => step.name === 'reachable' && step.ok)) {
      add('reachable', false, detail);
    }
    const hint = transportHint(err);
    add('relay', false, detail, hint ? { hint } : {});
    return { target, steps, ok: false };
  } finally {
    transport.close();
  }
}

// --- config ------------------------------------------------------------------

/** Minimal KEY=value reader, same shape as the one in scripts/dev.mjs. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const env = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseTurnUrl(value) {
  const raw = String(value).trim();
  const match = raw.match(/^(turns?):([^?]+)(?:\?(.*))?$/i);
  if (!match) {
    const hint = /^stuns?:/i.test(raw)
      ? 'a stun: server discovers addresses but cannot relay media — only turn:/turns: does'
      : 'expected a turn: or turns: URL';
    return { raw, error: hint };
  }

  const scheme = match[1].toLowerCase();
  const authority = match[2];
  const params = new URLSearchParams(match[3] || '');

  let host = authority;
  let port = '';
  const bracketed = authority.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] ?? '';
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon !== -1) {
      host = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }

  const transportParam = (params.get('transport') || '').toLowerCase();
  let transport;
  if (scheme === 'turns') transport = 'tls';
  else if (transportParam === 'tcp') transport = 'tcp';
  else if (transportParam === 'udp' || transportParam === '') transport = 'udp';
  else return { raw, error: `unsupported transport "${transportParam}"` };

  return {
    raw,
    url: raw,
    scheme,
    host,
    port: Number(port || (scheme === 'turns' ? 5349 : 3478)),
    transport,
  };
}

const USAGE = `
Usage: npm run check:turn [options]

  --urls <list>        comma-separated turn:/turns: URLs
                       (default: VITE_TURN_URLS from client/.env)
  --username <name>    TURN username                (default: VITE_TURN_USERNAME)
  --credential <pass>  TURN password                (default: VITE_TURN_CREDENTIAL)
  --secret <secret>    coturn static-auth-secret: mints a time-limited
                       credential instead of using a static password
  --ttl <seconds>      lifetime of a minted credential (default: 3600)
  --timeout <ms>       how long to wait for each reply (default: 4000)
  --env <file>         env file to read (default: client/.env)
  --insecure           do not verify the TLS certificate (dev relays only)
  -v, --verbose        print every message exchanged
  -h, --help           show this
`;

function parseArgs(argv) {
  const options = { urls: null, env: null, timeoutMs: 4000, insecure: false, verbose: false, ttl: 3600 };
  const takesValue = {
    '--urls': 'urls',
    '--username': 'username',
    '--credential': 'credential',
    '--secret': 'secret',
    '--ttl': 'ttl',
    '--timeout': 'timeoutMs',
    '--env': 'env',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      say(USAGE);
      process.exit(0);
    } else if (arg === '--insecure') {
      options.insecure = true;
    } else if (arg === '-v' || arg === '--verbose') {
      options.verbose = true;
    } else if (takesValue[arg]) {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      options[takesValue[arg]] = value;
      i += 1;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, ...rest] = arg.split('=');
      if (!takesValue[flag]) fail(`unknown option ${flag}`);
      options[takesValue[flag]] = rest.join('=');
    } else {
      fail(`unknown option ${arg}`);
    }
  }

  if (options.ttl !== 3600) options.ttl = Number(options.ttl);
  if (options.timeoutMs !== 4000) options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) fail('--timeout must be a positive number of milliseconds');
  if (!Number.isFinite(options.ttl) || options.ttl <= 0) fail('--ttl must be a positive number of seconds');
  return options;
}

/** coturn's REST credentials: username "expiry:label", password HMAC-SHA1(secret, username). */
function mintCredential(secret, label, ttl) {
  const username = `${Math.floor(Date.now() / 1000) + ttl}:${label}`;
  return { username, credential: crypto.createHmac('sha1', secret).update(username).digest('base64') };
}

// --- output ------------------------------------------------------------------

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, value) => (useColor ? `\x1b[${code}m${value}\x1b[0m` : value);
const color = {
  ok: (s) => paint('32', s),
  bad: (s) => paint('31', s),
  warn: (s) => paint('33', s),
  dim: (s) => paint('2', s),
  bold: (s) => paint('1', s),
};
const say = (line = '') => process.stdout.write(`${line}\n`);

function fail(message) {
  say(`${color.bad('✖')} ${message}`);
  process.exit(2);
}

function renderResult(result) {
  say('');
  say(
    `  ${color.bold(result.target.url)} ${color.dim(
      `(${result.target.transport} ${result.target.host}:${result.target.port})`
    )}`
  );
  for (const step of result.steps) {
    const mark = step.ok ? color.ok('✓') : step.soft ? color.warn('·') : color.bad('✗');
    say(`   ${mark} ${paint('2', step.name.padEnd(12))}${step.detail}`);
    if (step.hint) say(`     ${color.warn('→')} ${color.warn(step.hint)}`);
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envFile = path.resolve(root, options.env ?? 'client/.env');
  const fileEnv = readEnvFile(envFile);

  say('');
  say(`  ${color.bold('IntellMeet')} ${color.dim('— can the TURN relay actually be used?')}`);

  const urls = (options.urls ?? process.env.VITE_TURN_URLS ?? fileEnv.VITE_TURN_URLS ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    say('');
    say(`  ${color.bad('✖')} No TURN server is configured.`);
    say('');
    say(`  VITE_TURN_URLS is empty in ${path.relative(root, envFile)}, so ICE can only gather`);
    say('  direct and STUN candidates. Calls between two strict or symmetric NATs will not');
    say('  connect at all, and no amount of client debugging will fix it.');
    say('');
    say(`  Set VITE_TURN_URLS, VITE_TURN_USERNAME and VITE_TURN_CREDENTIAL there `);
    say('  (or pass --urls/--username/--credential) and run this again.');
    say('');
    process.exit(1);
  }

  const username = options.username ?? process.env.VITE_TURN_USERNAME ?? fileEnv.VITE_TURN_USERNAME ?? '';
  const credential = options.credential ?? process.env.VITE_TURN_CREDENTIAL ?? fileEnv.VITE_TURN_CREDENTIAL ?? '';
  const sharedSecret = options.secret ?? process.env.TURN_AUTH_SECRET ?? '';

  let credentials;
  if (sharedSecret) {
    credentials = mintCredential(sharedSecret, username || 'intellimeet', Number(options.ttl));
  } else {
    credentials = { username, credential };
  }

  say(
    `  ${color.dim('credentials')} ${
      sharedSecret
        ? `minted from a shared secret as ${credentials.username}`
        : username
          ? `${username} ${color.dim(`(from ${path.relative(root, envFile)})`)}`
          : color.warn('none configured')
    }`
  );

  if (!sharedSecret && (!username || !credential)) {
    say('');
    say(`  ${color.warn('!')} No TURN credentials found — the check will fail at the challenge step unless`);
    say('    the relay allows anonymous allocations. Set them, or pass --secret for coturn.');
  }
  if (options.insecure) {
    say(`  ${color.warn('!')} --insecure: TLS certificates are not being verified.`);
  }

  const targets = [];
  for (const url of urls) {
    const parsed = parseTurnUrl(url);
    if (parsed.error) fail(`${url}: ${parsed.error}`);
    targets.push(parsed);
  }

  const results = [];
  for (const target of targets) {
    // Sequential on purpose: one failure and one success read better interleaved
    // than a scrambled mess, and this is a handful of round trips.
    // eslint-disable-next-line no-await-in-loop
    results.push(await checkRelay(target, credentials, options));
    renderResult(results[results.length - 1]);
  }

  const usable = results.filter((result) => result.ok);
  const policy = (
    process.env.VITE_ICE_TRANSPORT_POLICY ??
    fileEnv.VITE_ICE_TRANSPORT_POLICY ??
    ''
  )
    .trim()
    .toLowerCase();

  say('');
  say(
    `  ${usable.length ? color.ok('✓') : color.bad('✖')} ${
      usable.length
        ? `${usable.length} of ${results.length} relay${results.length === 1 ? '' : 's'} allocated an address.`
        : 'No relay allocated an address.'
    }`
  );
  say(
    `  ${color.dim('ICE policy')} ${policy === 'relay' ? 'relay' : 'default (direct preferred)'}${
      policy === 'relay'
        ? ' — media will be forced through TURN, so each tile can be read as proof.'
        : ` — set VITE_ICE_TRANSPORT_POLICY=relay to force media through the relay.`
    }`
  );

  if (usable.length === 0) {
    say('');
    say('  A working relay is what makes the cross-network smoke test possible; fix the step');
    say('  marked ✗ above before trying it.');
  } else {
    say(`  ${color.dim('Not covered')} whether the relay forwards media — that needs a second network.`);
  }
  say('');

  process.exit(usable.length ? 0 : 1);
}

export {
  ATTR,
  CLASS,
  METHOD,
  attribute,
  buildMessage,
  longTermKey,
  messageType,
  parseAddress,
  parseMessage,
  readAddress,
  verifyMessageIntegrity,
  withMessageIntegrity,
};

// Importing this file (from the test vectors) must not run the check.
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  main().catch((err) => {
    say('');
    say(`${color.bad('✖')} ${err.stack || err.message}`);
    process.exit(2);
  });
}
