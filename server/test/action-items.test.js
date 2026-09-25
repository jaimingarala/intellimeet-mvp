/**
 * The action-item list: who may tick one off, what counts as a tick, and the
 * fact that the room is told about it.
 *
 * This is the small half of the AI feature — the summary is the part people
 * watch, and the list of things to do is the part they use — so the rules that
 * matter are the boring ones: a non-member cannot reach it, a nonsense index
 * changes nothing, and the tick survives the request that made it.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, signup, createMeeting, store, baseUrl } = require('./helpers/app.js');
const { connect, joinRoom, waitForEvent, sleep } = require('./helpers/sockets.js');

const ITEMS = [
  { text: 'Write the deployment notes', assignee: 'Priya', done: false },
  { text: 'Book the room for Thursday', assignee: 'Devin', done: false },
  { text: 'Send the design review', assignee: 'Unassigned', done: false },
];

describe('action items', () => {
  let host;

  before(async () => {
    await start();
    host = await signup('Host', 'actions-host@test.dev');
  });

  after(async () => {
    await stop();
  });

  /** A meeting with a summary already generated — three items, none done. */
  async function fixture() {
    const meeting = await createMeeting(host.token, 'Action items');
    const doc = store.meetings.find((m) => m._id === meeting._id);
    doc.actionItems = ITEMS.map((item) => ({ ...item }));
    return { meeting, doc };
  }

  const patch = (id, index, body, token = host.token) =>
    api(`/api/meetings/${id}/action-items/${index}`, { method: 'PATCH', token, body });

  test('a member ticks an item off, and it persists', async () => {
    const { meeting, doc } = await fixture();

    const res = await patch(meeting._id, 1, { done: true });

    assert.equal(res.status, 200);
    assert.equal(res.body.index, 1);
    assert.equal(doc.actionItems[1].done, true);
    // The whole list comes back: a position is only meaningful until the next
    // summary replaces the array, so the client is given the current state
    // rather than the piece it sent.
    assert.deepEqual(
      res.body.actionItems.map((item) => item.done),
      [false, true, false],
    );
    assert.equal(res.body.actionItems[1].text, 'Book the room for Thursday');
  });

  test('and can put it back', async () => {
    const { meeting, doc } = await fixture();

    await patch(meeting._id, 0, { done: true });
    const res = await patch(meeting._id, 0, { done: false });

    assert.equal(res.status, 200);
    assert.equal(doc.actionItems[0].done, false);
  });

  test('the rest of the room hears about it while the meeting is live', async () => {
    const { meeting, doc } = await fixture();
    const member = await signup('Member', 'actions-member@test.dev');
    doc.participants.push(member.user.id);

    const listening = await connect(baseUrl(), member.token);
    await joinRoom(listening, meeting.roomCode);

    const heard = waitForEvent(listening, 'action-item-updated');
    const res = await patch(meeting._id, 2, { done: true });
    const update = await heard;

    assert.equal(res.status, 200);
    assert.equal(update.index, 2);
    assert.equal(update.done, true);
    assert.equal(update.actionItems[2].done, true);
    assert.equal(update.by, host.user.id);

    listening.disconnect();
  });

  test('an authenticated non-member cannot reach the list', async () => {
    const { meeting, doc } = await fixture();
    const outsider = await signup('Outsider', 'actions-outsider@test.dev');

    const res = await patch(meeting._id, 0, { done: true }, outsider.token);

    assert.equal(res.status, 403);
    assert.equal(doc.actionItems[0].done, false, 'a refused request must not change anything');
  });

  test('and neither can a request with no token', async () => {
    const { meeting, doc } = await fixture();

    const res = await api(`/api/meetings/${meeting._id}/action-items/0`, {
      method: 'PATCH',
      body: { done: true },
    });

    assert.equal(res.status, 401);
    assert.equal(doc.actionItems[0].done, false);
  });

  test('a position that is not a whole number in range changes nothing', async () => {
    const { meeting, doc } = await fixture();

    for (const [index, expected] of [
      ['-1', 400],
      ['1.5', 400],
      ['not-a-number', 400],
      ['99', 404],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patch(meeting._id, index, { done: true });
      assert.equal(res.status, expected, `index ${index}`);
    }

    assert.deepEqual(
      doc.actionItems.map((item) => item.done),
      [false, false, false],
    );
  });

  test('done has to be a boolean, not a truthy string', async () => {
    const { meeting, doc } = await fixture();

    for (const body of [{ done: 'true' }, { done: 1 }, {}]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await patch(meeting._id, 0, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }

    // An empty body is a 400 too, rather than a silent untick.
    assert.equal(doc.actionItems[0].done, false);
  });

  test('a meeting with no summary yet answers 404 rather than inventing an item', async () => {
    const meeting = await createMeeting(host.token, 'Nothing summarized');

    const res = await patch(meeting._id, 0, { done: true });

    assert.equal(res.status, 404);
    assert.match(res.body.error, /No action item/);
  });

  test('the update reaches only the room it belongs to', async () => {
    const { meeting } = await fixture();
    const other = await fixture();
    const member = await signup('Elsewhere', 'actions-elsewhere@test.dev');
    store.meetings.find((m) => m._id === other.meeting._id).participants.push(member.user.id);

    const listening = await connect(baseUrl(), member.token);
    await joinRoom(listening, other.meeting.roomCode);

    let heard = 0;
    listening.on('action-item-updated', () => {
      heard += 1;
    });

    await patch(meeting._id, 0, { done: true });
    await sleep(150);

    assert.equal(heard, 0);
    listening.disconnect();
  });
});
