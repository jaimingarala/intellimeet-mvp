const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    senderName: { type: String, required: true },
    text: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const actionItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
    assignee: { type: String, default: 'Unassigned' },
    done: { type: Boolean, default: false },
  },
  { _id: false }
);

const meetingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    roomCode: { type: String, required: true, unique: true, index: true },
    host: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Users the host removed with { ban: true }. Kept on the meeting (not just
    // in memory) so a reconnect, a new browser or a server restart can't
    // walk back into the room.
    banned: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    status: { type: String, enum: ['scheduled', 'live', 'ended'], default: 'live' },
    chatMessages: [chatMessageSchema],
    transcript: { type: String, default: '' },
    summary: { type: String, default: '' },
    actionItems: [actionItemSchema],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Meeting', meetingSchema);
