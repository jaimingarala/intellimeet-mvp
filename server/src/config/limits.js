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
   * Summaries are the expensive path — with OPENAI_API_KEY set, every call costs
   * money — so they get a tighter, per-user budget than the rest of the API.
   */
  SUMMARIZE_RATE_LIMIT: { windowMs: 15 * 60 * 1000, max: 10 },
};
