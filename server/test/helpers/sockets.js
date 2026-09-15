/**
 * Socket.io helpers for tests: connect a client as a given user, join a room,
 * and await events without hand-rolling promises in every test.
 */
const { io: ioClient } = require('socket.io-client');

function waitForEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for '${event}'`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function connect(baseUrl, token) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(baseUrl, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

async function joinRoom(socket, roomCode) {
  const ready = waitForEvent(socket, 'room-users');
  socket.emit('join-room', { roomCode });
  return ready;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { connect, joinRoom, waitForEvent, sleep };
