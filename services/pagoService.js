'use strict';
const db = require('../models/db');
const cajaService = require('./cajaService');

async function listByPedido(pedidoId) {
  const [rows] = await db.query(
    `SELECT p.*, mp.nombre AS metodo_pago
     FROM pagos p
     LEFT JOIN metodos_pago mp ON mp.id = p.metodo_pago_id
     WHERE p.pedido_id = ?
     ORDER BY p.fecha_pago DESC`,
    [pedidoId]
  );
  return rows;
}

async function create({ pedido_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id }) {
  let sessionId = sesion_caja_id || null;
  if (!sessionId) {
    const [pedidoRows] = await db.query('SELECT sucursal_id FROM pedidos WHERE id = ? LIMIT 1', [pedido_id]);
    const pedido = pedidoRows && pedidoRows.length ? pedidoRows[0] : null;
    if (!pedido) {
      const err = new Error('Pedido no encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const activeSession = await cajaService.getActiveBySucursal(pedido.sucursal_id);
    if (!activeSession) {
      const err = new Error('Debe aperturar caja antes de registrar pagos');
      err.code = 'CAJA_NO_ABIERTA';
      throw err;
    }
    sessionId = activeSession.id;
  }

  const [res] = await db.pool.execute(
    `INSERT INTO pagos (pedido_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [pedido_id, metodo_pago_id, Number(monto || 0).toFixed(2), referencia || null, usuario_id || null, sessionId]
  );
  const [rows] = await db.query('SELECT * FROM pagos WHERE id = ? LIMIT 1', [res.insertId]);
  return rows && rows.length ? rows[0] : { id: res.insertId };
}

module.exports = { listByPedido, create };
