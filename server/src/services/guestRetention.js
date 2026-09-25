const { envFlag } = require('../config/deployment');
const { log } = require('../lib/logger');
const User = require('../models/User');
const Meeting = require('../models/Meeting');
const { getLiveSession } = require('../socket');

/**
 * Retention for anonymous guests.
 *
 * The "Try the demo" path creates a guest user and a room per visit and nothing
 * else ever removes them, so without a sweep the demo would grow the database
 * forever. This deletes guests — and the rooms they own — once they are older
 * than the retention window, and unhooks them from any room they had joined, so
 * no room is left with a ghost attendee.
 *
 * It is scoped to `isGuest: true`, so a real account and its meetings are never
 * touched. Deleting a room also takes its chat, summary and action items with
 * it, which is why a separate "clear the demo room's contents" job isn't needed:
 * a guest's room is only ever as old as the guest.
 *
 * Age alone is not enough, though: a demo that is still running must not be cut
 * off just because its clock ran out. Anyone connected right now, and the host
 * of any room someone is still sitting in, is left for the next sweep (see
 * `protectedGuestIds`).
 *
 * That guard reads Socket.io's live state, so the sweep has to run *in* the
 * server process. A scheduler that prefers cron still gets that by triggering
 * `POST /api/admin/sweep` (or `npm run sweep:guests`) rather than connecting to
 * MongoDB itself — one process, one view of who is connected.
 *
 * Age is one bound; `evictOldestGuestRooms()` is the other. It caps how many
 * guest rooms may exist at once and drops the oldest when a new one arrives, so
 * volume stays finite even if this sweep never runs.
 */

const DEFAULT_RETENTION_HOURS = 24;
const DEFAULT_INTERVAL_MINUTES = 60;
const DEFAULT_MAX_GUEST_ROOMS = 200;

function positiveNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** How long guest data is kept. */
function retentionMs() {
  return (
    positiveNumber(process.env.GUEST_RETENTION_HOURS, DEFAULT_RETENTION_HOURS) * 60 * 60 * 1000
  );
}

/** How often the sweep runs. */
function intervalMs() {
  return (
    positiveNumber(process.env.GUEST_RETENTION_INTERVAL_MINUTES, DEFAULT_INTERVAL_MINUTES) *
    60 *
    1000
  );
}

/** Enabled unless explicitly turned off. */
function isRetentionEnabled() {
  return envFlag('GUEST_RETENTION_ENABLED');
}

/**
 * How many guest rooms may exist at once. `0` disables the cap.
 *
 * A count bound next to the age bound: the sweep keeps data from growing by
 * time, this keeps it from growing by volume even when the sweep is not running
 * (a disabled timer, a crash, a cron nobody wired up).
 */
function maxGuestRooms() {
  const raw = process.env.DEMO_MAX_GUEST_ROOMS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_GUEST_ROOMS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MAX_GUEST_ROOMS;
}

/**
 * Stale guests that must wait, because a session is still running.
 *
 * Two cases, and the second is the one that bites: a guest who is connected
 * right now, and the host of a room that still has someone in it. The person
 * sitting in the room need not be the host — a visitor who took a shared link is
 * just a participant — and deleting the host would take their room, and the
 * visitor still using it, down with them.
 */
async function protectedGuestIds(staleGuests) {
  const live = getLiveSession();
  const staleIds = new Set(staleGuests.map((guest) => String(guest._id)));
  const protectedIds = new Set(
    staleGuests
      .filter((guest) => live.userIds.has(String(guest._id)))
      .map((guest) => String(guest._id)),
  );

  if (live.roomCodes.size > 0) {
    const occupied = await Meeting.find({ roomCode: { $in: [...live.roomCodes] } });
    for (const room of occupied) {
      if (staleIds.has(String(room.host))) protectedIds.add(String(room.host));
    }
  }

  return protectedIds;
}

// The most recent sweep, for the operator-facing stats endpoint. Operational
// state, not data: losing it on restart costs nothing.
let lastSweep = null;

/** The result of the last sweep (or null if none has run in this process). */
function getLastSweep() {
  return lastSweep;
}

/**
 * Delete guest data older than the window and report what went.
 *
 * Idempotent and safe to run repeatedly or from more than one instance: the
 * second run simply finds nothing left to remove.
 */
async function purgeStaleGuests(options = {}) {
  const result = await runSweep(options);
  lastSweep = { at: new Date().toISOString(), ...result };
  return result;
}

async function runSweep({ now = new Date(), olderThanMs = retentionMs() } = {}) {
  const cutoff = new Date(now.getTime() - olderThanMs);

  const staleGuests = await User.find({ isGuest: true, createdAt: { $lt: cutoff } });
  if (staleGuests.length === 0) return { guests: 0, rooms: 0, seats: 0, skipped: 0 };

  const protectedIds = await protectedGuestIds(staleGuests);
  const doomed = staleGuests.filter((guest) => !protectedIds.has(String(guest._id)));

  if (doomed.length === 0) {
    return { guests: 0, rooms: 0, seats: 0, skipped: protectedIds.size };
  }

  const removed = await removeGuests(doomed.map((guest) => guest._id));
  return { ...removed, skipped: protectedIds.size };
}

/**
 * Delete guests and everything keyed to them: the rooms they host (chat, summary
 * and action items included) and their seat in any room they had merely joined.
 * Idempotent, so a guest removed twice simply reports zero the second time.
 */
async function removeGuests(ids) {
  if (ids.length === 0) return { guests: 0, rooms: 0, seats: 0 };

  const rooms = await Meeting.deleteMany({ host: { $in: ids } });
  const unseated = await Meeting.updateMany(
    { $or: [{ participants: { $in: ids } }, { banned: { $in: ids } }] },
    { $pull: { participants: { $in: ids }, banned: { $in: ids } } },
  );
  await User.deleteMany({ _id: { $in: ids } });

  return {
    guests: ids.length,
    rooms: rooms.deletedCount ?? 0,
    seats: unseated.modifiedCount ?? 0,
  };
}

/**
 * Make room for one more guest room by evicting the oldest, if the cap is
 * already reached. Called when a demo room is about to be created.
 *
 * Only rooms nobody is in are candidates, so a demo in progress is never evicted
 * to make space for a new one. If *every* room is occupied the cap is exceeded
 * rather than turning a visitor away — growth is then bounded by real
 * concurrency, which is the part that was never going to run away.
 *
 * Returns what it removed, all zeros when there was room to spare.
 */
async function evictOldestGuestRooms() {
  const cap = maxGuestRooms();
  if (cap <= 0) return { guests: 0, rooms: 0, seats: 0, cap };

  const guestIds = (await User.find({ isGuest: true })).map((guest) => guest._id);
  const rooms = await Meeting.find({ host: { $in: guestIds } }).sort({ createdAt: 1 });

  // One room is about to be added, so this run has to free up one slot.
  const excess = rooms.length - cap + 1;
  if (excess <= 0) return { guests: 0, rooms: 0, seats: 0, cap };

  const live = getLiveSession();
  const evictable = rooms.filter(
    (room) => !live.roomCodes.has(room.roomCode) && !live.userIds.has(String(room.host)),
  );
  const doomedHosts = evictable.slice(0, excess).map((room) => room.host);
  if (doomedHosts.length === 0) return { guests: 0, rooms: 0, seats: 0, cap };

  return { ...(await removeGuests(doomedHosts)), cap };
}

/**
 * Start the sweep: once now, then on an interval. Returns the timer (unref'd so
 * it never keeps the process alive) or null when retention is off.
 *
 * The immediate run matters on hosts that sleep: an hourly interval can miss
 * every window if the process only wakes when someone visits.
 */
function startGuestRetention() {
  if (!isRetentionEnabled()) return null;

  const run = () =>
    purgeStaleGuests()
      .then((result) => {
        if (result.guests > 0 || result.skipped > 0) {
          log.info('guest sweep', {
            scope: 'guestRetention',
            guestsRemoved: result.guests,
            roomsRemoved: result.rooms,
            seatsReleased: result.seats,
            // Rooms someone is still sitting in are kept, which is worth saying
            // out loud: otherwise "0 removed" looks like the sweep did nothing.
            keptInSession: result.skipped,
          });
        }
      })
      .catch((err) => log.error('guest sweep failed', { scope: 'guestRetention', err }));

  run();
  const timer = setInterval(run, intervalMs());
  timer.unref?.();
  return timer;
}

module.exports = {
  purgeStaleGuests,
  evictOldestGuestRooms,
  getLastSweep,
  startGuestRetention,
  retentionMs,
  intervalMs,
  maxGuestRooms,
  isRetentionEnabled,
};
