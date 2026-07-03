'use strict';
const db = require('../models/db');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function mapSession(row) {
  if (!row) return null;
  return {
    ...row,
    monto_inicial: money(row.monto_inicial),
    monto_final: row.monto_final === null || row.monto_final === undefined ? null : money(row.monto_final),
    diferencia: row.diferencia === null || row.diferencia === undefined ? null : money(row.diferencia),
    total_pagos: money(row.total_pagos),
    total_esperado: money(row.total_esperado),
  };
}

async function getActiveBySucursal(sucursalId) {
  const [rows] = await db.query(
    `SELECT
       sc.*,
       ua.usuario AS usuario_apertura_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(ua.nombre, ''), ' ', COALESCE(ua.apellido, ''))), ''), ua.usuario) AS usuario_apertura_nombre,
       COALESCE(pg.total_pagos, 0) AS total_pagos,
       sc.monto_inicial + COALESCE(pg.total_pagos, 0) AS total_esperado
     FROM sesiones_caja sc
     LEFT JOIN usuarios ua ON ua.id = sc.usuario_apertura
     LEFT JOIN (
       SELECT sesion_caja_id, SUM(monto) AS total_pagos
       FROM pagos
       WHERE estado = 'ACTIVO'
       GROUP BY sesion_caja_id
     ) pg ON pg.sesion_caja_id = sc.id
     WHERE sc.sucursal_id = ? AND sc.estado = 'ABIERTA'
     ORDER BY sc.fecha_apertura DESC
     LIMIT 1`,
    [sucursalId]
  );
  return rows && rows.length ? mapSession(rows[0]) : null;
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT
       sc.*,
       s.nombre AS sucursal_nombre,
       ua.usuario AS usuario_apertura_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(ua.nombre, ''), ' ', COALESCE(ua.apellido, ''))), ''), ua.usuario) AS usuario_apertura_nombre,
       uc.usuario AS usuario_cierre_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(uc.nombre, ''), ' ', COALESCE(uc.apellido, ''))), ''), uc.usuario) AS usuario_cierre_nombre,
       COALESCE(pg.total_pagos, 0) AS total_pagos,
       sc.monto_inicial + COALESCE(pg.total_pagos, 0) AS total_esperado
     FROM sesiones_caja sc
     LEFT JOIN sucursales s ON s.id = sc.sucursal_id
     LEFT JOIN usuarios ua ON ua.id = sc.usuario_apertura
     LEFT JOIN usuarios uc ON uc.id = sc.usuario_cierre
     LEFT JOIN (
       SELECT sesion_caja_id, SUM(monto) AS total_pagos
       FROM pagos
       WHERE estado = 'ACTIVO'
       GROUP BY sesion_caja_id
     ) pg ON pg.sesion_caja_id = sc.id
     WHERE sc.id = ?
     LIMIT 1`,
    [id]
  );
  return rows && rows.length ? mapSession(rows[0]) : null;
}

async function open({ sucursal_id, usuario_id, monto_inicial = 0, observacion_apertura = null }) {
  const active = await getActiveBySucursal(sucursal_id);
  if (active) {
    const err = new Error('Ya existe una caja abierta para esta sucursal');
    err.code = 'CAJA_ABIERTA';
    err.session = active;
    throw err;
  }

  const [res] = await db.pool.execute(
    `INSERT INTO sesiones_caja
     (sucursal_id, usuario_apertura, fecha_apertura, monto_inicial, estado, observacion_apertura)
     VALUES (?, ?, NOW(), ?, 'ABIERTA', ?)`,
    [sucursal_id, usuario_id, money(monto_inicial).toFixed(2), observacion_apertura || null]
  );
  return getById(res.insertId);
}

async function getSummary(sessionId) {
  const session = await getById(sessionId);
  if (!session) return null;

  const [metodos] = await db.query(
    `SELECT
       mp.id AS metodo_pago_id,
       mp.nombre AS metodo_pago,
       COUNT(p.id) AS cantidad,
       COALESCE(SUM(p.monto), 0) AS total
     FROM pagos p
     LEFT JOIN metodos_pago mp ON mp.id = p.metodo_pago_id
     WHERE p.sesion_caja_id = ?
       AND p.estado = 'ACTIVO'
     GROUP BY mp.id, mp.nombre
     ORDER BY mp.nombre`,
    [sessionId]
  );

  const [pagos] = await db.query(
    `SELECT
       p.*,
       mp.nombre AS metodo_pago,
       ped.numero AS pedido_numero,
       COALESCE(m.codigo, ped.mesa_temporal_codigo) AS mesa_codigo,
       COALESCE(cli.razon_social, TRIM(CONCAT(COALESCE(cli.nombres, ''), ' ', COALESCE(cli.apellidos, '')))) AS cliente_nombre,
       u.usuario AS usuario_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_nombre
     FROM pagos p
     LEFT JOIN metodos_pago mp ON mp.id = p.metodo_pago_id
     LEFT JOIN pedidos ped ON ped.id = p.pedido_id
     LEFT JOIN mesas m ON m.id = ped.mesa_id
     LEFT JOIN clientes cli ON cli.id = ped.cliente_id
     LEFT JOIN usuarios u ON u.id = p.usuario_id
     WHERE p.sesion_caja_id = ?
       AND p.estado = 'ACTIVO'
     ORDER BY p.fecha_pago DESC`,
    [sessionId]
  );

  const [comprobantes] = await db.query(
    `SELECT DISTINCT
       comp.id, comp.tipo, comp.serie, comp.numero, comp.fecha_emision,
       comp.total, comp.estado, comp.metodo_pago_id, mp.nombre AS metodo_pago,
       c.pedido_id, ped.numero AS pedido_numero, comp.origen
     FROM comprobantes comp
     LEFT JOIN cuentas c ON c.id = comp.cuenta_id
     LEFT JOIN pedidos ped ON ped.id = c.pedido_id
     LEFT JOIN pagos p ON p.comprobante_id = comp.id
     LEFT JOIN metodos_pago mp ON mp.id = comp.metodo_pago_id
     WHERE (comp.sesion_caja_id = ? OR p.sesion_caja_id = ?)
       AND comp.tipo <> 'NOTA_CREDITO'
       AND comp.estado <> 'ANULADO'
     ORDER BY comp.fecha_emision DESC, comp.id DESC`,
    [sessionId, sessionId]
  );

  return {
    session,
    metodos: (metodos || []).map((row) => ({ ...row, total: money(row.total) })),
    pagos: (pagos || []).map((row) => ({ ...row, monto: money(row.monto) })),
    comprobantes: (comprobantes || []).map((row) => ({ ...row, total: money(row.total) })),
  };
}

async function close({ id, usuario_id, monto_final, observacion_cierre = null }) {
  const session = await getById(id);
  if (!session) {
    const err = new Error('Sesión de caja no encontrada');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (session.estado !== 'ABIERTA') {
    const err = new Error('La caja ya está cerrada');
    err.code = 'CAJA_CERRADA';
    throw err;
  }

  const totalEsperado = money(session.total_esperado);
  const finalAmount = money(monto_final);
  const diferencia = money(finalAmount - totalEsperado);

  await db.pool.execute(
    `UPDATE sesiones_caja
     SET estado = 'CERRADA',
         fecha_cierre = NOW(),
         usuario_cierre = ?,
         monto_final = ?,
         diferencia = ?,
         observacion_cierre = ?
     WHERE id = ?`,
    [usuario_id, finalAmount.toFixed(2), diferencia.toFixed(2), observacion_cierre || null, id]
  );

  return getSummary(id);
}

module.exports = { getActiveBySucursal, getById, getSummary, open, close };
