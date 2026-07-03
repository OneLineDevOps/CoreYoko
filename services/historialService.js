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
  const filters = [
    'COALESCE(comp.sucursal_id, ped.sucursal_id) = ?',
    'DATE(comp.fecha_emision) = ?',
  ];
  const params = [query.sucursal_id, normalizeDate(query.fecha)];
  if (query.usuario_id) {
    filters.push('COALESCE(comp.usuario_id, pg.usuario_id) = ?');
    params.push(query.usuario_id);
  }
  if (query.sesion_caja_id) {
    filters.push('COALESCE(comp.sesion_caja_id, pg.sesion_caja_id) = ?');
    params.push(query.sesion_caja_id);
  }
  if (query.metodo_pago_id) {
    filters.push('COALESCE(comp.metodo_pago_id, pg.metodo_pago_id) = ?');
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
    FROM comprobantes comp
    LEFT JOIN cuentas cu ON cu.id = comp.cuenta_id
    LEFT JOIN pedidos ped ON ped.id = cu.pedido_id
    LEFT JOIN pagos pg ON pg.id = (
      SELECT pg2.id
      FROM pagos pg2
      WHERE pg2.comprobante_id = comp.id
         OR (
           pg2.comprobante_id IS NULL
           AND pg2.pedido_id = ped.id
           AND (comp.metodo_pago_id = pg2.metodo_pago_id OR comp.metodo_pago_id IS NULL)
           AND ABS(comp.total - pg2.monto) < 0.01
         )
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, pg2.fecha_pago, comp.fecha_emision)), pg2.id DESC
      LIMIT 1
    )
    LEFT JOIN metodos_pago mp ON mp.id = COALESCE(comp.metodo_pago_id, pg.metodo_pago_id)
    LEFT JOIN sesiones_caja sc ON sc.id = COALESCE(comp.sesion_caja_id, pg.sesion_caja_id)
    LEFT JOIN usuarios u ON u.id = COALESCE(comp.usuario_id, pg.usuario_id)
    LEFT JOIN mesas m ON m.id = ped.mesa_id
    LEFT JOIN clientes cli ON cli.id = comp.cliente_id
    LEFT JOIN sunat_envios se ON se.comprobante_id = comp.id
    LEFT JOIN comprobantes ref ON ref.id = comp.comprobante_referencia_id
    LEFT JOIN comprobantes nc ON nc.id = (
      SELECT nc2.id FROM comprobantes nc2
      WHERE nc2.comprobante_referencia_id = comp.id
        AND nc2.tipo = 'NOTA_CREDITO'
      ORDER BY nc2.id DESC LIMIT 1
    )
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
       pg.id AS pago_id, pg.fecha_pago, pg.monto,
       COALESCE(comp.sesion_caja_id, pg.sesion_caja_id) AS sesion_caja_id,
       COALESCE(comp.usuario_id, pg.usuario_id) AS usuario_id,
       COALESCE(comp.metodo_pago_id, pg.metodo_pago_id) AS metodo_pago_id,
       mp.nombre AS metodo_pago,
       ped.id AS pedido_id, ped.numero AS pedido_numero,
       COALESCE(m.codigo, ped.mesa_temporal_codigo) AS mesa_codigo,
       COALESCE(cli.razon_social, TRIM(CONCAT(COALESCE(cli.nombres, ''), ' ', COALESCE(cli.apellidos, '')))) AS cliente_nombre,
       u.usuario AS usuario_usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS usuario_nombre,
       sc.estado AS caja_estado,
       comp.id AS comprobante_id, comp.tipo AS comprobante_tipo, comp.serie, comp.numero,
       comp.fecha_emision, comp.total AS comprobante_total, comp.estado AS comprobante_estado,
       comp.origen, comp.sunat_estado, comp.sunat_codigo, comp.sunat_mensaje,
       comp.sunat_enviado_at, comp.sunat_aceptado_at,
       comp.comprobante_referencia_id, comp.motivo_codigo, comp.motivo_descripcion,
       ref.tipo AS referencia_tipo, ref.serie AS referencia_serie, ref.numero AS referencia_numero,
       nc.id AS nota_credito_id, nc.serie AS nota_credito_serie,
       nc.numero AS nota_credito_numero, nc.sunat_estado AS nota_credito_sunat_estado,
       se.intentos AS sunat_intentos, se.max_intentos AS sunat_max_intentos
     ${baseFrom()}
     WHERE ${where}
     ORDER BY comp.fecha_emision DESC, comp.id DESC
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
      monto: row.monto === null ? null : money(row.monto),
      comprobante_total: money(row.comprobante_total),
    })),
  };
}

async function summary(query) {
  const { where, params } = buildFilters(query);
  const [documents] = await db.query(
    `SELECT comp.id, comp.tipo, comp.total, pg.id AS pago_id, pg.monto,
            mp.id AS metodo_id, mp.nombre AS metodo_nombre
     ${baseFrom()} WHERE ${where}`,
    params
  );
  const paymentMap = new Map();
  const methodMap = new Map();
  const typeMap = new Map();
  let totalComprobantes = 0;
  for (const row of documents || []) {
    const sign = row.tipo === 'NOTA_CREDITO' ? -1 : 1;
    totalComprobantes += sign * Number(row.total || 0);
    const type = typeMap.get(row.tipo) || { tipo: row.tipo, cantidad: 0, total: 0 };
    type.cantidad += 1;
    type.total += sign * Number(row.total || 0);
    typeMap.set(row.tipo, type);
    if (row.pago_id && !paymentMap.has(row.pago_id)) {
      paymentMap.set(row.pago_id, Number(row.monto || 0));
      const method = methodMap.get(row.metodo_id) || {
        id: row.metodo_id,
        nombre: row.metodo_nombre,
        cantidad: 0,
        total: 0,
      };
      method.cantidad += 1;
      method.total += Number(row.monto || 0);
      methodMap.set(row.metodo_id, method);
    }
  }
  return {
    cantidad_pagos: paymentMap.size,
    total_pagos: money([...paymentMap.values()].reduce((sum, value) => sum + value, 0)),
    cantidad_comprobantes: (documents || []).length,
    total_comprobantes: money(totalComprobantes),
    metodos: [...methodMap.values()].map((row) => ({ ...row, total: money(row.total) })),
    tipos: [...typeMap.values()].map((row) => ({ ...row, total: money(row.total) })),
  };
}

async function filters({ sucursal_id, fecha }) {
  const day = normalizeDate(fecha);
  const [usuarios] = await db.query(
    `SELECT DISTINCT u.id, u.usuario,
       COALESCE(NULLIF(TRIM(CONCAT(COALESCE(u.nombre, ''), ' ', COALESCE(u.apellido, ''))), ''), u.usuario) AS nombre
     ${baseFrom()}
     WHERE COALESCE(comp.sucursal_id, ped.sucursal_id) = ? AND DATE(comp.fecha_emision) = ?
       AND u.id IS NOT NULL
     ORDER BY nombre`,
    [sucursal_id, day]
  );
  const [sesiones] = await db.query(
    `SELECT sc.id, sc.estado, sc.fecha_apertura, sc.fecha_cierre,
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
