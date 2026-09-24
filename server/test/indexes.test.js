/**
 * The indexes guest retention depends on.
 *
 * This suite deliberately does not load test/helpers/app.js: that swaps the
 * models for in-memory stubs, and the whole point here is the real schemas'
 * index declarations. No database is needed — declaring an index does not
 * connect to anything, and Mongoose builds them when the app connects.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const User = require('../src/models/User');
const Meeting = require('../src/models/Meeting');

/** Index specs as order-independent "field:direction" pairs. */
const indexKeys = (model) =>
  model.schema.indexes().map(([spec]) =>
    Object.keys(spec)
      .sort()
      .map((field) => `${field}:${spec[field]}`)
      .join(',')
  );

describe('retention indexes', () => {
  test('users are indexed for the guest sweep filter', () => {
    assert.ok(
      indexKeys(User).includes('createdAt:1,isGuest:1'),
      'User needs a compound { isGuest, createdAt } index, or the sweep scans every account'
    );
  });

  test('the verification token lookup is indexed, and only where it exists', () => {
    const spec = User.schema.indexes().find(([fields]) => fields['emailVerification.tokenHash']);

    assert.ok(spec, 'a link click looks a user up by token hash and needs an index');
    assert.equal(
      spec[1].sparse,
      true,
      'sparse matters: an ordinary index would store a null entry for every user with nothing pending'
    );
  });

  test('meetings are indexed for the three sweep lookups', () => {
    const meetingIndexes = indexKeys(Meeting);

    for (const spec of ['banned:1', 'host:1', 'participants:1']) {
      assert.ok(meetingIndexes.includes(spec), `Meeting needs an index on ${spec.split(':')[0]}`);
    }
  });
});
