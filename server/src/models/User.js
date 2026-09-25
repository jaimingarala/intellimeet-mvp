const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    // Anonymous "Try the demo" accounts. The password hash is of a random value
    // that is never stored, so a guest can't be logged into; the flag exists so
    // guests can be told apart from real accounts (and aged out) later.
    isGuest: { type: Boolean, default: false },
    // True means "no address is awaiting proof", not "we politely asked once".
    // Signups and guests are trusted with the address they arrive with; a
    // *claim* is the one path that attaches an address nobody has proven yet, so
    // it is the only writer that sets this false. Login refuses an unverified
    // account, which is what makes an address safe to re-attach: a squatter can
    // take the string, but can't turn it into a usable identity.
    emailVerified: { type: Boolean, default: true },
    // The pending proof. Only the hash is stored, so a database leak doesn't
    // hand over working links; `sentTo` is kept so a verification sent to one
    // address can't be spent on a later one.
    emailVerification: {
      type: new mongoose.Schema(
        {
          tokenHash: { type: String, required: true },
          expiresAt: { type: Date, required: true },
          sentAt: { type: Date, default: Date.now },
          sentTo: { type: String, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { timestamps: true },
);

// Guest retention looks guests up as { isGuest: true, createdAt: < window }, and
// the admin stats count them with the same `isGuest` filter. `isGuest` leads so
// the equality narrows first and the range only has to walk stale guests — a
// plain createdAt index would scan every old account, guests and real ones
// alike. Without it the hourly sweep collects the whole collection every run.
userSchema.index({ isGuest: 1, createdAt: 1 });

// Verifying an emailed link looks a user up by `emailVerification.tokenHash`,
// with no other filter, so it needs its own index or every click is a full
// collection scan — and this one is driven by the public internet, not by a
// timer. Sparse because the overwhelming majority of documents have no pending
// verification at all: a plain index would store a null entry for each of them.
userSchema.index({ 'emailVerification.tokenHash': 1 }, { sparse: true });

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.passwordHash);
};

userSchema.statics.hashPassword = function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
};

userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: this._id,
    name: this.name,
    email: this.email,
    isGuest: this.isGuest,
    emailVerified: this.emailVerified !== false,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
