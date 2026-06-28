'use strict';
const db = require('../models/db');
const config = require('../config/db');
const logger = require('../utils/logger');
const ws = require('../utils/ws');
const trabajoImpresionService = require('./trabajoImpresionService');

function generateNumero() {
  return 'P' + Date.now();
}

function normalizeMesaTemporalCodigo(value) {
  if (value === undefined || value === null) return null;
  const codigo = String(value).trim().replace(/\s+/g, ' ');
  if (!codigo) return null;
  if (codigo.length > 20) {
    const err = new Error('El nombre de la mesa temporal admite hasta 20 caracteres');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  return codigo;
}

async function reserveMesaTemporalCodigo(conn, sucursalId, requestedCode = null, pedidoId = null) {
  const lockName = `mesa-temporal-${sucursalId}`;
  const [lockRows] = await conn.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
  if (!lockRows?.[0] || Number(lockRows[0].acquired) !== 1) {
    const err = new Error('No se pudo reservar un código de mesa temporal');
    err.code = 'TEMPORAL_CODE_LOCK';
    throw err;
  }

  if (requestedCode) {
    const [duplicates] = await conn.execute(
      `SELECT id
       FROM pedidos
       WHERE sucursal_id = ?
         AND mesa_temporal_codigo = ?
         AND estado NOT IN ('ENTREGADO', 'ANULADO')
         AND (? IS NULL OR id <> ?)
       LIMIT 1`,
      [sucursalId, requestedCode, pedidoId, pedidoId]
    );
    if (duplicates?.length) {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      const err = new Error(`Ya existe una mesa temporal abierta con el nombre "${requestedCode}"`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    return { codigo: requestedCode, lockName };
  }

  const [rows] = await conn.execute(
    `SELECT COALESCE(MAX(CAST(SUBSTRING(mesa_temporal_codigo, 3) AS UNSIGNED)), 0) + 1 AS correlativo
     FROM pedidos
     WHERE sucursal_id = ?
       AND DATE(fecha_pedido) = CURDATE()
       AND mesa_temporal_codigo REGEXP '^T-[0-9]+$'`,
    [sucursalId]
  );
  const correlativo = Number(rows?.[0]?.correlativo || 1);
  return {
    codigo: `T-${String(correlativo).padStart(3, '0')}`,
    lockName
  };
}

async function getPedidoSucursalCode(pedidoId) {
  const [rows] = await db.query(
    `SELECT s.codigo
     FROM pedidos p
     JOIN sucursales s ON s.id = p.sucursal_id
     WHERE p.id = ?
     LIMIT 1`,
    [pedidoId]
  );
  return rows && rows.length ? rows[0].codigo : null;
}

async function createPedido({
  sucursal_id,
  mesa_id,
  seccion_id,
  mesa_temporal,
  mesa_temporal_codigo,
  cliente_id,
  tipo_pedido,
  usuario_creacion,
  detalles = []
}) {
  if (!sucursal_id) {
    const err = new Error('sucursal_id is required');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (!mesa_id && !mesa_temporal && tipo_pedido === 'MESA') {
    const err = new Error('Seleccione una mesa física o temporal');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }
  if (mesa_temporal && !seccion_id) {
    const err = new Error('Seleccione la sección de la mesa temporal');
    err.code = 'VALIDATION_ERROR';
    throw err;
  }

  const conn = await db.getConnection();
  let temporalLockName = null;
  try {
    await conn.beginTransaction();
    const numero = generateNumero();
    let mesaTemporalCodigo = null;
    if (mesa_temporal) {
      const [sections] = await conn.execute(
        `SELECT id
         FROM secciones_mesa
         WHERE id = ? AND sucursal_id = ? AND activo = 1
         LIMIT 1`,
        [seccion_id, sucursal_id]
      );
      if (!sections?.length) {
        const err = new Error('La sección seleccionada no pertenece a la sucursal');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const requestedCode = normalizeMesaTemporalCodigo(mesa_temporal_codigo);
      const temporal = await reserveMesaTemporalCodigo(conn, sucursal_id, requestedCode);
      mesaTemporalCodigo = temporal.codigo;
      temporalLockName = temporal.lockName;
    }
    const [res] = await conn.execute(
      `INSERT INTO pedidos
       (numero, sucursal_id, mesa_id, seccion_id, mesa_temporal_codigo, cliente_id, tipo_pedido, usuario_creacion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        numero,
        sucursal_id,
        mesa_temporal ? null : (mesa_id || null),
        mesa_temporal ? seccion_id : null,
        mesaTemporalCodigo,
        cliente_id || null,
        tipo_pedido,
        usuario_creacion || null
      ]
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

    const total = Number(subtotal.toFixed(2));
    const base = Number((total / (1 + config.igv)).toFixed(2));
    const igv = Number((total - base).toFixed(2));
    await conn.execute(`UPDATE pedidos SET subtotal = ?, igv = ?, total = ? WHERE id = ?`, [base.toFixed(2), igv.toFixed(2), total.toFixed(2), pedidoId]);
    await conn.execute(`INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion) VALUES (?, ?, ?, ?)`, [pedidoId, 'PENDIENTE', usuario_creacion || null, null]);
    await conn.commit();

    try {
      // emitir evento websocket al canal de la sucursal
      const sucursalCodigo = await getPedidoSucursalCode(pedidoId);
      const pedido = await getPedidoById(pedidoId);
      ws.broadcastToSucursal(sucursalCodigo, {
        type: 'pedido_nuevo',
        data: { ...(pedido || {}), id: pedidoId, numero, sucursal_id, sucursal_codigo: sucursalCodigo }
      });
      await trabajoImpresionService.enqueueOrder(pedido, 'NUEVO');
    } catch (emitErr) {
      logger.error('pedido_nuevo websocket error', emitErr);
    }

    return {
      id: pedidoId,
      numero,
      seccion_id: mesa_temporal ? Number(seccion_id) : null,
      mesa_temporal_codigo: mesaTemporalCodigo
    };
  } catch (err) {
    await conn.rollback();
    logger.error('createPedido error', err);
    throw err;
  } finally {
    if (temporalLockName) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [temporalLockName]);
      } catch (releaseErr) {
        logger.error('release mesa temporal lock error', releaseErr);
      }
    }
    conn.release();
  }
}

async function getPedidoById(pedidoId) {
  const [rows] = await db.query(
    `SELECT
       p.*,
       COALESCE(m.codigo, p.mesa_temporal_codigo) AS mesa_nombre,
       cli.tipo_documento,
       cli.numero_documento,
       cli.razon_social,
       cli.nombres,
       cli.apellidos,
       cli.telefono,
       cli.correo,
       cli.direccion,
       u.usuario AS usuario_creacion_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_creacion_nombre,
       he.fecha AS estado_fecha
     FROM pedidos p
     LEFT JOIN mesas m ON m.id = p.mesa_id
     LEFT JOIN clientes cli ON cli.id = p.cliente_id
     LEFT JOIN usuarios u ON u.id = p.usuario_creacion
     LEFT JOIN (
       SELECT h1.pedido_id, h1.fecha
       FROM historial_estado_pedido h1
       JOIN (
         SELECT pedido_id, MAX(id) AS max_id
         FROM historial_estado_pedido
         GROUP BY pedido_id
       ) hx ON hx.max_id = h1.id
     ) he ON he.pedido_id = p.id
     WHERE p.id = ?`,
    [pedidoId]
  );
  if (!rows || rows.length === 0) return null;
  const pedido = rows[0];
  if (pedido.cliente_id) {
    pedido.cliente = {
      id: pedido.cliente_id,
      tipo_documento: pedido.tipo_documento,
      numero_documento: pedido.numero_documento,
      razon_social: pedido.razon_social,
      nombres: pedido.nombres,
      apellidos: pedido.apellidos,
      telefono: pedido.telefono,
      correo: pedido.correo,
      direccion: pedido.direccion
    };
    pedido.cliente_nombre = pedido.razon_social || `${pedido.nombres || ''} ${pedido.apellidos || ''}`.trim();
  }
  const [detalles] = await db.query(
    `SELECT
       pd.*,
       p.nombre AS producto_nombre,
       p.nombre AS descripcion,
       pp.nombre_precio
     FROM pedido_detalles pd
     LEFT JOIN productos p ON p.id = pd.producto_id
     LEFT JOIN producto_precios pp ON pp.id = pd.producto_precio_id
     WHERE pd.pedido_id = ?
     ORDER BY pd.id`,
    [pedidoId]
  );
  for (const det of detalles) {
    const [mods] = await db.query(`SELECT pdm.*, om.nombre as opcion_nombre FROM pedido_detalle_modificadores pdm LEFT JOIN opciones_modificador om ON pdm.opcion_modificador_id = om.id WHERE pdm.pedido_detalle_id = ?`, [det.id]);
    det.modificadores = mods || [];
  }
  pedido.detalles = detalles;
  return pedido;
}

async function listPedidosBySucursal(sucursal_id, estado) {
  let sql = `SELECT
      p.*,
      COALESCE(m.codigo, p.mesa_temporal_codigo) AS mesa_nombre,
      cli.razon_social,
      cli.nombres,
      cli.apellidos,
      COALESCE(cli.razon_social, TRIM(CONCAT(COALESCE(cli.nombres, ''), ' ', COALESCE(cli.apellidos, '')))) AS cliente_nombre,
      u.usuario AS usuario_creacion_usuario,
      COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_creacion_nombre,
      he.fecha AS estado_fecha
    FROM pedidos p
    LEFT JOIN mesas m ON m.id = p.mesa_id
    LEFT JOIN clientes cli ON cli.id = p.cliente_id
    LEFT JOIN usuarios u ON u.id = p.usuario_creacion
    LEFT JOIN (
      SELECT h1.pedido_id, h1.fecha
      FROM historial_estado_pedido h1
      JOIN (
        SELECT pedido_id, MAX(id) AS max_id
        FROM historial_estado_pedido
        GROUP BY pedido_id
      ) hx ON hx.max_id = h1.id
    ) he ON he.pedido_id = p.id
    WHERE p.sucursal_id = ?`;
  const params = [sucursal_id];
  if (estado) {
    sql += ` AND p.estado = ?`;
    params.push(estado);
  } else {
    sql += ` AND p.estado <> 'ANULADO'`;
  }
  sql += ` ORDER BY p.fecha_pedido DESC LIMIT 100`;
  const [rows] = await db.query(sql, params);
  return rows;
}

async function updatePedidoEstado(pedidoId, nuevoEstado, usuarioId, observacion) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(`UPDATE pedidos SET estado = ? WHERE id = ?`, [nuevoEstado, pedidoId]);
    await conn.execute(`INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion) VALUES (?, ?, ?, ?)`, [pedidoId, nuevoEstado, usuarioId || null, observacion || null]);
    if (nuevoEstado === 'ENTREGADO' || nuevoEstado === 'ANULADO') {
      await conn.execute(
        `UPDATE mesas m
         JOIN pedidos p ON p.mesa_id = m.id
         SET m.estado = 'LIBRE'
         WHERE p.id = ? AND m.estado <> 'RESERVADA'`,
        [pedidoId]
      );
    }
    await conn.commit();

    try {
      // emitir evento websocket al canal de la sucursal
      const sucursalCodigo = await getPedidoSucursalCode(pedidoId);
      ws.broadcastToSucursal(sucursalCodigo, { type: 'pedido_estado', data: { id: pedidoId, estado: nuevoEstado, sucursal_codigo: sucursalCodigo } });
    } catch (emitErr) {
      logger.error('pedido_estado websocket error', emitErr);
    }

    return true;
  } catch (err) {
    await conn.rollback();
    logger.error('updatePedidoEstado error', err);
    throw err;
  } finally {
    conn.release();
  }
}

async function updatePedidoDetalles(pedidoId, detalles = [], mesaTemporalCodigoInput = undefined) {
  const conn = await db.getConnection();
  let temporalLockName = null;
  try {
    await conn.beginTransaction();
    if (mesaTemporalCodigoInput !== undefined) {
      const [pedidoRows] = await conn.execute(
        `SELECT id, sucursal_id, mesa_temporal_codigo
         FROM pedidos
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [pedidoId]
      );
      const pedido = pedidoRows?.[0];
      if (!pedido) {
        const err = new Error('Pedido no encontrado');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (!pedido.mesa_temporal_codigo) {
        const err = new Error('El pedido no corresponde a una mesa temporal');
        err.code = 'VALIDATION_ERROR';
        throw err;
      }
      const requestedCode = normalizeMesaTemporalCodigo(mesaTemporalCodigoInput);
      const temporal = await reserveMesaTemporalCodigo(
        conn,
        pedido.sucursal_id,
        requestedCode,
        pedido.id
      );
      temporalLockName = temporal.lockName;
      await conn.execute(
        'UPDATE pedidos SET mesa_temporal_codigo = ? WHERE id = ?',
        [temporal.codigo, pedidoId]
      );
    }
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

    const total = Number(subtotal.toFixed(2));
    const base = Number((total / (1 + config.igv)).toFixed(2));
    const igv = Number((total - base).toFixed(2));
    await conn.execute(`UPDATE pedidos SET subtotal = ?, igv = ?, total = ? WHERE id = ?`, [base.toFixed(2), igv.toFixed(2), total.toFixed(2), pedidoId]);
    await conn.commit();

    try {
      // emitir evento websocket de actualización al canal de la sucursal
      const sucursalCodigo = await getPedidoSucursalCode(pedidoId);
      const pedido = await getPedidoById(pedidoId);
      ws.broadcastToSucursal(sucursalCodigo, {
        type: 'pedido_actualizado',
        data: { ...(pedido || {}), id: pedidoId, sucursal_codigo: sucursalCodigo }
      });
      await trabajoImpresionService.enqueueOrder(pedido, 'ACTUALIZADO');
    } catch (emitErr) {
      logger.error('pedido_actualizado websocket error', emitErr);
    }

    return true;
  } catch (err) {
    await conn.rollback();
    logger.error('updatePedidoDetalles error', err);
    throw err;
  } finally {
    if (temporalLockName) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [temporalLockName]);
      } catch (releaseErr) {
        logger.error('release mesa temporal update lock error', releaseErr);
      }
    }
    conn.release();
  }
}

module.exports = { createPedido, getPedidoById, listPedidosBySucursal, updatePedidoEstado, updatePedidoDetalles };
