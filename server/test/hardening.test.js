/**
 * Abuse protection: the summarize rate limit and the payload caps on
 * transcripts, meeting titles and chat messages.
 *
 * The summarize limiter is per user and lives in the route module's memory, so
 * the rate-limit test at the end uses a user of its own and the earlier tests
 * stay well inside the budget.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, signup, createMeeting, store, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, waitForEvent, sleep } = require('./helpers/sockets.js');
const limits = require('../src/config/limits.js');

describe('abuse protection', () => {
  let host;

  before(async () => {
    await start();
    host = await signup('Host', 'limits-host@test.dev');
  });

  after(async () => {
    await stop();
  });

  async function fixture() {
    const meeting = await createMeeting(host.token, 'Limits');
    const doc = store.meetings.find((m) => m._id === meeting._id);
    return { meeting, doc };
  }

  const summarize = (id, body, token = host.token) =>
    api(`/api/meetings/${id}/summarize`, { method: 'POST', token, body });

  test('a meeting title over the cap is rejected', async () => {
    const res = await api('/api/meetings', {
      method: 'POST',
      token: host.token,
      body: { title: 't'.repeat(limits.MAX_TITLE_CHARS + 1) },
    });

    assert.equal(res.status, 413);
    assert.match(res.body.error, /title must be/);
  });

  test('a title at the cap is accepted', async () => {
    const res = await api('/api/meetings', {
      method: 'POST',
      token: host.token,
      body: { title: 't'.repeat(limits.MAX_TITLE_CHARS) },
    });

    assert.equal(res.status, 201);
  });

  test('a transcript over the cap is rejected without touching the meeting', async () => {
    const { meeting, doc } = await fixture();
    const before = doc.transcript;

    const res = await summarize(meeting._id, {
      transcript: 'x'.repeat(limits.MAX_TRANSCRIPT_CHARS + 1),
    });

    assert.equal(res.status, 413);
    assert.match(res.body.error, /transcript must be/);
    assert.equal(doc.transcript, before, 'a rejected request must not overwrite the transcript');
    assert.equal(doc.summary, '');
  });

  test('a transcript at the cap is accepted', async () => {
    const { meeting } = await fixture();

    const res = await summarize(meeting._id, {
      transcript: 'x'.repeat(limits.MAX_TRANSCRIPT_CHARS),
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.engine, 'offline-extractive');
  });

  test('a non-string transcript is rejected as a bad request', async () => {
    const { meeting } = await fixture();

    const res = await summarize(meeting._id, { transcript: { nested: 'object' } });

    assert.equal(res.status, 400);
  });

  test('the chat-derived transcript is bounded, and keeps the recent end', async () => {
    const { meeting, doc } = await fixture();
    // 60 × ~500 chars ≈ 30k, comfortably over the cap.
    for (let i = 0; i < 60; i += 1) {
      doc.chatMessages.push({
        sender: host.user.id,
        senderName: 'Host',
        text: `message ${i} ${'y'.repeat(480)}`,
        sentAt: new Date(),
      });
    }

    const res = await summarize(meeting._id, {});

    assert.equal(res.status, 200);
    assert.ok(doc.transcript.length <= limits.MAX_TRANSCRIPT_CHARS);
    assert.ok(
      doc.transcript.length > limits.MAX_TRANSCRIPT_CHARS - 600,
      'should be filled, not empty',
    );
    // The tail is kept: the last message must survive truncation.
    assert.match(doc.transcript, /message 59/);
  });

  test('an over-long chat message is rejected by the socket and never stored', async () => {
    const { meeting, doc } = await fixture();
    const sender = await connect(baseUrl(), host.token);
    await joinRoom(sender, meeting.roomCode);

    const rejected = waitForEvent(sender, 'error-message');
    let broadcast = false;
    sender.on('chat-message', () => {
      broadcast = true;
    });
    sender.emit('chat-message', {
      roomCode: meeting.roomCode,
      text: 'z'.repeat(limits.MAX_CHAT_MESSAGE_CHARS + 1),
    });

    const error = await rejected;
    await sleep(150);

    assert.match(error.error, /limited to/);
    assert.equal(broadcast, false);
    assert.equal(doc.chatMessages.length, 0);
    sender.disconnect();
  });

  test('a normal chat message is still broadcast and persisted', async () => {
    const { meeting, doc } = await fixture();
    const sender = await connect(baseUrl(), host.token);
    await joinRoom(sender, meeting.roomCode);

    const delivered = waitForEvent(sender, 'chat-message');
    sender.emit('chat-message', { roomCode: meeting.roomCode, text: '  hello room  ' });

    const message = await delivered;

    assert.equal(message.text, 'hello room');
    assert.equal(message.senderName, 'Host');
    assert.equal(doc.chatMessages.length, 1);
    assert.equal(doc.chatMessages[0].text, 'hello room');
    sender.disconnect();
  });

  test('a member who never joined the room cannot broadcast chat into it', async () => {
    const { meeting, doc } = await fixture();
    const listener = await connect(baseUrl(), host.token);
    await joinRoom(listener, meeting.roomCode);
    // Second socket for the same (participant) user, deliberately not joined.
    const outsider = await connect(baseUrl(), host.token);

    let heard = false;
    listener.on('chat-message', () => {
      heard = true;
    });
    outsider.emit('chat-message', { roomCode: meeting.roomCode, text: 'sneaking in' });
    await sleep(200);

    assert.equal(heard, false);
    assert.equal(doc.chatMessages.length, 0);
    listener.disconnect();
    outsider.disconnect();
  });

  test('one account cannot create meetings without limit', async () => {
    // A user of its own: the budget is per account, and the earlier tests in this
    // suite have been creating meetings as the host.
    const spammer = await signup('Spammer', 'meeting-spam@test.dev');
    const { max } = limits.MEETING_RATE_LIMIT;

    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const created = await createMeeting(spammer.token, `Spam ${i}`);
      assert.ok(created?.roomCode, `meeting ${i + 1} of ${max} should be created`);
    }

    const rejected = await api('/api/meetings', {
      method: 'POST',
      token: spammer.token,
      body: { title: 'one too many' },
    });

    assert.equal(rejected.status, 429);
    assert.match(rejected.body.error, /too many meetings/i);

    // Another account is unaffected — the budget is per account, not global.
    const fine = await createMeeting(host.token, 'Legitimate');
    assert.ok(fine.roomCode);
  });

  test('summaries are rate limited per user, not per IP', async () => {
    const { meeting, doc } = await fixture();
    const heavy = await signup('Heavy', 'heavy@test.dev');
    const other = await signup('Other', 'other@test.dev');
    doc.participants.push(heavy.user.id, other.user.id);
    const { max } = limits.SUMMARIZE_RATE_LIMIT;

    for (let i = 0; i < max; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const allowed = await summarize(meeting._id, { transcript: `attempt ${i}` }, heavy.token);
      assert.equal(allowed.status, 200, `request ${i + 1} of ${max} should be allowed`);
    }

    const limited = await summarize(meeting._id, { transcript: 'one too many' }, heavy.token);
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /too many summaries/i);

    // A different user on the same connection is unaffected — the budget is per
    // account, which is what makes it meaningful behind a proxy.
    const unaffected = await summarize(meeting._id, { transcript: 'fresh user' }, other.token);
    assert.equal(unaffected.status, 200);
  });
});
