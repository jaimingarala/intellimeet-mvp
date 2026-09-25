/**
 * Payload caps and rate limits in one place, so the routes, the socket handlers,
 * the tests and the README all agree on the numbers.
 *
 * Nothing here is secret; the client mirrors the two user-facing caps in
 * `client/src/lib/limits.js` so the UI can stop a user before the server does,
 * but the server is always authoritative.
 */
module.exports = {
  /** Longest transcript accepted by POST /api/meetings/:id/summarize. */
  MAX_TRANSCRIPT_CHARS: 20_000,

  /** Longest chat message a socket may send. */
  MAX_CHAT_MESSAGE_CHARS: 2_000,

  /** Longest meeting title. */
  MAX_TITLE_CHARS: 120,

  /**
   * Longest room code accepted on the socket `join-room` path. Real codes are 11
   * characters; the cap exists so a client can't hand the room lookup an
   * arbitrarily long string.
   */
  MAX_ROOM_CODE_CHARS: 64,

  /**
   * Longest serialised signalling payload the relay will pass on.
   *
   * The server never reads an SDP or an ICE candidate, but "opaque" is not the
   * same as "unbounded": without a cap, two members could use the relay to move
   * arbitrary amounts of data between each other at the server's expense. A real
   * offer with a full codec list is a few KB, so this is generous.
   */
  MAX_SIGNAL_CHARS: 20_000,

  /**
   * Summaries are the expensive path — with OPENAI_API_KEY set, every call costs
   * money — so they get a tighter, per-user budget than the rest of the API.
   */
  SUMMARIZE_RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 10 },

  /**
   * Chat is persisted and broadcast, so one client flooding it costs a database
   * write per message for everyone in the room. Keyed by user, so a second tab
   * shares the budget and reconnecting does not hand out a fresh one.
   */
  CHAT_RATE_LIMIT: { windowMs: 60 * 1000, max: 30 },

  /**
   * Meeting creation, per account. Guests are already bounded by
   * DEMO_MAX_GUEST_ROOMS and the retention sweep, but a real account could
   * otherwise fill the collection at whatever rate its network allowed. Set
   * generously: creating meetings is what this app is for, and the cap is aimed
   * at a script, not at a person.
   */
  MEETING_RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 30 },
};
