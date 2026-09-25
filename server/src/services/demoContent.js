/**
 * Sample content for a guest's demo room.
 *
 * A visitor should see the product doing something the moment they arrive, not
 * an empty room, so a guest's room is created with a short coherent meeting
 * already in it: the chat log, the transcript it came from, and the summary +
 * action items an AI pass over that transcript would produce. The three pieces
 * tell one story on purpose — the chat is what the room shows, the transcript
 * is what a summary is generated from, and the summary/actions read like they
 * were extracted from it.
 *
 * The names are fictional teammates, so the conversation reads like a meeting
 * rather than one person talking to themselves. `sender` is a foreign key to a
 * real user document, so every seeded message points at the demo account — the
 * only user that exists — while `senderName` carries the display name the chat
 * panel renders.
 */

// `minutesAgo` keeps the log looking like it just wrapped up rather than a
// conversation frozen at some fixed date.
const DEMO_CHAT = [
  {
    senderName: 'Maya',
    minutesAgo: 16,
    text: 'Morning! Quick sync on the beta launch — target is still Thursday.',
  },
  {
    senderName: 'Devin',
    minutesAgo: 13,
    text: "Landing page copy is done. I'm waiting on the final screenshots.",
  },
  {
    senderName: 'Priya',
    minutesAgo: 12,
    text: "Screenshots are ready — I'll add them to the shared folder after standup.",
  },
  {
    senderName: 'Maya',
    minutesAgo: 6,
    text: 'If they land today, are we still comfortable with Thursday?',
  },
  {
    senderName: 'Devin',
    minutesAgo: 4,
    text: "Yes. I'll do one last pass on the onboarding flow tonight.",
  },
  {
    senderName: 'Priya',
    minutesAgo: 2,
    text: "Agreed. I'll set up the feedback form so we can collect early responses.",
  },
];

const DEMO_TRANSCRIPT = [
  '[09:00] Maya: Quick sync on the beta launch — the target is still Thursday.',
  "[09:04] Devin: Landing page copy is done. I'm still waiting on the final screenshots.",
  "[09:05] Priya: Screenshots are ready, I'll add them to the shared folder after standup.",
  '[09:09] Maya: If the screenshots land today, are we still comfortable with Thursday?',
  "[09:11] Devin: Yes. I'll do one last pass on the onboarding flow tonight.",
  "[09:12] Priya: Agreed. I'll set up the feedback form so we can collect early responses.",
  '[09:14] Maya: Decision — the beta launches Thursday. If either dependency slips we revisit at Friday standup.',
].join('\n');

const DEMO_SUMMARY =
  'The team confirmed a Thursday beta launch, with the landing page copy finished and only two ' +
  'dependencies left: the final screenshots and one last pass over the onboarding flow. The group ' +
  'agreed to revisit the date at Friday standup if either slips, and to start collecting early-user ' +
  'feedback through a form as soon as the beta is live.';

const DEMO_ACTION_ITEMS = [
  { assignee: 'Priya', text: 'Add the final screenshots to the shared folder' },
  { assignee: 'Devin', text: 'Do a last pass on the onboarding flow before launch' },
  { assignee: 'Priya', text: 'Set up the beta feedback form' },
  { assignee: 'Maya', text: 'Revisit the launch date at Friday standup if a dependency slips' },
];

/**
 * The meeting fields that make up the sample content, ready to hand to
 * `Meeting.create` or to assign onto an existing meeting document.
 */
function buildDemoContent(senderId, now = new Date()) {
  return {
    chatMessages: DEMO_CHAT.map(({ senderName, text, minutesAgo }) => ({
      sender: senderId,
      senderName,
      text,
      sentAt: new Date(now.getTime() - minutesAgo * 60 * 1000),
    })),
    transcript: DEMO_TRANSCRIPT,
    summary: DEMO_SUMMARY,
    actionItems: DEMO_ACTION_ITEMS.map(({ assignee, text }) => ({ assignee, text, done: false })),
  };
}

module.exports = { buildDemoContent, DEMO_CHAT, DEMO_TRANSCRIPT, DEMO_SUMMARY, DEMO_ACTION_ITEMS };
