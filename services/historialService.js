'use strict';
const db = require('../models/db');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function buildFilters(query) {
  const filters = ['ped.sucursal_id = ?', 'DATE(p.fecha_pago) = ?'];
  const params = [query.sucursal_id, normalizeDate(query.fecha)];

  if (query.usuario_id) {
    filters.push('p.usuario_id = ?');
    params.push(query.usuario_id);
  }
  if (query.sesion_caja_id) {
    filters.push('p.sesion_caja_id = ?');
    params.push(query.sesion_caja_id);
  }
  if (query.metodo_pago_id) {
    filters.push('p.metodo_pago_id = ?');
    params.push(query.metodo_pago_id);
  }
  if (query.tipo) {
    filters.push('comp.tipo = ?');
    params.push(query.tipo);
  }
  if (query.sunat_estado) {
    filters.push('comp.sunat_estado = ?');
    params.push(query.sunat_estado);
  }

  return { where: filters.join(' AND '), params };
}

function baseFrom() {
  return `
    FROM pagos p
    JOIN pedidos ped ON ped.id = p.pedido_id
    LEFT JOIN metodos_pago mp ON mp.id = p.metodo_pago_id
    LEFT JOIN sesiones_caja sc ON sc.id = p.sesion_caja_id
    LEFT JOIN usuarios u ON u.id = p.usuario_id
    LEFT JOIN mesas m ON m.id = ped.mesa_id
    LEFT JOIN clientes cli ON cli.id = ped.cliente_id
    LEFT JOIN comprobantes comp ON comp.id = (
      SELECT c2.id
      FROM comprobantes c2
      JOIN cuentas cu2 ON cu2.id = c2.cuenta_id
      WHERE cu2.pedido_id = ped.id
        AND c2.estado <> 'ANULADO'
        AND (c2.metodo_pago_id = p.metodo_pago_id OR c2.metodo_pago_id IS NULL)
        AND ABS(c2.total - p.monto) < 0.01
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, c2.fecha_emision, p.fecha_pago)), c2.id DESC
      LIMIT 1
    )
    LEFT JOIN sunat_envios se ON se.comprobante_id = comp.id
  `;
}

async function list(query) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(100, Math.max(10, Number(query.limit || 25)));
  const offset = (page - 1) * limit;
  const { where, params } = buildFilters(query);

  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total ${baseFrom()} WHERE ${where}`,
    params
  );

  const [rows] = await db.query(
    `SELECT
       p.id AS pago_id,
       p.fecha_pago,
       p.monto,
       p.referencia,
       p.sesion_caja_id,
       p.usuario_id,
       p.metodo_pago_id,
       mp.nombre AS metodo_pago,
       ped.id AS pedido_id,
       ped.numero AS pedido_numero,
       COALESCE(m.codigo, ped.mesa_temporal_codigo) AS mesa_codigo,
       COALESCE(cli.razon_social, TRIM(CONCAT(COALESCE(cli.nombres, ''), ' ', COALESCE(cli.apellidos, '')))) AS cliente_nombre,
       u.usuario AS usuario_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_nombre,
       sc.estado AS caja_estado,
       sc.fecha_apertura,
       sc.fecha_cierre,
       comp.id AS comprobante_id,
       comp.tipo AS comprobante_tipo,
       comp.serie,
       comp.numero,
       comp.fecha_emision,
       comp.total AS comprobante_total,
       comp.estado AS comprobante_estado,
       comp.sunat_estado,
       comp.sunat_codigo,
       comp.sunat_mensaje,
       comp.sunat_enviado_at,
       comp.sunat_aceptado_at,
       se.intentos AS sunat_intentos,
       se.max_intentos AS sunat_max_intentos
     ${baseFrom()}
     WHERE ${where}
     ORDER BY p.fecha_pago DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );

  const total = Number(countRows?.[0]?.total || 0);
  return {
    page,
    limit,
    total,
    pages: Math.max(1, Math.ceil(total / limit)),
    rows: (rows || []).map((row) => ({
      ...row,
      monto: money(row.monto),
      comprobante_total: row.comprobante_total === null || row.comprobante_total === undefined ? null : money(row.comprobante_total),
    })),
  };
}

async function summary(query) {
  const { where, params } = buildFilters(query);

  const [paymentTotalsRows] = await db.query(
    `SELECT COUNT(*) AS cantidad_pagos, COALESCE(SUM(p.monto), 0) AS total_pagos
     ${baseFrom()}
     WHERE ${where}`,
    params
  );

  const [comprobanteRows] = await db.query(
    `SELECT DISTINCT comp.id, comp.total
     ${baseFrom()}
     WHERE ${where} AND comp.id IS NOT NULL`,
    params
  );

  const [metodos] = await db.query(
    `SELECT mp.id, mp.nombre, COUNT(p.id) AS cantidad, COALESCE(SUM(p.monto), 0) AS total
     ${baseFrom()}
     WHERE ${where}
     GROUP BY mp.id, mp.nombre
     ORDER BY total DESC`,
    params
  );

  const [tipos] = await db.query(
    `SELECT grouped.tipo, COUNT(*) AS cantidad, COALESCE(SUM(grouped.total), 0) AS total
     FROM (
       SELECT DISTINCT comp.id, comp.tipo, comp.total
       ${baseFrom()}
       WHERE ${where} AND comp.id IS NOT NULL
     ) grouped
     GROUP BY grouped.tipo
     ORDER BY total DESC`,
    params
  );

  const totals = paymentTotalsRows?.[0] || {};
  const totalComprobantes = (comprobanteRows || []).reduce((acc, row) => acc + Number(row.total || 0), 0);
  return {
    cantidad_pagos: Number(totals.cantidad_pagos || 0),
    total_pagos: money(totals.total_pagos),
    cantidad_comprobantes: (comprobanteRows || []).length,
    total_comprobantes: money(totalComprobantes),
    metodos: (metodos || []).map((row) => ({ ...row, cantidad: Number(row.cantidad || 0), total: money(row.total) })),
    tipos: (tipos || []).map((row) => ({ ...row, cantidad: Number(row.cantidad || 0), total: money(row.total) })),
  };
}

async function filters({ sucursal_id, fecha }) {
  const day = normalizeDate(fecha);

  const [usuarios] = await db.query(
    `SELECT DISTINCT
       u.id,
       u.usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS nombre
     FROM pagos p
     JOIN pedidos ped ON ped.id = p.pedido_id
     JOIN usuarios u ON u.id = p.usuario_id
     WHERE ped.sucursal_id = ? AND DATE(p.fecha_pago) = ?
     ORDER BY nombre`,
    [sucursal_id, day]
  );

  const [sesiones] = await db.query(
    `SELECT
       sc.id,
       sc.estado,
       sc.fecha_apertura,
       sc.fecha_cierre,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_apertura_nombre
     FROM sesiones_caja sc
     LEFT JOIN usuarios u ON u.id = sc.usuario_apertura
     WHERE sc.sucursal_id = ? AND DATE(sc.fecha_apertura) = ?
     ORDER BY sc.fecha_apertura DESC`,
    [sucursal_id, day]
  );

  const [metodos] = await db.query('SELECT id, nombre FROM metodos_pago WHERE activo = 1 ORDER BY nombre');

  return {
    usuarios: usuarios || [],
    sesiones: sesiones || [],
    metodos: metodos || [],
    tipos: ['NOTA_PEDIDO', 'BOLETA', 'FACTURA', 'NOTA_CREDITO'],
    sunat_estados: ['NO_APLICA', 'PENDIENTE', 'ENVIANDO', 'ACEPTADO', 'RECHAZADO', 'ERROR'],
  };
}

async function getHistorial(query) {
  if (!query.sucursal_id) {
    const err = new Error('sucursal_id is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const [listResult, summaryResult, filterResult] = await Promise.all([
    list(query),
    summary(query),
    filters(query),
  ]);

  return {
    fecha: normalizeDate(query.fecha),
    ...listResult,
    summary: summaryResult,
    filters: filterResult,
  };
}

module.exports = { getHistorial };
