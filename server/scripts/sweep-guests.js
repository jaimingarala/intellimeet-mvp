#!/usr/bin/env node
/**
 * Runs the guest-retention sweep now — the cron-friendly alternative to the
 * in-process timer.
 *
 *     cd server && npm run sweep:guests
 *
 * It triggers POST /api/admin/sweep rather than connecting to MongoDB itself,
 * and that is deliberate: deciding whether a demo is still running needs the
 * server's live socket state, which a separate process cannot see. A sweep that
 * talked to the database directly would happily delete a room someone is
 * sitting in.
 *
 * Needs ADMIN_TOKEN in server/.env (the endpoint is off without it) and a
 * running API. Exits non-zero on failure, so a scheduler can notice.
 */
require('dotenv').config();

const port = process.env.PORT || 5000;
const baseUrl = (process.env.API_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const token = process.env.ADMIN_TOKEN;

if (!token) {
  console.error(
    '[sweep:guests] ADMIN_TOKEN is not set (see server/.env.example) — the admin endpoint is off without it.',
  );
  process.exit(1);
}

async function main() {
  let res;
  try {
    res = await fetch(`${baseUrl}/api/admin/sweep`, {
      method: 'POST',
      headers: { 'x-admin-token': token },
    });
  } catch (err) {
    console.error(`[sweep:guests] could not reach the API at ${baseUrl} (${err.message}).`);
    process.exit(1);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(`[sweep:guests] ${res.status}: ${body?.error || 'request failed'}`);
    process.exit(1);
  }

  const { swept, stats } = body;
  console.log('');
  console.log(`  Swept  ${swept.guests} guest(s), ${swept.rooms} room(s), ${swept.seats} seat(s)`);
  if (swept.skipped > 0) console.log(`  Kept   ${swept.skipped} still in a session`);
  console.log(`  Live   ${stats.live.users} user(s) in ${stats.live.rooms} room(s)`);
  console.log(`  Guests ${stats.guests} stored`);
  console.log('');
}

main().catch((err) => {
  console.error('[sweep:guests]', err.message);
  process.exit(1);
});
