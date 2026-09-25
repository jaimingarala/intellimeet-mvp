/**
 * `src/lib/export.js` — what ends up in an exported file, and what a search
 * matches.
 *
 * The export is the artefact a reviewer reads, so the assertions are about the
 * file rather than the function: a summary that came back from a language model
 * can contain anything, and a chat message with a newline in it must not turn
 * into a second bullet or a heading.
 */
import { describe, expect, test } from 'vitest';

import { exportFilename, matchesQuery, meetingToMarkdown } from '../src/lib/export.js';

const MEETING = {
  title: 'Sprint planning',
  roomCode: 'xk3-mfqp-czr',
  status: 'ended',
  startedAt: '2026-03-04T09:00:00.000Z',
  endedAt: '2026-03-04T09:45:00.000Z',
  summary: 'The team agreed to ship the board first.',
  actionItems: [
    { text: 'Write the board schema', assignee: 'Priya', done: true },
    { text: 'Book the room', assignee: 'Devin', done: false },
  ],
  chatMessages: [
    { senderName: 'Priya', text: 'Shall we start?', sentAt: '2026-03-04T09:01:00.000Z' },
    { senderName: 'Devin', text: 'One minute', sentAt: '2026-03-04T09:02:00.000Z' },
  ],
};

describe('exporting a meeting', () => {
  test('opens with the title and the metadata a reader needs', () => {
    const markdown = meetingToMarkdown(MEETING);

    expect(markdown.startsWith('# Sprint planning\n')).toBe(true);
    expect(markdown).toContain('Room `xk3-mfqp-czr`');
    expect(markdown).toContain('Status ended');
    expect(markdown).toContain('Started 2026-03-04T09:00:00.000Z');
    expect(markdown).toContain('Ended 2026-03-04T09:45:00.000Z');
  });

  test('writes action items as checkboxes with their assignee', () => {
    const markdown = meetingToMarkdown(MEETING);

    expect(markdown).toContain('## Action items');
    expect(markdown).toContain('1 of 2 done.');
    expect(markdown).toContain('- [x] Write the board schema — Priya');
    expect(markdown).toContain('- [ ] Book the room — Devin');
  });

  test('writes the chat in order, with names and timestamps', () => {
    const markdown = meetingToMarkdown(MEETING);
    const priya = markdown.indexOf('**Priya**');
    const devin = markdown.indexOf('**Devin**');

    expect(priya).toBeGreaterThan(-1);
    expect(priya).toBeLessThan(devin);
    expect(markdown).toContain('(2026-03-04T09:01:00.000Z)');
  });

  test('flattens content that would otherwise break the document', () => {
    const markdown = meetingToMarkdown({
      ...MEETING,
      summary: 'Line one\n\n# Not a heading',
      actionItems: [{ text: 'Do the thing\n- and another thing', assignee: 'Priya', done: false }],
      chatMessages: [{ senderName: 'Devin', text: 'first line\n  second line', sentAt: null }],
    });

    // The summary is its own paragraph, so a stray heading marker inside it is
    // flattened to one line rather than becoming a section.
    expect(markdown).toContain('Line one # Not a heading');
    expect(markdown).toContain('- [ ] Do the thing - and another thing — Priya');
    expect(markdown).toContain('- **Devin**: first line second line');
    // A message with no timestamp still renders.
    expect(markdown).not.toContain('**Devin** (');
  });

  test('says so when there is nothing to say', () => {
    const markdown = meetingToMarkdown({
      title: 'Empty',
      roomCode: 'abc-defg-hij',
      status: 'live',
    });

    expect(markdown).toContain('_No summary was generated for this meeting._');
    expect(markdown).toContain('_None._');
    expect(markdown).toContain('_No chat messages._');
  });

  test('survives a meeting object that is missing entirely', () => {
    const markdown = meetingToMarkdown(undefined, { exportedAt: new Date('2026-03-05T00:00:00Z') });

    expect(markdown).toContain('# Untitled meeting');
    expect(markdown).toContain('Exported from IntellMeet on 2026-03-05T00:00:00.000Z');
  });

  test('stamps the export time the caller passed in, not the wall clock', () => {
    const markdown = meetingToMarkdown(MEETING, { exportedAt: new Date('2026-03-05T10:00:00Z') });

    expect(markdown.endsWith('Exported from IntellMeet on 2026-03-05T10:00:00.000Z.\n')).toBe(true);
  });
});

describe('naming the exported file', () => {
  test('is readable and filesystem-safe', () => {
    expect(exportFilename(MEETING)).toBe('intellimeet-xk3-mfqp-czr-sprint-planning.md');
  });

  test('does not repeat the product name in the file it exports', () => {
    expect(exportFilename({ title: 'IntellMeet live demo', roomCode: 'u8e-ajas-5jf' })).toBe(
      'intellimeet-u8e-ajas-5jf-live-demo.md',
    );
  });

  test('does not grow without bound, and needs no title to work', () => {
    const long = exportFilename({ title: 't'.repeat(200), roomCode: 'abc-defg-hij' });
    expect(long.length).toBeLessThan(100);
    expect(long.endsWith('.md')).toBe(true);

    expect(exportFilename({ roomCode: 'abc-defg-hij' })).toBe('intellimeet-abc-defg-hij.md');
    expect(exportFilename({ title: '!!! ???' })).toBe('intellimeet-room.md');
  });
});

describe('searching the history', () => {
  test('an empty query keeps everything', () => {
    expect(matchesQuery(MEETING, '')).toBe(true);
    expect(matchesQuery(MEETING, '   ')).toBe(true);
    expect(matchesQuery(MEETING, undefined)).toBe(true);
  });

  test('matches the fields the row actually shows', () => {
    expect(matchesQuery(MEETING, 'sprint')).toBe(true);
    expect(matchesQuery(MEETING, 'SPRINT')).toBe(true);
    expect(matchesQuery(MEETING, 'mfqp')).toBe(true);
    expect(matchesQuery(MEETING, 'ended')).toBe(true);
    expect(matchesQuery(MEETING, 'board')).toBe(false);
  });

  test('does not search inside the summary or the chat', () => {
    // A row that matched on a word the user cannot see would read as a bug, so
    // this is asserted rather than left to whoever changes it next.
    expect(matchesQuery(MEETING, 'Priya')).toBe(false);
    expect(matchesQuery(MEETING, 'schema')).toBe(false);
  });
});
