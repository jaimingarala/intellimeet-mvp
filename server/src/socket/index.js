const jwt = require('jsonwebtoken');
const Meeting = require('../models/Meeting');
const limits = require('../config/limits');
const { log } = require('../lib/logger');

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

/** Recent chat timestamps per user, for the flood cap below. */
const chatWindow = new Map();

function isBanned(meeting, userId) {
  return (meeting.banned || []).some((b) => b.toString() === userId);
}

/**
 * How many bytes this payload serialises to, or Infinity if it can't be
 * serialised at all — in which case refusing it is the only safe answer.
 */
function payloadSize(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Whether this user has used up their chat budget for the window.
 *
 * Keyed by user rather than by socket on purpose: a second tab shares the
 * budget, and reconnecting does not hand out a fresh one. Entries are dropped
 * once their window is empty, so the map tracks the people who are talking
 * rather than everyone who ever did.
 */
function chatFlooding(userId) {
  const { windowMs, max } = limits.CHAT_RATE_LIMIT;
  const now = Date.now();

  if (chatWindow.size > 500) {
    for (const [key, times] of chatWindow) {
      if (times.every((at) => now - at >= windowMs)) chatWindow.delete(key);
    }
  }

  const recent = (chatWindow.get(userId) || []).filter((at) => now - at < windowMs);
  if (recent.length >= max) {
    chatWindow.set(userId, recent);
    return true;
  }

  recent.push(now);
  chatWindow.set(userId, recent);
  return false;
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

/**
 * Broadcast to everyone in a room, from the REST layer.
 *
 * A route that changes something the room can see (an action item ticked off)
 * has no socket of its own, and going through `ioRef` is what keeps the live
 * view and the stored document from disagreeing until someone refreshes.
 *
 * Returns false when Socket.io isn't up at all — a REST-only process, or an
 * out-of-process sweep — which is a fact the caller can report rather than an
 * error worth throwing.
 */
function emitToRoom(roomCode, event, payload) {
  if (!ioRef) return false;
  ioRef.in(roomCode).emit(event, payload);
  return true;
}

/**
 * The media flags a client may announce, with anything unrecognised dropped.
 *
 * Fixed and small on purpose: this rides through the same relay as signalling,
 * and a client that sends `{ screen: 'yes' }` should be ignored rather than
 * teaching every other client to render a badge off a string.
 */
const MEDIA_FLAGS = ['mic', 'camera', 'screen'];

function normaliseMediaState(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const state = {};
  for (const flag of MEDIA_FLAGS) {
    if (typeof payload[flag] === 'boolean') state[flag] = payload[flag];
  }
  return Object.keys(state).length > 0 ? state : null;
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

    // Payloads are guarded rather than destructured into the handler signature.
    // `async ({ roomCode }) => …` throws on a client that emits with no argument,
    // and a throw inside an async listener is an unhandled rejection: the server
    // would log nothing and the client would hang instead of being told.
    socket.on('join-room', async (payload) => {
      const roomCode = payload?.roomCode;
      if (
        typeof roomCode !== 'string' ||
        roomCode.length === 0 ||
        roomCode.length > limits.MAX_ROOM_CODE_CHARS
      ) {
        socket.emit('error-message', { error: 'A valid roomCode is required.' });
        return;
      }

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
        log.error('join-room failed', {
          scope: 'socket/join-room',
          userId: socket.user?.id,
          roomCode,
          err,
        });
        socket.emit('error-message', { error: 'Could not join room.' });
      }
    });

    // WebRTC signaling relay (SDP offers/answers, ICE candidates).
    // `to` is the target peer's socket id; payload is opaque to the server.
    // Both the sender and the target must be in the same joined room, otherwise
    // a member could relay signals at sockets outside the meeting (or an
    // outsider could probe reachable socket ids).
    socket.on('signal', (payload) => {
      const { to, data } = payload || {};
      if (typeof to !== 'string' || !currentRoom) return;

      // Opaque to the server, but not unbounded: without this the relay would
      // happily move arbitrary amounts of data between two members. A real offer
      // with a full codec list is a few KB.
      if (payloadSize(data) > limits.MAX_SIGNAL_CHARS) {
        socket.emit('error-message', {
          error: `Signalling payloads are limited to ${limits.MAX_SIGNAL_CHARS} characters.`,
        });
        return;
      }

      const target = io.sockets.sockets.get(to);
      if (!target || !target.rooms.has(currentRoom)) return;
      io.to(to).emit('signal', { from: socket.id, name: socket.user.name, data });
    });

    socket.on('chat-message', async (payload) => {
      const { roomCode, text } = payload || {};
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
      // Each message is a database write and a broadcast to everyone in the
      // room, so a stuck client or a loop can cost the whole meeting.
      if (chatFlooding(String(socket.user.id))) {
        socket.emit('error-message', { error: 'You are sending messages too quickly.' });
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
          { $push: { chatMessages: message } },
        );
        if (result.modifiedCount === 0) {
          socket.emit('error-message', { error: 'You are not a member of this room.' });
          return;
        }
        io.in(roomCode).emit('chat-message', message);
      } catch (err) {
        log.error('chat relay failed', {
          scope: 'socket/chat-message',
          userId: socket.user?.id,
          roomCode,
          err,
        });
      }
    });

    // "My mic is off / my camera is off / I am sharing my screen" — what a tile
    // cannot work out for itself. A remote track carries no display surface, so
    // without this the room sees a screen share as a webcam and a muted
    // participant as one who is simply not talking.
    socket.on('media-state', (payload) => {
      if (!currentRoom) return;
      const state = normaliseMediaState(payload);
      if (!state) return;

      // Only who and what — the room already learned the name when the socket
      // joined, and a payload of exactly the flags is one a client can merge
      // without wondering which keys it is allowed to trust.
      socket.to(currentRoom).emit('media-state', { socketId: socket.id, ...state });
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

module.exports = {
  registerSocketHandlers,
  evictUserFromRoom,
  emitToRoom,
  isBanned,
  getLiveSession,
  chatFlooding,
  payloadSize,
};
