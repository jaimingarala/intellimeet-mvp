const crypto = require('crypto');
const { envFlag } = require('../config/deployment');
const User = require('../models/User');
const Meeting = require('../models/Meeting');
const { buildDemoContent } = require('./demoContent');
const { generateRoomCode } = require('./roomCode');
const { evictOldestGuestRooms } = require('./guestRetention');

/**
 * Anonymous guests behind the "Try the demo" path.
 *
 * A visitor should reach a working room without signing up, and two visitors
 * should be able to meet without accounts. So instead of one shared demo login,
 * each arrival gets a *real* user document of its own:
 *
 *   - `POST /api/auth/demo` with no body  → a new guest and a new room of their
 *     own, seeded with a sample meeting (services/demoContent.js) so chat and
 *     the AI tab are populated on arrival.
 *   - `POST /api/auth/demo` with a `roomCode` → a new guest who joins *that*
 *     room, which is what a shared room link does.
 *
 * Guests can never be logged into: their password hash is the bcrypt hash of a
 * random value that is never stored or disclosed, so there is no credential to
 * type. They are ordinary members otherwise — the only thing they own is a room
 * they created. `isGuest` marks them so they can be told apart (and aged out)
 * later.
 */

const GUEST_EMAIL_DOMAIN = 'guest.intellimeet.dev';
// Same unambiguous alphabet as room codes (no 0/o, 1/l/i), so a guest name read
// aloud or written down can't be mistyped.
const NAME_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Unset means enabled, so the one-click path works on a fresh clone/deploy. */
function isDemoEnabled() {
  return envFlag('DEMO_LOGIN_ENABLED');
}

function guestRoomTitle() {
  return process.env.DEMO_TITLE || 'IntellMeet live demo';
}

function randomCode(length) {
  return Array.from({ length }, () => NAME_ALPHABET[crypto.randomInt(NAME_ALPHABET.length)]).join('');
}

// One shared "unusable" hash, computed lazily. Every guest gets it, and because
// the plaintext is 32 random bytes that are never written anywhere, no password
// can match it. Reusing a single hash keeps the click path cheap instead of
// spending a bcrypt round per visitor.
let unusableGuestHash = null;
function unusablePasswordHash() {
  if (!unusableGuestHash) {
    unusableGuestHash = User.hashPassword(crypto.randomBytes(32).toString('hex'));
  }
  return unusableGuestHash;
}

async function createGuest() {
  const passwordHash = await unusablePasswordHash();
  return User.create({
    name: `Guest ${randomCode(4).toUpperCase()}`,
    email: `guest-${crypto.randomBytes(8).toString('hex')}@${GUEST_EMAIL_DOMAIN}`,
    passwordHash,
    isGuest: true,
  });
}

/** A room of the guest's own, already populated with the sample meeting. */
async function createGuestRoom(guest) {
  // Volume bound, separate from the age-based sweep: if the demo is holding its
  // maximum number of rooms, the oldest one nobody is in makes way first.
  const evicted = await evictOldestGuestRooms();
  if (evicted.rooms > 0) {
    console.log(`[guest] at the ${evicted.cap}-room cap — evicted ${evicted.rooms} older demo room(s)`);
  }

  let roomCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateRoomCode();
    // eslint-disable-next-line no-await-in-loop
    const clash = await Meeting.findOne({ roomCode: candidate });
    if (!clash) {
      roomCode = candidate;
      break;
    }
  }
  if (!roomCode) throw new Error('could not allocate a room code');

  return Meeting.create({
    title: guestRoomTitle(),
    roomCode,
    host: guest._id,
    participants: [guest._id],
    ...buildDemoContent(guest._id),
  });
}

/**
 * Give a brand-new guest a seat in an existing room. They arrive as a
 * participant (never the host), so they can't end or moderate someone else's
 * meeting.
 */
async function joinGuestToRoom(guest, meeting) {
  if (!meeting.participants.some((p) => String(p) === String(guest._id))) {
    meeting.participants.push(guest._id);
    await meeting.save();
  }
  return meeting;
}

/**
 * Provision a guest and the room they should land in.
 *
 * Returns `{ user, meeting }`, or `{ user: null, meeting: null }` when a
 * `roomCode` was given but no such room exists — the lookup happens first so a
 * bad code doesn't leave a stray guest account behind.
 */
async function startDemo(roomCode) {
  const wantsToJoin = roomCode !== undefined && roomCode !== null && String(roomCode).trim() !== '';

  if (wantsToJoin) {
    const meeting = await Meeting.findOne({ roomCode: String(roomCode).trim().toLowerCase() });
    if (!meeting) return { user: null, meeting: null };

    const user = await createGuest();
    await joinGuestToRoom(user, meeting);
    return { user, meeting };
  }

  const user = await createGuest();
  const meeting = await createGuestRoom(user);
  return { user, meeting };
}

module.exports = { isDemoEnabled, startDemo };
