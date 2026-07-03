'use strict';
const db = require('../models/db');
const config = require('../config/db');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function recalculateCuenta(cuentaId, conn = db.pool) {
  const [rows] = await conn.execute(
    `SELECT
       cd.cantidad,
       pd.cantidad AS pedido_cantidad,
       pd.subtotal AS pedido_subtotal
     FROM cuenta_detalles cd
     JOIN pedido_detalles pd ON pd.id = cd.pedido_detalle_id
     WHERE cd.cuenta_id = ?`,
    [cuentaId]
  );

  const gross = rows.reduce((acc, row) => {
    const pedidoCantidad = Number(row.pedido_cantidad || 1) || 1;
    const unitSubtotal = Number(row.pedido_subtotal || 0) / pedidoCantidad;
    return acc + unitSubtotal * Number(row.cantidad || 1);
  }, 0);
  const total = money(gross);
  const subtotal = money(total / (1 + config.igv));

  await conn.execute(
    'UPDATE cuentas SET subtotal = ?, total = ? WHERE id = ?',
    [subtotal.toFixed(2), total.toFixed(2), cuentaId]
  );

  return { subtotal, igv: money(total - subtotal), total };
}

async function listByPedido(pedidoId) {
  const [rows] = await db.query(
    'SELECT * FROM cuentas WHERE pedido_id = ? ORDER BY id',
    [pedidoId]
  );
  return rows;
}

async function getById(id) {
  const [rows] = await db.query('SELECT * FROM cuentas WHERE id = ? LIMIT 1', [id]);
  if (!rows || !rows.length) return null;
  const cuenta = rows[0];
  const [detalles] = await db.query(
    `SELECT
       cd.id,
       cd.cuenta_id,
       cd.pedido_detalle_id,
       cd.cantidad,
       pd.producto_id,
       pd.producto_precio_id,
       pd.precio_unitario,
       pd.subtotal AS pedido_subtotal,
       pd.observacion,
       p.nombre AS producto_nombre,
       p.nombre AS descripcion,
       ROUND((pd.subtotal / NULLIF(pd.cantidad, 0)) * cd.cantidad, 2) AS subtotal
     FROM cuenta_detalles cd
     JOIN pedido_detalles pd ON pd.id = cd.pedido_detalle_id
     LEFT JOIN productos p ON p.id = pd.producto_id
     WHERE cd.cuenta_id = ?
     ORDER BY cd.id`,
    [id]
  );
  cuenta.detalles = detalles || [];
  const [comprobantes] = await db.query(
    `SELECT comp.id, comp.tipo, comp.serie, comp.numero, comp.fecha_emision,
            comp.total, comp.estado, comp.sunat_estado, comp.sunat_mensaje,
            comp.comprobante_referencia_id, comp.motivo_codigo, comp.motivo_descripcion,
            nc.id AS nota_credito_id, nc.serie AS nota_credito_serie,
            nc.numero AS nota_credito_numero, nc.sunat_estado AS nota_credito_sunat_estado
     FROM comprobantes comp
     LEFT JOIN comprobantes nc ON nc.id = (
       SELECT nc2.id FROM comprobantes nc2
       WHERE nc2.comprobante_referencia_id = comp.id
         AND nc2.tipo = 'NOTA_CREDITO'
       ORDER BY nc2.id DESC LIMIT 1
     )
     WHERE comp.cuenta_id = ?
     ORDER BY comp.id DESC`,
    [id]
  );
  cuenta.comprobantes = comprobantes || [];
  return cuenta;
}

async function create({ pedido_id, nombre, observacion, detalles = [] }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [res] = await conn.execute(
      'INSERT INTO cuentas (pedido_id, nombre, observacion, estado) VALUES (?, ?, ?, "ABIERTA")',
      [pedido_id, nombre || null, observacion || null]
    );
    const cuentaId = res.insertId;

    if (Array.isArray(detalles)) {
      for (const detalle of detalles) {
        if (!detalle.pedido_detalle_id) continue;
        await conn.execute(
          'INSERT INTO cuenta_detalles (cuenta_id, pedido_detalle_id, cantidad) VALUES (?, ?, ?)',
          [cuentaId, detalle.pedido_detalle_id, detalle.cantidad || 1]
        );
      }
    }

    await recalculateCuenta(cuentaId, conn);
    await conn.commit();
    return getById(cuentaId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function addDetalle(cuentaId, { pedido_detalle_id, cantidad = 1 }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.execute(
      'SELECT id, cantidad FROM cuenta_detalles WHERE cuenta_id = ? AND pedido_detalle_id = ? LIMIT 1',
      [cuentaId, pedido_detalle_id]
    );

    if (existing && existing.length) {
      await conn.execute(
        'UPDATE cuenta_detalles SET cantidad = cantidad + ? WHERE id = ?',
        [cantidad, existing[0].id]
      );
    } else {
      await conn.execute(
        'INSERT INTO cuenta_detalles (cuenta_id, pedido_detalle_id, cantidad) VALUES (?, ?, ?)',
        [cuentaId, pedido_detalle_id, cantidad]
      );
    }

    await recalculateCuenta(cuentaId, conn);
    await conn.commit();
    return getById(cuentaId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function removeDetalle(detalleId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT cuenta_id FROM cuenta_detalles WHERE id = ? LIMIT 1', [detalleId]);
    if (!rows || !rows.length) {
      await conn.rollback();
      return null;
    }
    const cuentaId = rows[0].cuenta_id;
    await conn.execute('DELETE FROM cuenta_detalles WHERE id = ?', [detalleId]);
    await recalculateCuenta(cuentaId, conn);
    await conn.commit();
    return { id: Number(detalleId), deleted: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function updateEstado(id, estado) {
  await db.pool.execute('UPDATE cuentas SET estado = ? WHERE id = ?', [estado, id]);
  return getById(id);
}

async function remove(id) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT estado FROM cuentas WHERE id = ? LIMIT 1', [id]);
    if (!rows || !rows.length) {
      await conn.rollback();
      return null;
    }
    if (rows[0].estado !== 'ABIERTA') {
      const err = new Error('Solo se pueden eliminar cuentas abiertas');
      err.code = 'INVALID_STATE';
      throw err;
    }

    const [comps] = await conn.execute('SELECT id FROM comprobantes WHERE cuenta_id = ? LIMIT 1', [id]);
    if (comps && comps.length) {
      const err = new Error('La cuenta ya tiene comprobante emitido');
      err.code = 'INVALID_STATE';
      throw err;
    }

    await conn.execute('DELETE FROM cuenta_detalles WHERE cuenta_id = ?', [id]);
    await conn.execute('DELETE FROM cuentas WHERE id = ?', [id]);
    await conn.commit();
    return { id: Number(id), deleted: true };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function allPedidoCuentasClosed(pedidoId) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN estado = 'ABIERTA' THEN 1 ELSE 0 END) AS abiertas
     FROM cuentas WHERE pedido_id = ?`,
    [pedidoId]
  );
  const row = rows[0] || {};
  return Number(row.total || 0) > 0 && Number(row.abiertas || 0) === 0;
}

module.exports = {
  listByPedido,
  getById,
  create,
  addDetalle,
  removeDetalle,
  updateEstado,
  remove,
  recalculateCuenta,
  allPedidoCuentasClosed
};
