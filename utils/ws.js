'use strict';
const WebSocket = require('ws');
let wss = null;

function init(server) {
  if (wss) return wss;
  wss = new WebSocket.Server({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'welcome', message: 'connected' }));
    socket.on('message', () => {});
  });
  return wss;
}

function broadcast(data) {
  if (!wss) return;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

module.exports = { init, broadcast };
