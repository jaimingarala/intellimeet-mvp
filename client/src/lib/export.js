/**
 * Turning a meeting into a Markdown file, and finding one in a list.
 *
 * Pure functions on purpose: the download itself is three DOM lines in the
 * Dashboard, while the part worth testing is what ends up in the file — the
 * ordering, the checkbox syntax, and the fact that a chat message containing a
 * newline or a heading cannot produce Markdown that reads as something else.
 */

/**
 * Collapse anything to a single line.
 *
 * Action items and chat come from a language model and from people, so either can
 * contain newlines, leading hashes or stray indentation. Inside a Markdown list
 * item, a second line is no longer part of the item, and `#` at the start of one
 * becomes a heading — so the content is flattened rather than trusted.
 */
function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

const iso = (value) => (value ? new Date(value).toISOString() : null);

/** A filename a filesystem will accept, without needing to be asked twice. */
export function exportFilename(meeting = {}) {
  const slug = oneLine(meeting.title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    // The demo rooms are called "IntellMeet live demo", and a file called
    // intellimeet-xk3-…-intellmeet-live-demo.md is a stutter, not information.
    .replace(/^intellmeet-/, '')
    .slice(0, 60)
    .replace(/-+$/, '');

  const room = oneLine(meeting.roomCode) || 'room';
  return `intellimeet-${room}${slug ? `-${slug}` : ''}.md`;
}

/**
 * Does this meeting match what someone typed into the search box?
 *
 * Deliberately the fields the row shows — title, room code, status. Searching
 * inside summaries and chat would be a different feature (and a surprising one:
 * a match on a word inside a summary, with nothing highlighted, reads as a bug).
 */
export function matchesQuery(meeting = {}, query = '') {
  const needle = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!needle) return true;

  return [meeting.title, meeting.roomCode, meeting.status]
    .map((value) => String(value ?? '').toLowerCase())
    .some((value) => value.includes(needle));
}

/**
 * Everything worth keeping from a meeting, as Markdown.
 *
 * Timestamps are ISO rather than locale-formatted: the file is meant to be read
 * next to a repository, and `03/04/2026` means two different days depending on
 * who opens it.
 */
export function meetingToMarkdown(meeting = {}, { exportedAt = new Date() } = {}) {
  const lines = [];
  const title = oneLine(meeting.title) || 'Untitled meeting';

  lines.push(`# ${title}`, '');

  const meta = [
    `Room \`${oneLine(meeting.roomCode) || 'unknown'}\``,
    `Status ${oneLine(meeting.status) || 'unknown'}`,
  ];
  const started = iso(meeting.startedAt || meeting.createdAt);
  if (started) meta.push(`Started ${started}`);
  const ended = iso(meeting.endedAt);
  if (ended) meta.push(`Ended ${ended}`);
  lines.push(meta.join(' · '), '');

  lines.push('## Summary', '');
  const summary = oneLine(meeting.summary);
  lines.push(summary || '_No summary was generated for this meeting._', '');

  const items = Array.isArray(meeting.actionItems) ? meeting.actionItems : [];
  lines.push('## Action items', '');
  if (items.length === 0) {
    lines.push('_None._', '');
  } else {
    const done = items.filter((item) => item.done).length;
    lines.push(`${done} of ${items.length} done.`, '');
    items.forEach((item) => {
      const assignee = oneLine(item.assignee) || 'Unassigned';
      lines.push(`- [${item.done ? 'x' : ' '}] ${oneLine(item.text)} — ${assignee}`);
    });
    lines.push('');
  }

  const messages = Array.isArray(meeting.chatMessages) ? meeting.chatMessages : [];
  lines.push('## Chat', '');
  if (messages.length === 0) {
    lines.push('_No chat messages._', '');
  } else {
    messages.forEach((message) => {
      const at = iso(message.sentAt);
      const stamp = at ? ` (${at})` : '';
      lines.push(
        `- **${oneLine(message.senderName) || 'Someone'}**${stamp}: ${oneLine(message.text)}`,
      );
    });
    lines.push('');
  }

  lines.push('---', `Exported from IntellMeet on ${exportedAt.toISOString()}.`, '');

  return lines.join('\n');
}
