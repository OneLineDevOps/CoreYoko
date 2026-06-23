'use strict';
let io = null;

const sucursalService = require('../services/sucursalService');

function normalizeSucursalCode(code) {
  return String(code || '').trim().toUpperCase();
}

function sucursalRoom(code) {
  const normalized = normalizeSucursalCode(code);
  return normalized ? `sucursal:${normalized}` : null;
}

async function resolveSucursalCode({ sucursal_codigo, sucursal_code, codigo, sucursal_id }) {
  const directCode = normalizeSucursalCode(sucursal_codigo || sucursal_code || codigo);
  if (directCode) {
    const sucursal = await sucursalService.getByCode(directCode);
    return sucursal ? normalizeSucursalCode(sucursal.codigo) : null;
  }
  if (!sucursal_id) return null;

  const sucursal = await sucursalService.getById(sucursal_id);
  return sucursal && Number(sucursal.activo) === 1
    ? normalizeSucursalCode(sucursal.codigo)
    : null;
}

async function joinSucursal(socket, payload = {}) {
  try {
    const requestedCode = normalizeSucursalCode(
      payload.sucursal_codigo || payload.sucursal_code || payload.codigo
    );
    const code = await resolveSucursalCode(payload);
    const room = sucursalRoom(code);
    if (!room) {
      socket.emit('sucursal_error', {
        code: requestedCode ? 'SUCURSAL_NOT_FOUND' : 'SUCURSAL_REQUIRED',
        message: requestedCode
          ? `La sucursal ${requestedCode} no existe o está inactiva`
          : 'El código de sucursal es obligatorio',
        sucursal_codigo: requestedCode || null
      });
      return null;
    }

    if (socket.data && socket.data.sucursalRoom && socket.data.sucursalRoom !== room) {
      socket.leave(socket.data.sucursalRoom);
    }
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.sucursalCodigo = code;
    socket.data.sucursalRoom = room;
    socket.emit('sucursal_joined', { sucursal_codigo: code });
    return code;
  } catch (err) {
    console.error('socket.io join sucursal error', err);
    socket.emit('sucursal_error', { message: 'could not join sucursal channel' });
    return null;
  }
}

function init(server) {
  if (io) return io;
  try {
    const { Server } = require('socket.io');
    io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
    io.on('connection', (socket) => {
      socket.emit('welcome', { message: 'connected' });
      joinSucursal(socket, socket.handshake.query || {});
      socket.on('join_sucursal', (payload) => joinSucursal(socket, payload || {}));
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

function broadcastToSucursal(sucursalCodigo, payload) {
  if (!io) return;
  try {
    const room = sucursalRoom(sucursalCodigo);
    if (!room) return;

    if (payload && payload.type) {
      io.to(room).emit(payload.type, payload.data || {});
    } else {
      io.to(room).emit('message', payload);
    }
  } catch (err) {
    console.error('socket.io broadcast sucursal error', err);
  }
}

module.exports = {
  init,
  broadcast,
  broadcastToSucursal,
  getIO: () => io,
  resolveSucursalCode,
  sucursalRoom
};
