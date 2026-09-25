/**
 * The one invariant between the two packages that nothing else enforces.
 *
 * `client/src/lib/limits.js` mirrors the server's caps so the UI can stop a user
 * before the server rejects them, and its own comment says "keep the two files in
 * step" — which is exactly the kind of promise that rots. Raising the server's
 * chat cap without touching the client leaves a UI that refuses messages the
 * server would accept; lowering it leaves the client happily sending messages the
 * server drops.
 *
 * The server file is the source of truth and is read from disk here rather than
 * restated, so this test cannot drift alongside the mirror it checks.
 */
import { describe, expect, test } from 'vitest';

import serverLimits from '../../server/src/config/limits.js';
import * as clientLimits from '../src/lib/limits.js';

describe('the caps the client mirrors', () => {
  test('the chat message cap matches the server, which is authoritative', () => {
    expect(clientLimits.MAX_CHAT_MESSAGE_CHARS).toBe(serverLimits.MAX_CHAT_MESSAGE_CHARS);
  });

  test('the transcript cap matches the server', () => {
    expect(clientLimits.MAX_TRANSCRIPT_CHARS).toBe(serverLimits.MAX_TRANSCRIPT_CHARS);
  });

  test('they are numbers, not a copy-paste of the whole object', () => {
    // A `export * from '../../server/…'` would pass the two tests above while
    // shipping the server's internals to the browser bundle.
    expect(Object.keys(clientLimits).sort()).toEqual([
      'MAX_CHAT_MESSAGE_CHARS',
      'MAX_TRANSCRIPT_CHARS',
    ]);
    expect(Object.values(clientLimits).every((value) => typeof value === 'number')).toBe(true);
  });
});
