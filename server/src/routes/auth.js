const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { log } = require('../lib/logger');
const { requireAuth } = require('../middleware/auth');
const { isDemoEnabled, startDemo } = require('../services/guest');
const {
  attachAddress,
  consumeVerification,
  needsVerification,
  resendVerification,
} = require('../services/emailVerification');

const router = express.Router();

// Every account-writing and credential-checking route shares this budget: the
// demo path, signup, login, claiming, and the verification endpoints. The limit
// is per IP, so a shared NAT shares it — hence the knob, since a household or an
// office behind one address may need more than a demo does.
const authLimiter = rateLimit({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX) || 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Try again later.' },
});

// The claims are the identity and nothing else. There is deliberately no `role`
// here: the schema had one, nothing enforced it, and a claim that no route reads
// is worse than no claim — it reads as an authorization model that isn't there.
function signToken(user) {
  return jwt.sign({ sub: user._id, name: user.name, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

router.post('/signup', authLimiter, async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await User.hashPassword(password);
    const user = await User.create({ name, email, passwordHash });

    const token = signToken(user);
    return res.status(201).json({ token, user: user.toSafeJSON() });
  } catch (err) {
    log.error('signup failed', { scope: 'auth/signup', err });
    return res.status(500).json({ error: 'Could not create account.' });
  }
});

// One-click demo: provisions an anonymous guest and hands back a token, so a
// visitor reaches a working room without signing up.
//
//   POST /api/auth/demo                  -> a new guest, in a new room of theirs
//   POST /api/auth/demo { roomCode }     -> a new guest who joins that room
//
// The second form is what a shared room link does, which is how a second person
// joins without an account. Public by design, and behind the same limiter as
// signup/login since it writes a user.
router.post('/demo', authLimiter, async (req, res) => {
  try {
    if (!isDemoEnabled()) {
      return res.status(403).json({ error: 'The demo is currently unavailable.' });
    }

    const { roomCode } = req.body || {};
    if (roomCode !== undefined && typeof roomCode !== 'string') {
      return res.status(400).json({ error: 'roomCode must be a string.' });
    }

    const { user, meeting } = await startDemo(roomCode);
    if (!meeting) {
      return res.status(404).json({ error: 'No meeting found with that room code.' });
    }

    const token = signToken(user);
    return res.json({ token, user: user.toSafeJSON(), roomCode: meeting.roomCode });
  } catch (err) {
    log.error('demo provisioning failed', { scope: 'auth/demo', err });
    return res.status(500).json({ error: 'Could not start the demo.' });
  }
});

// Turn a guest session into a real account.
//
// The demo path hands out throwaway guests; this is how one of them keeps what
// it built. Only the credentials change — the user id is untouched, so the room
// they host (with its chat, summary and action items) and any seat they hold in
// another room stay theirs, and guest retention stops looking at them.
//
// Guest-only on purpose: a real account must not be able to swap its email
// without proving it controls the one it has.
//
// The address this attaches is *unproven*, so the account stays unverified until
// a link sent to that address comes back (see services/emailVerification.js).
// The session is unaffected — the claimant keeps using what they built — but the
// address can't be logged in with until it has been confirmed.
router.post('/claim', authLimiter, requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'Invalid or expired token.' });
    if (!user.isGuest) {
      return res.status(403).json({ error: 'Only a guest session can be claimed.' });
    }

    const { name, email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const normalised = String(email).toLowerCase().trim();
    const existing = await User.findOne({ email: normalised });
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    user.email = normalised;
    user.passwordHash = await User.hashPassword(password);
    user.isGuest = false;
    if (typeof name === 'string' && name.trim()) user.name = name.trim();

    // Saves the user, and either trusts the address outright (verification
    // switched off) or holds it pending and emails a one-time link.
    const verification = await attachAddress(user, { email: normalised });

    // A fresh token, because the old one still carries the guest's placeholder
    // name and email.
    const token = signToken(user);
    return res.json({
      token,
      user: user.toSafeJSON(),
      ...(verification.required ? { verification } : {}),
    });
  } catch (err) {
    // The email index is unique, so a race between the check and the save lands
    // here rather than silently creating a duplicate.
    if (err?.code === 11000) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    log.error('claim failed', { scope: 'auth/claim', err });
    return res.status(500).json({ error: 'Could not save your account.' });
  }
});

router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const match = await user.comparePassword(password);
    if (!match) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Deliberately after the password check: the unverified state is only
    // revealed to someone who already holds the credentials, so it can't be
    // used to discover which addresses are mid-claim.
    if (needsVerification(user)) {
      return res.status(403).json({
        error: 'Confirm your email address before signing in. Request a new link below.',
        code: 'email_unverified',
        email: user.email,
      });
    }

    const token = signToken(user);
    return res.json({ token, user: user.toSafeJSON() });
  } catch (err) {
    log.error('login failed', { scope: 'auth/login', err });
    return res.status(500).json({ error: 'Could not log in.' });
  }
});

// Spend the link from a verification email. Public, because the link is often
// opened somewhere the claimant has no session at all — a phone, say.
//
// It does not hand back a session token: the link proves the address, the
// password signs you in, and keeping those separate means a forwarded email
// can't be traded for a logged-in browser.
router.post('/verify-email', authLimiter, async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required.' });
    }

    const result = await consumeVerification(token);
    if (!result.ok) {
      const expired = result.reason === 'expired';
      return res.status(400).json({
        error: expired
          ? 'That confirmation link has expired. Request a new one.'
          : 'That confirmation link is not valid. It may already have been used.',
        code: expired ? 'verification_expired' : 'verification_invalid',
        ...(result.email ? { email: result.email } : {}),
      });
    }

    return res.json({ user: result.user.toSafeJSON() });
  } catch (err) {
    log.error('email verification failed', { scope: 'auth/verify-email', err });
    return res.status(500).json({ error: 'Could not confirm that address.' });
  }
});

// Send a replacement link. Answers identically whether or not the address is
// waiting for confirmation — a response that differed would let anyone ask
// "does this person have an account?" and read the answer off the status line.
router.post('/resend-verification', authLimiter, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'email is required.' });
    }

    await resendVerification(email);
    return res.json({
      message: 'If that address is waiting for confirmation, a new link is on its way.',
    });
  } catch (err) {
    log.error('resend verification failed', { scope: 'auth/resend-verification', err });
    return res.status(500).json({ error: 'Could not send a confirmation email.' });
  }
});

module.exports = router;
