/**
 * Proving an email address belongs to whoever attached it.
 *
 * The claim flow is the only place a user types an address nobody has checked,
 * and the danger is specific: a squatter could attach a stranger's address,
 * reserve it (email is the unique login key), and thereby log into the account
 * later under an address that isn't theirs — or at best block the real owner
 * from ever claiming it.
 *
 * So a claim lands in a *pending* state: the address is recorded, a single-use
 * token is emailed to it, and login is refused until that token comes back.
 * Holding the token is the proof, because the only way to get one is to receive
 * mail at the address.
 *
 * Tokens are stored hashed, so a database leak doesn't yield working links, and
 * a token is bound to the exact address it was sent to — otherwise a squatter
 * could ask for a link to their own address and then switch the account's email
 * to someone else's before spending it. Issuing a new token replaces the old
 * one, so an earlier link stops working the moment a newer one is sent.
 */
const crypto = require('crypto');
const User = require('../models/User');
const { buildVerificationLink, sendMail } = require('./mailer');

const DEFAULT_TTL_HOURS = 24;

/**
 * Off with `EMAIL_VERIFICATION_REQUIRED=false`, which skips the whole pending
 * state: a claim is then trusted immediately, exactly as it was before this
 * existed. That switch exists for deployments that cannot send mail at all.
 */
const isVerificationRequired = () => process.env.EMAIL_VERIFICATION_REQUIRED !== 'false';

function ttlHours() {
  const configured = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_HOURS;
}

/** Only the hash is ever stored. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const isExpired = (pending) => !pending?.expiresAt || new Date(pending.expiresAt) <= new Date();

function verificationEmail({ name, link, expiresAt }) {
  const hours = Math.max(1, Math.round((new Date(expiresAt) - Date.now()) / 3600000));
  return {
    subject: 'Confirm your IntellMeet email',
    text: [
      `Hi ${name || 'there'},`,
      '',
      'Confirm this address to finish setting up your IntellMeet account:',
      link,
      '',
      `The link works once and expires in about ${hours} hour${hours === 1 ? '' : 's'}.`,
      "If you didn't ask for this, you can ignore this email.",
    ].join('\n'),
  };
}

/**
 * Mint a fresh token for `user` and email it to `email`. Saves the user, so a
 * caller must have already set every other field it wants persisted.
 */
async function issueVerification(user, { email }) {
  const normalised = String(email).toLowerCase().trim();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + ttlHours() * 3600000);

  user.emailVerification = {
    tokenHash: hashToken(token),
    expiresAt,
    sentAt: new Date(),
    sentTo: normalised,
  };
  await user.save();

  const link = buildVerificationLink(token);
  const { subject, text } = verificationEmail({ name: user.name, link, expiresAt });
  const delivery = await sendMail({ to: normalised, subject, text, link });

  return {
    required: true,
    email: normalised,
    expiresAt,
    delivered: delivery.delivered,
    transport: delivery.transport,
    ...(delivery.error ? { error: delivery.error } : {}),
  };
}

/**
 * The single entry point the claim route needs: either trust the address now
 * (verification switched off) or hold it pending and email a link. One save
 * either way, so the unique-email index still does its job.
 */
async function attachAddress(user, { email }) {
  if (!isVerificationRequired()) {
    user.emailVerified = true;
    user.emailVerification = undefined;
    await user.save();
    return { required: false };
  }

  // Set before issuing so the pending record and the address can't disagree.
  user.emailVerified = false;
  return issueVerification(user, { email });
}

/**
 * Spend a token. Returns `{ ok: true, user }` or a reason — `invalid` covers
 * both "no such token" and "already spent", deliberately: telling the two apart
 * would let someone probe for live tokens.
 */
async function consumeVerification(token) {
  if (!token || typeof token !== 'string' || token.length > 512) {
    return { ok: false, reason: 'invalid' };
  }

  const user = await User.findOne({ 'emailVerification.tokenHash': hashToken(token) });
  if (!user) return { ok: false, reason: 'invalid' };

  // The token proves control of the address it was sent to — if the account has
  // since been pointed at a different one, it proves nothing about the address
  // that is now the login identity. Not reachable through the API today (a claim
  // sets the address once), but the invariant is cheap and it is exactly the
  // hole that would open the moment changing an email is added.
  if (user.emailVerification.sentTo !== user.email) {
    return { ok: false, reason: 'invalid' };
  }

  if (isExpired(user.emailVerification)) {
    // Drop the dead token so the account isn't left holding one that can never
    // be spent; a new link is one resend away.
    user.emailVerification = undefined;
    await user.save();
    return { ok: false, reason: 'expired', email: user.email };
  }

  user.emailVerified = true;
  user.emailVerification = undefined;
  await user.save();
  return { ok: true, user };
}

/**
 * Send a replacement link. Always resolves to the same shape for an unknown or
 * already-verified address, because the caller answers identically in all
 * cases — an endpoint that distinguishes them is an account-existence oracle.
 */
async function resendVerification(email) {
  const normalised = String(email || '').toLowerCase().trim();
  if (!normalised) return { sent: false, reason: 'unknown' };

  const user = await User.findOne({ email: normalised });
  if (!user || user.emailVerified !== false) return { sent: false, reason: 'unknown' };

  const result = await issueVerification(user, { email: normalised });
  return { sent: true, delivered: result.delivered, transport: result.transport };
}

/** Whether login must be refused for this account. */
const needsVerification = (user) => isVerificationRequired() && user.emailVerified === false;

module.exports = {
  attachAddress,
  buildVerificationLink,
  consumeVerification,
  hashToken,
  isVerificationRequired,
  issueVerification,
  needsVerification,
  resendVerification,
  ttlHours,
};
