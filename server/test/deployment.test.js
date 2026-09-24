/**
 * Pins the two deployment-shaped decisions: how much of `X-Forwarded-For` to
 * believe, and which misconfigurations get reported at boot.
 *
 * These are asserted here rather than left to production because both fail
 * quietly. A wrong `trust proxy` does not break a request — it makes every
 * visitor share one rate-limit budget, which only shows up as the demo path
 * mysteriously refusing new guests. A missing warning does not break anything
 * either; it just means the first person to notice is a judge.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deploymentSummary,
  deploymentWarnings,
  envFlag,
  logDeploymentWarnings,
  trustProxySetting,
} = require('../src/config/deployment.js');

/** The environment of a deployment that has been configured properly. */
function goodProduction(overrides = {}) {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(48),
    CLIENT_ORIGIN: 'https://intellimeet.vercel.app',
    APP_BASE_URL: 'https://intellimeet.vercel.app',
    MAIL_WEBHOOK_URL: 'https://mail.example.com/send',
    ADMIN_TOKEN: 'b'.repeat(32),
    ...overrides,
  };
}

describe('boolean knobs', () => {
  test('unset and empty fall back to the documented default', () => {
    assert.equal(envFlag('DEMO_LOGIN_ENABLED', { env: {} }), true);
    assert.equal(envFlag('DEMO_LOGIN_ENABLED', { env: { DEMO_LOGIN_ENABLED: '' } }), true);
    assert.equal(
      envFlag('DEMO_LOGIN_ENABLED', { env: { DEMO_LOGIN_ENABLED: '  ' } }),
      true
    );
    assert.equal(envFlag('GUEST_RETENTION_ENABLED', { env: {}, fallback: false }), false);
  });

  test('the usual spellings of off all mean off, whatever their case', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' false ']) {
      assert.equal(
        envFlag('DEMO_LOGIN_ENABLED', { env: { DEMO_LOGIN_ENABLED: value } }),
        false,
        `${value} should disable the knob`
      );
    }
    assert.equal(envFlag('DEMO_LOGIN_ENABLED', { env: { DEMO_LOGIN_ENABLED: 'true' } }), true);
    assert.equal(envFlag('DEMO_LOGIN_ENABLED', { env: { DEMO_LOGIN_ENABLED: 'yes' } }), true);
  });
});

describe('trust proxy', () => {
  test('is off locally, so a request cannot spoof its own address', () => {
    assert.equal(trustProxySetting({}), false);
    assert.equal(trustProxySetting({ NODE_ENV: 'development' }), false);
    assert.equal(trustProxySetting({ NODE_ENV: 'test' }), false);
  });

  test('trusts exactly one hop in production, which is what a platform proxy is', () => {
    assert.equal(trustProxySetting({ NODE_ENV: 'production' }), 1);
  });

  test('TRUST_PROXY overrides the default in both directions', () => {
    assert.equal(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'false' }), false);
    assert.equal(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: 'off' }), false);
    assert.equal(trustProxySetting({ NODE_ENV: 'development', TRUST_PROXY: 'true' }), true);
    assert.equal(trustProxySetting({ NODE_ENV: 'production', TRUST_PROXY: '2' }), 2);
  });

  test('anything non-numeric is left for Express to interpret as an address list', () => {
    assert.equal(
      trustProxySetting({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }),
      'loopback, 10.0.0.0/8'
    );
  });
});

describe('deployment warnings', () => {
  test('a correctly configured production deployment says nothing', () => {
    assert.deepEqual(deploymentWarnings(goodProduction()), []);
  });

  test('development is never nagged — localhost origins and no mailer are correct there', () => {
    assert.deepEqual(
      deploymentWarnings({ NODE_ENV: 'development', CLIENT_ORIGIN: 'http://localhost:5173' }),
      []
    );
  });

  test('a missing or placeholder signing key is reported first', () => {
    const missing = deploymentWarnings(goodProduction({ JWT_SECRET: '' }));
    assert.equal(missing.length, 1);
    assert.match(missing[0], /JWT_SECRET is not set/);

    for (const secret of ['change_this_to_a_long_random_secret', 'short']) {
      const warnings = deploymentWarnings(goodProduction({ JWT_SECRET: secret }));
      assert.equal(warnings.length, 1, `${secret} should be reported`);
      assert.match(warnings[0], /can mint a token for any account/);
    }
  });

  test('an origin that still says localhost is reported', () => {
    const warnings = deploymentWarnings(goodProduction({ CLIENT_ORIGIN: 'http://localhost:5173' }));
    assert.match(warnings.join('\n'), /CLIENT_ORIGIN still contains http:\/\/localhost:5173/);
  });

  test('a mixed origin list is reported for the entry that is wrong, not the whole list', () => {
    const warnings = deploymentWarnings(
      goodProduction({ CLIENT_ORIGIN: 'https://intellimeet.vercel.app,http://localhost:5173' })
    );
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], /https:\/\/intellimeet\.vercel\.app:/);
  });

  test('leaving CLIENT_ORIGIN unset is reported, since the default blocks the deployed client', () => {
    const warnings = deploymentWarnings(goodProduction({ CLIENT_ORIGIN: '' }));
    assert.match(warnings.join('\n'), /CLIENT_ORIGIN is not set/);
  });

  test('a claim that asks for an email nobody can send is reported', () => {
    // Verification is on by default, and production sends no mail at all without
    // a transport — so the account is stuck pending and login stays refused.
    const warnings = deploymentWarnings(goodProduction({ MAIL_WEBHOOK_URL: '' }));
    assert.match(warnings.join('\n'), /MAIL_WEBHOOK_URL is unset/);
    assert.match(warnings.join('\n'), /EMAIL_VERIFICATION_REQUIRED=false/);
  });

  test('turning verification off silences the mail and base-URL warnings', () => {
    const warnings = deploymentWarnings(
      goodProduction({
        MAIL_WEBHOOK_URL: '',
        APP_BASE_URL: '',
        EMAIL_VERIFICATION_REQUIRED: 'false',
      })
    );
    assert.deepEqual(warnings, []);
  });

  test('a confirmation link that points at a machine only you have is reported', () => {
    const unset = deploymentWarnings(goodProduction({ APP_BASE_URL: '' }));
    assert.match(unset.join('\n'), /APP_BASE_URL is unset/);

    const local = deploymentWarnings(goodProduction({ APP_BASE_URL: 'http://127.0.0.1:5173' }));
    assert.match(local.join('\n'), /APP_BASE_URL is "http:\/\/127\.0\.0\.1:5173"/);
  });

  test('the demo path being switched off is reported', () => {
    const warnings = deploymentWarnings(goodProduction({ DEMO_LOGIN_ENABLED: 'false' }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /DEMO_LOGIN_ENABLED is off/);
  });

  test('a guessable admin token is reported', () => {
    const warnings = deploymentWarnings(goodProduction({ ADMIN_TOKEN: 'admin' }));
    assert.match(warnings.join('\n'), /ADMIN_TOKEN is only 5 characters/);
  });

  test('trust proxy being switched off behind a proxy is reported', () => {
    const warnings = deploymentWarnings(goodProduction({ TRUST_PROXY: 'false' }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRUST_PROXY is off behind a platform proxy/);
  });

  test('several problems are all reported, not just the first', () => {
    const warnings = deploymentWarnings(
      goodProduction({
        JWT_SECRET: '',
        CLIENT_ORIGIN: 'http://localhost:5173',
        DEMO_LOGIN_ENABLED: 'false',
        MAIL_WEBHOOK_URL: '',
        APP_BASE_URL: '',
        ADMIN_TOKEN: 'admin',
        TRUST_PROXY: 'false',
      })
    );
    assert.equal(warnings.length, 7);
    for (const pattern of [
      /JWT_SECRET is not set/,
      /CLIENT_ORIGIN still contains/,
      /DEMO_LOGIN_ENABLED is off/,
      /MAIL_WEBHOOK_URL is unset/,
      /APP_BASE_URL is unset/,
      /ADMIN_TOKEN is only/,
      /TRUST_PROXY is off/,
    ]) {
      assert.match(warnings.join('\n'), pattern);
    }
  });
});

describe('reporting', () => {
  test('a clean run logs nothing', () => {
    const calls = [];
    const logged = logDeploymentWarnings([], { warn: (...args) => calls.push(args) });
    assert.equal(logged, 0);
    assert.deepEqual(calls, []);
  });

  test('each warning is logged, prefixed, and counted', () => {
    const calls = [];
    const logged = logDeploymentWarnings(['one', 'two'], { warn: (...args) => calls.push(args.join(' ')) });

    assert.equal(logged, 2);
    assert.equal(calls.length, 3); // the header, then one line each
    assert.match(calls[0], /2 deployment warning\(s\)/);
    assert.match(calls[1], /• one/);
    assert.match(calls[2], /• two/);
  });

  test('the summary carries the warnings, the shape — and no secret values', () => {
    const summary = deploymentSummary(
      goodProduction({ JWT_SECRET: 'a'.repeat(48), DEMO_LOGIN_ENABLED: 'false' })
    );

    assert.equal(summary.nodeEnv, 'production');
    assert.equal(summary.trustProxy, 1);
    assert.equal(summary.demoEnabled, false);
    assert.deepEqual(summary.origins, ['https://intellimeet.vercel.app']);
    assert.equal(summary.verificationRequired, true);
    assert.equal(summary.mailerConfigured, true);
    assert.equal(summary.warnings.length, 1);
    assert.equal(JSON.stringify(summary).includes('a'.repeat(48)), false);
  });
});
