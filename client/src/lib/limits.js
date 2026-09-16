/**
 * Mirrors the user-facing caps in `server/src/config/limits.js`.
 *
 * The server is authoritative and rejects anything longer; these exist so the UI
 * can stop the user before they hit an error. Keep the two files in step.
 */
export const MAX_CHAT_MESSAGE_CHARS = 2000;
export const MAX_TRANSCRIPT_CHARS = 20000;
