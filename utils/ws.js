'use strict';
let io = null;

function init(server) {
  if (io) return io;
  try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
    io.on('connection', (socket) => {
      socket.emit('welcome', { message: 'connected' });
    });
    return io;
  } catch (err) {
    console.error('socket.io init error', err);
    return null;
  }
}

function broadcast(payload) {
  if (!io) return;
  try {
    if (payload && payload.type) {
      io.emit(payload.type, payload.data || {});
    } else {
      io.emit('message', payload);
    }
  } catch (err) {
    console.error('socket.io broadcast error', err);
  }
}

module.exports = { init, broadcast, getIO: () => io };
