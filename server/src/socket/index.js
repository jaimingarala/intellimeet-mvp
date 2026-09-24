const jwt = require('jsonwebtoken');
const Meeting = require('../models/Meeting');
const limits = require('../config/limits');

/**
 * Socket.io namespace-free setup: one room per meeting roomCode.
 *
 * Events:
 *  client -> server: 'join-room', 'signal', 'chat-message', 'leave-room'
 *  server -> client: 'peer-joined', 'peer-left', 'signal', 'chat-message', 'room-users',
 *                   'removed-from-room'
 */

// Set by registerSocketHandlers so the REST layer (the host-only remove/ban
// endpoint) can reach into the live room and evict a socket.
let ioRef = null;

function isBanned(meeting, userId) {
  return (meeting.banned || []).some((b) => b.toString() === userId);
}

/**
 * Force every live socket belonging to `userId` out of `roomCode`.
 *
 * Removing someone from the participants list only stops them sending new
 * messages; their existing socket keeps the peer connections alive. Closing the
 * socket is what drops their media, and the 'removed-from-room' event tells the
 * client *why* so it can leave the room screen instead of reconnecting.
 *
 * Returns the number of sockets evicted (0 if they had no tab open).
 */
async function evictUserFromRoom(roomCode, userId, { banned = false, by = null } = {}) {
  if (!ioRef) return 0;

  const socketsInRoom = await ioRef.in(roomCode).fetchSockets();
  const targets = socketsInRoom.filter((s) => s.user?.id === userId);

  targets.forEach((socket) => {
    socket.emit('removed-from-room', { roomCode, banned, by });
    // Disconnecting also fires the socket's own 'disconnect' handler, which
    // announces 'peer-left' to the rest of the room so their tiles are dropped.
    socket.disconnect(true);
  });

  return targets.length;
}

/**
 * Who is connected right now, from live socket state — the users, and the
 * meeting rooms they are actually sitting in.
 *
 * Guest retention reads this so a sweep can't pull a room out from under a demo
 * that is still running. It returns empty sets until Socket.io is up (a
 * REST-only process, or a sweep run out of process), which reads as "nothing is
 * live" — accurate for a separate process, and the reason the sweep belongs in
 * the server.
 */
function getLiveSession() {
  const userIds = new Set();
  const roomCodes = new Set();
  if (!ioRef) return { userIds, roomCodes };

  for (const socket of ioRef.sockets.sockets.values()) {
    if (socket.user?.id) userIds.add(String(socket.user.id));
    // `socket.rooms` also holds the socket's own id, which is not a meeting room.
    for (const room of socket.rooms) {
      if (room !== socket.id) roomCodes.add(room);
    }
  }

  return { userIds, roomCodes };
}

function registerSocketHandlers(io) {
  ioRef = io;
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Missing auth token'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.user = { id: payload.sub, name: payload.name, email: payload.email };
      return next();
    } catch (err) {
      return next(new Error('Invalid auth token'));
    }
  });

  io.on('connection', (socket) => {
    let currentRoom = null;

    socket.on('join-room', async ({ roomCode }) => {
      try {
        const meeting = await Meeting.findOne({ roomCode });
        if (!meeting) {
          socket.emit('error-message', { error: 'Room not found.' });
          return;
        }

        // A ban has to be checked here as well as in the REST layer: this is the
        // path a kicked client takes when its socket reconnects.
        if (isBanned(meeting, socket.user.id)) {
          socket.emit('removed-from-room', { roomCode, banned: true });
          socket.emit('error-message', { error: 'You have been removed from this meeting.' });
          return;
        }

        currentRoom = roomCode;
        socket.join(roomCode);

        if (!meeting.participants.some((p) => p.toString() === socket.user.id)) {
          meeting.participants.push(socket.user.id);
          await meeting.save();
        }

        const socketsInRoom = await io.in(roomCode).fetchSockets();
        const peers = socketsInRoom
          .filter((s) => s.id !== socket.id)
          .map((s) => ({ socketId: s.id, name: s.user.name }));

        // Tell the newcomer who's already here, and tell everyone else about the newcomer.
        socket.emit('room-users', { peers });
        socket.to(roomCode).emit('peer-joined', { socketId: socket.id, name: socket.user.name });
      } catch (err) {
        console.error('[socket/join-room]', err);
        socket.emit('error-message', { error: 'Could not join room.' });
      }
    });

    // WebRTC signaling relay (SDP offers/answers, ICE candidates).
    // `to` is the target peer's socket id; payload is opaque to the server.
    // Both the sender and the target must be in the same joined room, otherwise
    // a member could relay signals at sockets outside the meeting (or an
    // outsider could probe reachable socket ids).
    socket.on('signal', ({ to, data }) => {
      if (!to || !currentRoom) return;
      const target = io.sockets.sockets.get(to);
      if (!target || !target.rooms.has(currentRoom)) return;
      io.to(to).emit('signal', { from: socket.id, name: socket.user.name, data });
    });

    socket.on('chat-message', async ({ roomCode, text }) => {
      if (!roomCode || typeof text !== 'string' || !text.trim()) return;
      // Membership isn't enough: the sender has to be *in* this room, otherwise a
      // participant who never joined could broadcast into it.
      if (currentRoom !== roomCode) return;
      if (text.trim().length > limits.MAX_CHAT_MESSAGE_CHARS) {
        socket.emit('error-message', {
          error: `Messages are limited to ${limits.MAX_CHAT_MESSAGE_CHARS} characters.`,
        });
        return;
      }
      try {
        const message = {
          sender: socket.user.id,
          senderName: socket.user.name,
          text: text.trim(),
          sentAt: new Date(),
        };
        // Atomically enforce room membership: only host/participants may post chat.
        const result = await Meeting.updateOne(
          {
            roomCode,
            $or: [{ host: socket.user.id }, { participants: socket.user.id }],
          },
          { $push: { chatMessages: message } }
        );
        if (result.modifiedCount === 0) {
          socket.emit('error-message', { error: 'You are not a member of this room.' });
          return;
        }
        io.in(roomCode).emit('chat-message', message);
      } catch (err) {
        console.error('[socket/chat-message]', err);
      }
    });

    const leaveCurrentRoom = () => {
      if (currentRoom) {
        // Note: this runs after socket.io has already removed the socket from
        // its rooms, so broadcast to the room explicitly rather than via `socket`.
        ioRef
          .in(currentRoom)
          .except(socket.id)
          .emit('peer-left', { socketId: socket.id, name: socket.user?.name });
        socket.leave(currentRoom);
        currentRoom = null;
      }
    };

    socket.on('leave-room', leaveCurrentRoom);
    socket.on('disconnect', leaveCurrentRoom);
  });
}

module.exports = { registerSocketHandlers, evictUserFromRoom, isBanned, getLiveSession };
