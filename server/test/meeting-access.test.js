/**
 * Meeting access control: who may create, read, summarize and end a meeting,
 * and what the dashboard list and the room-code lookup expose.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, signup, createMeeting, store } = require('./helpers/app.js');

describe('meeting access control', () => {
  let host;
  let outsider;

  before(async () => {
    await start();
    host = await signup('Host', 'host@test.dev');
    outsider = await signup('Outsider', 'outsider@test.dev');
  });

  after(async () => {
    await stop();
  });

  // A meeting owned by `host`, optionally with `outsider` added as a participant.
  async function fixture({ withParticipant = false, title = 'Fixture meeting' } = {}) {
    const meeting = await createMeeting(host.token, title);
    const doc = store.meetings.find((m) => m._id === meeting._id);
    if (withParticipant) doc.participants.push(outsider.user.id);
    return { meeting, doc };
  }

  test('creating a meeting requires authentication', async () => {
    const res = await api('/api/meetings', { method: 'POST', body: { title: 'Anonymous' } });

    assert.equal(res.status, 401);
  });

  test('the creator becomes the host and gets a shareable room code', async () => {
    const res = await api('/api/meetings', {
      method: 'POST',
      token: host.token,
      body: { title: 'Sprint planning' },
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.host, host.user.id);
    assert.deepEqual(res.body.participants, [host.user.id]);
    assert.equal(res.body.status, 'live');
    // Google-Meet-style code, deliberately without confusable characters (0/o, 1/l/i).
    assert.match(res.body.roomCode, /^[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$/);
    assert.equal(/[0o1li]/.test(res.body.roomCode), false);
    const ALLOWED = 'abcdefghjkmnpqrstuvwxyz23456789';
    assert.equal(
      [...res.body.roomCode.replace(/-/g, '')].every((char) => ALLOWED.includes(char)),
      true,
      `room code used a character outside the documented alphabet: ${res.body.roomCode}`
    );
  });

  test('creating a meeting without a title is rejected', async () => {
    const res = await api('/api/meetings', { method: 'POST', token: host.token, body: {} });

    assert.equal(res.status, 400);
  });

  test('the host can read their own meeting', async () => {
    const { meeting } = await fixture();

    const res = await api(`/api/meetings/${meeting._id}`, { token: host.token });

    assert.equal(res.status, 200);
    assert.equal(res.body._id, meeting._id);
  });

  test('a participant can read a meeting they were added to', async () => {
    const { meeting } = await fixture({ withParticipant: true });

    const res = await api(`/api/meetings/${meeting._id}`, { token: outsider.token });

    assert.equal(res.status, 200);
  });

  test('a signed-in stranger cannot read a meeting', async () => {
    const { meeting } = await fixture();

    const res = await api(`/api/meetings/${meeting._id}`, { token: outsider.token });

    assert.equal(res.status, 403);
  });

  test('an unknown meeting id is a 404, not a 403', async () => {
    const res = await api(`/api/meetings/${'f'.repeat(24)}`, { token: host.token });

    assert.equal(res.status, 404);
  });

  test('the dashboard list only returns your own meetings', async () => {
    await fixture({ title: 'Host only' });
    await createMeeting(outsider.token, 'Outsider only');

    const hostList = await api('/api/meetings', { token: host.token });

    assert.equal(hostList.status, 200);
    assert.ok(hostList.body.length > 0);
    assert.equal(
      hostList.body.every((m) => m.host === host.user.id),
      true
    );
    assert.equal(hostList.body.some((m) => m.title === 'Outsider only'), false);
  });

  test('a room code can be looked up by any signed-in user (that is how people join)', async () => {
    const { meeting } = await fixture();

    const known = await api(`/api/meetings/room/${meeting.roomCode}`, { token: outsider.token });
    const unknown = await api('/api/meetings/room/aaa-bbbb-ccc', { token: outsider.token });
    const anonymous = await api(`/api/meetings/room/${meeting.roomCode}`);

    assert.equal(known.status, 200);
    assert.equal(known.body.roomCode, meeting.roomCode);
    assert.equal(unknown.status, 404);
    assert.equal(anonymous.status, 401);
  });

  test('only a member can generate a summary', async () => {
    const { meeting } = await fixture();

    const asStranger = await api(`/api/meetings/${meeting._id}/summarize`, {
      method: 'POST',
      token: outsider.token,
      body: { transcript: 'Anything.' },
    });

    assert.equal(asStranger.status, 403);
  });

  test('summaries work with no OpenAI key, and infer assignees', async () => {
    const { meeting, doc } = await fixture();

    const res = await api(`/api/meetings/${meeting._id}/summarize`, {
      method: 'POST',
      token: host.token,
      body: {
        transcript:
          'We should ship the beta by Friday. Priya will write the release notes for it.',
      },
    });

    assert.equal(res.status, 200);
    // No OPENAI_API_KEY in tests, so this must be the free offline engine.
    assert.equal(res.body.engine, 'offline-extractive');
    assert.ok(res.body.summary.length > 0);
    assert.ok(res.body.actionItems.length >= 1);
    assert.ok(res.body.actionItems.some((item) => item.assignee === 'Priya'));
    assert.equal(res.body.actionItems.every((item) => item.done === false), true);
    // And it is persisted on the meeting, not just returned.
    assert.ok(doc.summary.length > 0);
    assert.equal(doc.transcript.includes('ship the beta'), true);
  });

  test('only the host can end a meeting', async () => {
    const { meeting, doc } = await fixture({ withParticipant: true });

    const asParticipant = await api(`/api/meetings/${meeting._id}/end`, {
      method: 'POST',
      token: outsider.token,
    });
    assert.equal(asParticipant.status, 403);
    assert.equal(doc.status, 'live');

    const asHost = await api(`/api/meetings/${meeting._id}/end`, { method: 'POST', token: host.token });
    assert.equal(asHost.status, 200);
    assert.equal(asHost.body.status, 'ended');
    assert.ok(asHost.body.endedAt);
  });

  test('unrouted paths return the JSON 404 shape, not HTML', async () => {
    const res = await api('/api/definitely-not-a-route');

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: 'Not found.' });
  });
});
