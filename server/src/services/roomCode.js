const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no confusing chars (0/o, 1/l/i)

/**
 * Generates a Google-Meet-style room code, e.g. "xk3-mfqp-czr".
 * Dependency-free so the server has no extra install surface.
 */
function generateRoomCode() {
  const part = (len) =>
    Array.from({ length: len }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join(
      '',
    );
  return `${part(3)}-${part(4)}-${part(3)}`;
}

module.exports = { generateRoomCode };
