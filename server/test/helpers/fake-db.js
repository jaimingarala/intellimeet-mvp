/**
 * In-memory stand-ins for the Mongoose models.
 *
 * The suites must pass on a fresh clone with no MongoDB running, so the models
 * (and the DB connector) are injected into the require cache *before* anything
 * requires them. Only the query surface the routes actually use is implemented:
 * if a route starts using a new query, add it here and the failure will point
 * at the missing stub.
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const users = [];
const meetings = [];

// The app's real schema uses ObjectId; strings are enough for equality checks
// and for the `.toString()` calls the routes make.
const newId = () => crypto.randomBytes(12).toString('hex');

function makeUser({ name, email, passwordHash, role = 'member' }) {
  return {
    _id: newId(),
    name,
    email: String(email).toLowerCase(),
    passwordHash,
    role,
    createdAt: new Date(),
    comparePassword(candidate) {
      return bcrypt.compare(candidate, this.passwordHash);
    },
    toSafeJSON() {
      return {
        id: this._id,
        name: this.name,
        email: this.email,
        role: this.role,
        createdAt: this.createdAt,
      };
    },
  };
}

function makeMeeting(doc) {
  return {
    _id: newId(),
    title: doc.title,
    roomCode: doc.roomCode,
    host: doc.host,
    participants: [...(doc.participants || [])],
    banned: [...(doc.banned || [])],
    startedAt: doc.startedAt || new Date(),
    endedAt: undefined,
    status: doc.status || 'live',
    chatMessages: doc.chatMessages || [],
    transcript: doc.transcript || '',
    summary: doc.summary || '',
    actionItems: doc.actionItems || [],
    createdAt: new Date(),
    // The store holds this same object, so a no-op save() still records
    // mutations the route made in place.
    async save() {
      return this;
    },
  };
}

const isMember = (meeting, userId) =>
  String(meeting.host) === String(userId) ||
  meeting.participants.some((p) => String(p) === String(userId));

function matches(meeting, query) {
  if (query.roomCode) return meeting.roomCode === query.roomCode;
  if (query.$or) {
    return query.$or.some((clause) => {
      if (clause.host) return String(meeting.host) === String(clause.host);
      if (clause.participants) return isMember(meeting, clause.participants);
      return false;
    });
  }
  return false;
}

const User = {
  async findOne(query) {
    if (query.email) {
      return users.find((u) => u.email === String(query.email).toLowerCase()) || null;
    }
    return null;
  },
  async create(doc) {
    const user = makeUser(doc);
    users.push(user);
    return user;
  },
  // Cost 4 instead of the real cost 10: this stub only has to be a real bcrypt
  // hash, and CI shouldn't spend 100ms per signup.
  hashPassword: (plain) => bcrypt.hash(plain, 4),
};

const Meeting = {
  async findById(id) {
    return meetings.find((m) => m._id === String(id)) || null;
  },
  async findOne(query) {
    return meetings.find((m) => matches(m, query)) || null;
  },
  // Only the dashboard's `.sort().limit()` chain is needed (yet).
  find(query) {
    const found = meetings.filter((m) => matches(m, query));
    return { sort: () => ({ limit: () => Promise.resolve(found) }) };
  },
  async create(doc) {
    const meeting = makeMeeting(doc);
    meetings.push(meeting);
    return meeting;
  },
  async updateOne(filter, update) {
    const meeting = meetings.find((m) => m.roomCode === filter.roomCode);
    if (!meeting) return { matchedCount: 0, modifiedCount: 0 };
    // Mirror the real filter: only the host or a participant may write.
    const allowed = (filter.$or || []).some((clause) =>
      clause.host
        ? String(meeting.host) === String(clause.host)
        : isMember(meeting, clause.participants)
    );
    if (!allowed) return { matchedCount: 0, modifiedCount: 0 };
    if (update.$push?.chatMessages) meeting.chatMessages.push(update.$push.chatMessages);
    return { matchedCount: 1, modifiedCount: 1 };
  },
};

function install() {
  const stub = (relativePath, exports) => {
    const resolved = require.resolve(relativePath);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
      children: [],
      paths: [],
    };
  };

  stub('../../src/models/User', User);
  stub('../../src/models/Meeting', Meeting);
  stub('../../src/config/db', async () => {}); // never dial out to MongoDB

  return { users, meetings };
}

module.exports = { install, isMember };
