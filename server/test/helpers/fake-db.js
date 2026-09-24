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

function makeUser({
  name,
  email,
  passwordHash,
  role = 'member',
  isGuest = false,
  emailVerified = true,
}) {
  return {
    _id: newId(),
    name,
    email: String(email).toLowerCase(),
    passwordHash,
    role,
    isGuest,
    // Mirrors the real schema's default: signups and guests carry no pending
    // proof, and a claim is what sets this false. Present at all because the
    // route reads it, and a stub that dropped it would make every claimed
    // account look verified.
    emailVerified,
    emailVerification: undefined,
    createdAt: new Date(),
    comparePassword(candidate) {
      return bcrypt.compare(candidate, this.passwordHash);
    },
    // Like makeMeeting's: the store holds this object, so a no-op save() still
    // records the mutations a route made in place.
    async save() {
      return this;
    },
    toSafeJSON() {
      return {
        id: this._id,
        name: this.name,
        email: this.email,
        role: this.role,
        isGuest: this.isGuest,
        emailVerified: this.emailVerified !== false,
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

const idList = (values) => (values || []).map(String);

/** Read `a.b` out of the plain objects this store holds. */
const readPath = (doc, path) =>
  path.split('.').reduce((value, key) => (value == null ? value : value[key]), doc);

/** The subset of User queries the guest-retention sweep uses. */
function matchesUser(user, query = {}) {
  if (query._id?.$in && !idList(query._id.$in).includes(String(user._id))) return false;
  if (query.isGuest !== undefined && Boolean(user.isGuest) !== Boolean(query.isGuest)) return false;
  if (query.createdAt?.$lt && !(new Date(user.createdAt) < new Date(query.createdAt.$lt))) return false;
  return true;
}

function matches(meeting, query) {
  if (query.roomCode) {
    // `{ roomCode: { $in: [...] } }` is the guest-retention sweep asking which
    // of the live rooms still exist.
    if (query.roomCode.$in) return idList(query.roomCode.$in).includes(String(meeting.roomCode));
    return meeting.roomCode === query.roomCode;
  }
  if (query.host) {
    // `{ host: { $in: [...] } }` finds the rooms a set of guests owns.
    if (query.host.$in) return idList(query.host.$in).includes(String(meeting.host));
    return String(meeting.host) === String(query.host);
  }
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
  async findOne(query = {}) {
    if (query.email) {
      return users.find((u) => u.email === String(query.email).toLowerCase()) || null;
    }
    // `{ 'emailVerification.tokenHash': hash }` is how an emailed link is spent.
    const dotted = Object.entries(query).find(([key]) => key.includes('.'));
    if (dotted) {
      const [path, value] = dotted;
      return users.find((u) => readPath(u, path) === value) || null;
    }
    return null;
  },
  async findById(id) {
    return users.find((u) => String(u._id) === String(id)) || null;
  },
  async create(doc) {
    const user = makeUser(doc);
    users.push(user);
    return user;
  },
  async find(query = {}) {
    return users.filter((user) => matchesUser(user, query));
  },
  async countDocuments(query = {}) {
    return users.filter((user) => matchesUser(user, query)).length;
  },
  async deleteMany(query = {}) {
    const doomed = users.filter((user) => matchesUser(user, query));
    for (const user of doomed) users.splice(users.indexOf(user), 1);
    return { deletedCount: doomed.length };
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
  // The dashboard uses the `.sort().limit()` chain; Mongoose queries are also
  // thenable, so `await Meeting.find(...)` yields the documents — which is what
  // the guest-retention sweep relies on. Sorting is real, because which room is
  // "oldest" decides what the room cap evicts.
  find(query) {
    let found = meetings.filter((m) => matches(m, query));
    const chain = {
      sort: (spec) => {
        const [[field, direction] = []] = Object.entries(spec || {});
        if (field) {
          found = [...found].sort((a, b) => (new Date(a[field]) - new Date(b[field])) * direction);
        }
        return chain;
      },
      limit: (count) => Promise.resolve(found.slice(0, count)),
      then: (resolve, reject) => Promise.resolve(found).then(resolve, reject),
    };
    return chain;
  },
  async countDocuments(query = {}) {
    return meetings.filter((m) => matches(m, query)).length;
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
  async deleteMany(query = {}) {
    const doomed = meetings.filter((meeting) => matches(meeting, query));
    for (const meeting of doomed) meetings.splice(meetings.indexOf(meeting), 1);
    return { deletedCount: doomed.length };
  },
  // The retention sweep passes a filter, but the stub applies the pull to every
  // meeting: it only ever runs the one $pull shape, and a wider sweep can't
  // change the outcome of a test.
  async updateMany(filter, update) {
    const pull = update.$pull || {};
    let modifiedCount = 0;
    for (const meeting of meetings) {
      let changed = false;
      for (const field of Object.keys(pull)) {
        const ids = idList(pull[field]?.$in);
        const before = (meeting[field] || []).length;
        meeting[field] = (meeting[field] || []).filter((id) => !ids.includes(String(id)));
        if (meeting[field].length !== before) changed = true;
      }
      if (changed) modifiedCount += 1;
    }
    return { modifiedCount };
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
