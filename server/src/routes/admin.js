const crypto = require('crypto');
const express = require('express');
const User = require('../models/User');
const Meeting = require('../models/Meeting');
const { getLiveSession } = require('../socket');
const { deploymentSummary } = require('../config/deployment');
const {
  purgeStaleGuests,
  getLastSweep,
  isRetentionEnabled,
  retentionMs,
  intervalMs,
  maxGuestRooms,
} = require('../services/guestRetention');

const router = express.Router();

/**
 * Operator endpoints: a status view and a way to trigger the guest sweep.
 *
 * The sweep runs here, inside the server, rather than in whatever process calls
 * it, because deciding whether a demo is still running needs Socket.io's live
 * state — the one thing a separate cron process cannot see. So cron triggers an
 * endpoint instead of connecting to MongoDB itself.
 *
 * Both routes exist only when ADMIN_TOKEN is set, so a deployment that does not
 * want this surface has nothing listening rather than an endpoint someone
 * forgets to protect.
 */

function timingSafeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function requireAdminToken(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return res.status(404).json({ error: 'Not found.' });

  const provided = req.headers['x-admin-token'];
  if (typeof provided !== 'string' || !timingSafeEqual(provided, expected)) {
    return res.status(403).json({ error: 'A valid x-admin-token header is required.' });
  }
  return next();
}

async function buildStats() {
  const live = getLiveSession();
  const guestIds = (await User.find({ isGuest: true })).map((guest) => guest._id);

  return {
    // How this process is deployed, and what is wrong with it. Behind the admin
    // token on purpose: "JWT_SECRET is a placeholder" is not for public eyes,
    // which is also why /api/health stays quiet about it.
    config: deploymentSummary(),
    retention: {
      enabled: isRetentionEnabled(),
      hours: retentionMs() / 3_600_000,
      intervalMinutes: intervalMs() / 60_000,
    },
    // Who is connected right now — the same view the sweep consults.
    live: { users: live.userIds.size, rooms: live.roomCodes.size },
    guests: guestIds.length,
    // How close the demo is to the volume bound that backs up the sweep.
    rooms: { guest: await Meeting.countDocuments({ host: { $in: guestIds } }), cap: maxGuestRooms() },
    lastSweep: getLastSweep(),
  };
}

router.use(requireAdminToken);

router.get('/stats', async (req, res) => {
  try {
    return res.json(await buildStats());
  } catch (err) {
    console.error('[admin/stats]', err);
    return res.status(500).json({ error: 'Could not read stats.' });
  }
});

router.post('/sweep', async (req, res) => {
  try {
    const swept = await purgeStaleGuests();
    return res.json({ swept, stats: await buildStats() });
  } catch (err) {
    console.error('[admin/sweep]', err);
    return res.status(500).json({ error: 'Could not run the sweep.' });
  }
});

module.exports = router;
