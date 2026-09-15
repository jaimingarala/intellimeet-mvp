const express = require('express');
const { isValidObjectId } = require('mongoose');
const Meeting = require('../models/Meeting');
const { requireAuth } = require('../middleware/auth');
const { generateRoomCode } = require('../services/roomCode');
const { summarizeMeeting } = require('../services/aiService');
const { evictUserFromRoom, isBanned } = require('../socket');

const router = express.Router();
router.use(requireAuth);

// Load the meeting and enforce that the caller is the host or a participant.
// Reading, ending, and summarizing all expose private meeting data, so they
// must not be reachable by anyone who merely knows the meeting id.
async function requireMeetingAccess(req, res, next) {
  try {
    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });

    const isMember =
      meeting.host.toString() === req.user.id ||
      meeting.participants.some((p) => p.toString() === req.user.id);
    if (!isMember) {
      return res.status(403).json({ error: 'You do not have access to this meeting.' });
    }

    req.meeting = meeting;
    return next();
  } catch (err) {
    return res.status(404).json({ error: 'Meeting not found.' });
  }
}


// Create a new meeting (returns a shareable room code)
router.post('/', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) return res.status(400).json({ error: 'title is required.' });

    let roomCode;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateRoomCode();
      // eslint-disable-next-line no-await-in-loop
      const clash = await Meeting.findOne({ roomCode: candidate });
      if (!clash) {
        roomCode = candidate;
        break;
      }
    }
    if (!roomCode) return res.status(500).json({ error: 'Could not allocate a room code, try again.' });

    const meeting = await Meeting.create({
      title,
      roomCode,
      host: req.user.id,
      participants: [req.user.id],
    });

    return res.status(201).json(meeting);
  } catch (err) {
    console.error('[meetings/create]', err);
    return res.status(500).json({ error: 'Could not create meeting.' });
  }
});

// Dashboard: meetings the user hosted or joined, most recent first
router.get('/', async (req, res) => {
  try {
    const meetings = await Meeting.find({
      $or: [{ host: req.user.id }, { participants: req.user.id }],
    })
      .sort({ createdAt: -1 })
      .limit(50);
    return res.json(meetings);
  } catch (err) {
    console.error('[meetings/list]', err);
    return res.status(500).json({ error: 'Could not load meetings.' });
  }
});

// Look up a meeting by room code (used when joining)
router.get('/room/:roomCode', async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ roomCode: req.params.roomCode });
    if (!meeting) return res.status(404).json({ error: 'No meeting found with that room code.' });
    if (isBanned(meeting, req.user.id)) {
      return res.status(403).json({ error: 'You have been removed from this meeting.' });
    }
    return res.json(meeting);
  } catch (err) {
    console.error('[meetings/room]', err);
    return res.status(500).json({ error: 'Could not look up meeting.' });
  }
});

router.get('/:id', requireMeetingAccess, (req, res) => {
  return res.json(req.meeting);
});

// Host-only: remove a participant from the meeting and force their live
// sockets out of the room.
//
//   DELETE /api/meetings/:id/participants/:userId            -> remove
//   DELETE /api/meetings/:id/participants/:userId?ban=true   -> remove + ban
//
// "Remove" ejects them for this session; a banned user is also recorded on the
// meeting so a reconnect (or a fresh login) cannot get back in.
router.delete('/:id/participants/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    if (!isValidObjectId(userId)) {
      return res.status(400).json({ error: 'Invalid participant id.' });
    }

    const meeting = await Meeting.findById(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found.' });

    // Host-only. Participants can read the meeting, but only the host evicts.
    if (meeting.host.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Only the host can remove participants.' });
    }
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'The host cannot remove themselves.' });
    }
    if (!meeting.participants.some((p) => p.toString() === userId)) {
      return res.status(404).json({ error: 'That user is not in this meeting.' });
    }

    const ban = req.body?.ban === true || req.query.ban === 'true';

    meeting.participants = meeting.participants.filter((p) => p.toString() !== userId);
    if (ban && !isBanned(meeting, userId)) {
      meeting.banned.push(userId);
    }
    await meeting.save();

    // Drop any live tab. Doing this after the save means a socket that
    // reconnects mid-eviction is already blocked by the ban check.
    const evictedSockets = await evictUserFromRoom(meeting.roomCode, userId, {
      banned: ban,
      by: req.user.id,
    });

    return res.json({ userId, banned: ban, evictedSockets, participants: meeting.participants });
  } catch (err) {
    console.error('[meetings/remove-participant]', err);
    return res.status(500).json({ error: 'Could not remove participant.' });
  }
});

// End a meeting and mark status
router.post('/:id/end', requireMeetingAccess, async (req, res) => {
  try {
    req.meeting.status = 'ended';
    req.meeting.endedAt = new Date();
    await req.meeting.save();
    return res.json(req.meeting);
  } catch (err) {
    return res.status(500).json({ error: 'Could not end meeting.' });
  }
});

// AI Meeting Intelligence: generate summary + action items from a transcript.
// For the MVP, "transcript" is either pasted by the host (e.g. from browser
// speech-to-text) or the accumulated chat log — real-time Whisper transcription
// is the natural next step once the app is hosted with a mic-capture pipeline.
router.post('/:id/summarize', requireMeetingAccess, async (req, res) => {
  try {
    const meeting = req.meeting;

    const { transcript } = req.body;
    const sourceText =
      transcript && transcript.trim().length > 0
        ? transcript
        : meeting.chatMessages.map((m) => `${m.senderName}: ${m.text}`).join('\n');

    const result = await summarizeMeeting(sourceText);

    meeting.transcript = sourceText;
    meeting.summary = result.summary;
    meeting.actionItems = result.actionItems.map((a) => ({
      text: a.text,
      assignee: a.assignee || 'Unassigned',
      done: false,
    }));
    await meeting.save();

    return res.json({ summary: meeting.summary, actionItems: meeting.actionItems, engine: result.engine });
  } catch (err) {
    console.error('[meetings/summarize]', err);
    return res.status(500).json({ error: 'Could not generate summary.' });
  }
});

module.exports = router;
