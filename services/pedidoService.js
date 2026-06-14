'use strict';
const db = require('../models/db');
const config = require('../config/db');
const logger = require('../utils/logger');
const ws = require('../utils/ws');

function generateNumero() {
  return 'P' + Date.now();
}

async function createPedido({ sucursal_id, mesa_id, cliente_id, tipo_pedido, usuario_creacion, detalles = [] }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const numero = generateNumero();
    const [res] = await conn.execute(
      `INSERT INTO pedidos (numero, sucursal_id, mesa_id, cliente_id, tipo_pedido, usuario_creacion)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [numero, sucursal_id, mesa_id || null, cliente_id || null, tipo_pedido, usuario_creacion || null]
    );
    const pedidoId = res.insertId;
    let subtotal = 0;

    for (const item of detalles) {
      const producto_id = item.producto_id;
      const producto_precio_id = item.producto_precio_id;
      const cantidad = Number(item.cantidad || 1);
      const precio_unitario = Number(item.precio_unitario || 0);
      let itemSubtotal = +(precio_unitario * cantidad);

      const [detailRes] = await conn.execute(
        `INSERT INTO pedido_detalles (pedido_id, producto_id, producto_precio_id, cantidad, precio_unitario, subtotal, observacion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pedidoId, producto_id, producto_precio_id, cantidad, precio_unitario.toFixed(2), itemSubtotal.toFixed(2), item.observacion || null]
      );

      const detalleId = detailRes.insertId;

      if (Array.isArray(item.modificadores)) {
        for (const mod of item.modificadores) {
          const opcion_modificador_id = mod.opcion_modificador_id;
          const modCantidad = Number(mod.cantidad || 1);
          const precio = Number(mod.precio || 0);
          await conn.execute(
            `INSERT INTO pedido_detalle_modificadores (pedido_detalle_id, opcion_modificador_id, precio, cantidad)
             VALUES (?, ?, ?, ?)`,
            [detalleId, opcion_modificador_id, precio.toFixed(2), modCantidad]
          );
          itemSubtotal += precio * modCantidad;
        }
        await conn.execute(`UPDATE pedido_detalles SET subtotal = ? WHERE id = ?`, [itemSubtotal.toFixed(2), detalleId]);
      }

      subtotal += itemSubtotal;
    }

    const igv = Number((subtotal * config.igv).toFixed(2));
    const total = Number((subtotal + igv).toFixed(2));
    await conn.execute(`UPDATE pedidos SET subtotal = ?, igv = ?, total = ? WHERE id = ?`, [subtotal.toFixed(2), igv.toFixed(2), total.toFixed(2), pedidoId]);
    await conn.execute(`INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion) VALUES (?, ?, ?, ?)`, [pedidoId, 'PENDIENTE', usuario_creacion || null, null]);
    await conn.commit();

    // emitir evento websocket
    ws.broadcast({ type: 'pedido_nuevo', data: { id: pedidoId, numero, sucursal_id } });

    return { id: pedidoId, numero };
  } catch (err) {
    await conn.rollback();
    logger.error('createPedido error', err);
    throw err;
  } finally {
    conn.release();
  }
}

async function getPedidoById(pedidoId) {
  const [rows] = await db.query(`SELECT * FROM pedidos WHERE id = ?`, [pedidoId]);
  if (!rows || rows.length === 0) return null;
  const pedido = rows[0];
  const [detalles] = await db.query(`SELECT * FROM pedido_detalles WHERE pedido_id = ?`, [pedidoId]);
  for (const det of detalles) {
    const [mods] = await db.query(`SELECT pdm.*, om.nombre as opcion_nombre FROM pedido_detalle_modificadores pdm LEFT JOIN opciones_modificador om ON pdm.opcion_modificador_id = om.id WHERE pdm.pedido_detalle_id = ?`, [det.id]);
    det.modificadores = mods || [];
  }
  pedido.detalles = detalles;
  return pedido;
}

async function listPedidosBySucursal(sucursal_id, estado) {
  let sql = `SELECT * FROM pedidos WHERE sucursal_id = ?`;
  const params = [sucursal_id];
  if (estado) {
    sql += ` AND estado = ?`;
    params.push(estado);
  }
  sql += ` ORDER BY fecha_pedido DESC LIMIT 100`;
  const [rows] = await db.query(sql, params);
  return rows;
}

async function updatePedidoEstado(pedidoId, nuevoEstado, usuarioId, observacion) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`UPDATE pedidos SET estado = ? WHERE id = ?`, [nuevoEstado, pedidoId]);
    await conn.execute(`INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion) VALUES (?, ?, ?, ?)`, [pedidoId, nuevoEstado, usuarioId || null, observacion || null]);
    await conn.commit();

    // emitir evento websocket
    ws.broadcast({ type: 'pedido_estado', data: { id: pedidoId, estado: nuevoEstado } });

    return true;
  } catch (err) {
    await conn.rollback();
    logger.error('updatePedidoEstado error', err);
    throw err;
  } finally {
    conn.release();
  }
}

async function updatePedidoDetalles(pedidoId, detalles = []) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Simple approach: eliminar detalles antiguos y reinsertar
    await conn.execute(`DELETE FROM pedido_detalle_modificadores WHERE pedido_detalle_id IN (SELECT id FROM pedido_detalles WHERE pedido_id = ?)`, [pedidoId]);
    await conn.execute(`DELETE FROM pedido_detalles WHERE pedido_id = ?`, [pedidoId]);

    let subtotal = 0;
    for (const item of detalles) {
      const producto_id = item.producto_id;
      const producto_precio_id = item.producto_precio_id;
      const cantidad = Number(item.cantidad || 1);
      const precio_unitario = Number(item.precio_unitario || 0);
      let itemSubtotal = +(precio_unitario * cantidad);

      const [detailRes] = await conn.execute(
        `INSERT INTO pedido_detalles (pedido_id, producto_id, producto_precio_id, cantidad, precio_unitario, subtotal, observacion)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pedidoId, producto_id, producto_precio_id, cantidad, precio_unitario.toFixed(2), itemSubtotal.toFixed(2), item.observacion || null]
      );

      const detalleId = detailRes.insertId;

      if (Array.isArray(item.modificadores)) {
        for (const mod of item.modificadores) {
          const opcion_modificador_id = mod.opcion_modificador_id || mod.id;
          const modCantidad = Number(mod.cantidad || 1);
          const precio = Number(mod.precio || 0);
          await conn.execute(
            `INSERT INTO pedido_detalle_modificadores (pedido_detalle_id, opcion_modificador_id, precio, cantidad)
             VALUES (?, ?, ?, ?)`,
            [detalleId, opcion_modificador_id, precio.toFixed(2), modCantidad]
          );
          itemSubtotal += precio * modCantidad;
        }
        await conn.execute(`UPDATE pedido_detalles SET subtotal = ? WHERE id = ?`, [itemSubtotal.toFixed(2), detalleId]);
      }

      subtotal += itemSubtotal;
    }

    const igv = Number((subtotal * config.igv).toFixed(2));
    const total = Number((subtotal + igv).toFixed(2));
    await conn.execute(`UPDATE pedidos SET subtotal = ?, igv = ?, total = ? WHERE id = ?`, [subtotal.toFixed(2), igv.toFixed(2), total.toFixed(2), pedidoId]);
    await conn.commit();

    // emitir evento websocket de actualización
    ws.broadcast({ type: 'pedido_actualizado', data: { id: pedidoId } });

    return true;
  } catch (err) {
    await conn.rollback();
    logger.error('updatePedidoDetalles error', err);
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { createPedido, getPedidoById, listPedidosBySucursal, updatePedidoEstado, updatePedidoDetalles };

