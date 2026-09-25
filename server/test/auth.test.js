/**
 * Auth: signup, login, password storage, and that an issued token actually
 * opens a protected route.
 *
 * Note: /signup and /login are rate limited to 30 requests per 15 minutes per
 * IP (see routes/auth.js). Each test file gets its own process and therefore its
 * own limiter, but this file should stay well under that budget.
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { start, stop, api, signup, login, store } = require('./helpers/app.js');

describe('authentication', () => {
  before(async () => {
    await start();
  });

  after(async () => {
    await stop();
  });

  test('signup creates an account and returns a usable token', async () => {
    const { status, token, user } = await signup('Alice', 'alice@test.dev');

    assert.equal(status, 201);
    assert.equal(typeof token, 'string');
    assert.equal(user.name, 'Alice');
    assert.equal(user.email, 'alice@test.dev');
    assert.equal(user.isGuest, false);
  });

  test('signup never returns the password or its hash', async () => {
    const { user, body } = await signup('Bob', 'bob@test.dev');

    assert.equal(user.password, undefined);
    assert.equal(user.passwordHash, undefined);
    assert.equal(body.passwordHash, undefined);
    assert.equal(JSON.stringify(body).includes('password123'), false);
  });

  test('the stored password is a bcrypt hash that verifies', async () => {
    await signup('Carol', 'carol@test.dev', 'correct-horse');

    const stored = store.users.find((u) => u.email === 'carol@test.dev');
    assert.notEqual(stored.passwordHash, 'correct-horse');
    assert.match(stored.passwordHash, /^\$2[aby]\$/);
    assert.equal(await stored.comparePassword('correct-horse'), true);
    assert.equal(await stored.comparePassword('wrong-password'), false);
  });

  test('signup rejects an email that already exists', async () => {
    await signup('Dave', 'dave@test.dev');
    const second = await signup('Dave Again', 'dave@test.dev');

    assert.equal(second.status, 409);
    assert.equal(store.users.filter((u) => u.email === 'dave@test.dev').length, 1);
  });

  test('signup rejects a trivially short password', async () => {
    const res = await api('/api/auth/signup', {
      method: 'POST',
      body: { name: 'Short', email: 'short@test.dev', password: 'abc' },
    });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 8/i);
  });

  test('signup requires a name, email and password', async () => {
    const res = await api('/api/auth/signup', {
      method: 'POST',
      body: { email: 'noname@test.dev' },
    });

    assert.equal(res.status, 400);
  });

  test('login returns a token for the correct password', async () => {
    await signup('Erin', 'erin@test.dev', 'password123');

    const { status, token, user } = await login('erin@test.dev', 'password123');

    assert.equal(status, 200);
    assert.equal(typeof token, 'string');
    assert.equal(user.email, 'erin@test.dev');
  });

  test('login is case-insensitive on the email address', async () => {
    await signup('Frank', 'Frank@Test.dev', 'password123');

    const lower = await login('frank@test.dev', 'password123');
    const mixed = await login('FRANK@TEST.DEV', 'password123');

    assert.equal(lower.status, 200);
    assert.equal(mixed.status, 200);
  });

  test('login rejects a wrong password without leaking which field failed', async () => {
    await signup('Grace', 'grace@test.dev', 'password123');

    const { status, body } = await login('grace@test.dev', 'not-the-password');

    assert.equal(status, 401);
    assert.equal(body.token, undefined);
    assert.equal(body.error, 'Invalid email or password.');
  });

  test('login rejects an unknown email with the same message', async () => {
    const { status, body } = await login('nobody@test.dev', 'password123');

    assert.equal(status, 401);
    assert.equal(body.error, 'Invalid email or password.');
  });

  test('an issued token authenticates a protected route', async () => {
    const { token } = await signup('Heidi', 'heidi@test.dev');

    const withToken = await api('/api/meetings', { token });
    const withoutToken = await api('/api/meetings');

    assert.equal(withToken.status, 200);
    assert.equal(withoutToken.status, 401);
  });

  test('a tampered token is rejected', async () => {
    const { token } = await signup('Ivan', 'ivan@test.dev');
    const [header, payload, signature] = token.split('.');
    // Flip the signature's *first* character: the last one only carries padding
    // bits, so changing it can decode to the same bytes and still verify.
    const flipped = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);

    const res = await api('/api/meetings', { token: `${header}.${payload}.${flipped}` });

    assert.equal(res.status, 401);
  });

  test('a token signed with the wrong secret is rejected', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 'someone', name: 'Forged' }, 'not-the-real-secret');

    const res = await api('/api/meetings', { token: forged });

    assert.equal(res.status, 401);
  });

  test('a malformed Authorization header is rejected', async () => {
    const res = await api('/api/meetings', { token: 'not-a-jwt' });

    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid or expired token.');
  });
});
