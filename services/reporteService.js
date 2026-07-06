'use strict';

const db = require('../models/db');

function normalizeDate(value, fallback) {
  const candidate = String(value || fallback);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(candidate)
    || Number.isNaN(Date.parse(`${candidate}T00:00:00Z`))
  ) {
    const error = new Error('Las fechas deben tener el formato AAAA-MM-DD');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return candidate;
}

function normalizeRange({ fecha_desde, fecha_hasta }) {
  const today = new Date().toISOString().slice(0, 10);
  const from = normalizeDate(fecha_desde, today);
  const to = normalizeDate(fecha_hasta, from);
  if (from > to) {
    const error = new Error('La fecha inicial no puede ser posterior a la fecha final');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  return { from, to };
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function getConsumoInsumos({ sucursal_id, fecha_desde, fecha_hasta }) {
  const { from, to } = normalizeRange({ fecha_desde, fecha_hasta });
  const [rows] = await db.query(
    `SELECT
       i.id AS ingrediente_id,
       i.nombre AS ingrediente,
       i.unidad_base,
       SUM(pd.cantidad * pr.cantidad) AS cantidad_base,
       SUM(pd.cantidad) AS porciones_asociadas,
       COUNT(DISTINCT pd.pedido_id) AS pedidos,
       COUNT(DISTINCT pr.producto_id) AS productos
     FROM pedidos p
     JOIN pedido_detalles pd ON pd.pedido_id = p.id
     JOIN producto_recetas pr ON pr.producto_id = pd.producto_id
     JOIN ingredientes i ON i.id = pr.ingrediente_id AND i.activo = 1
     WHERE p.sucursal_id = ?
       AND p.estado = 'ENTREGADO'
       AND DATE(p.fecha_pedido) BETWEEN ? AND ?
     GROUP BY i.id, i.nombre, i.unidad_base
     ORDER BY i.nombre, i.id`,
    [sucursal_id, from, to]
  );

  const [breakdown] = await db.query(
    `SELECT
       i.id AS ingrediente_id,
       prod.id AS producto_id,
       prod.nombre AS producto,
       SUM(pd.cantidad) AS platos,
       SUM(pd.cantidad * pr.cantidad) AS cantidad_base
     FROM pedidos p
     JOIN pedido_detalles pd ON pd.pedido_id = p.id
     JOIN productos prod ON prod.id = pd.producto_id
     JOIN producto_recetas pr ON pr.producto_id = pd.producto_id
     JOIN ingredientes i ON i.id = pr.ingrediente_id AND i.activo = 1
     WHERE p.sucursal_id = ?
       AND p.estado = 'ENTREGADO'
       AND DATE(p.fecha_pedido) BETWEEN ? AND ?
     GROUP BY i.id, prod.id, prod.nombre
     ORDER BY i.id, cantidad_base DESC, prod.nombre`,
    [sucursal_id, from, to]
  );
  const breakdownByIngredient = new Map();
  for (const item of breakdown || []) {
    const key = Number(item.ingrediente_id);
    if (!breakdownByIngredient.has(key)) breakdownByIngredient.set(key, []);
    breakdownByIngredient.get(key).push({
      producto_id: Number(item.producto_id),
      producto: item.producto,
      platos: Number(item.platos),
      cantidad_base: Number(item.cantidad_base),
    });
  }

  return {
    fecha_desde: from,
    fecha_hasta: to,
    criterio: 'PEDIDOS_ENTREGADOS',
    rows: (rows || []).map((row) => ({
      ...row,
      ingrediente_id: Number(row.ingrediente_id),
      cantidad_base: Number(row.cantidad_base),
      porciones_asociadas: Number(row.porciones_asociadas),
      pedidos: Number(row.pedidos),
      productos: Number(row.productos),
      detalle_productos: breakdownByIngredient.get(Number(row.ingrediente_id)) || [],
    })),
  };
}

async function getRankingPlatos({ sucursal_id, fecha_desde, fecha_hasta }) {
  const { from, to } = normalizeRange({ fecha_desde, fecha_hasta });
  const [rows] = await db.query(
    `SELECT
       prod.id AS producto_id,
       prod.nombre AS producto,
       cat.nombre AS categoria,
       SUM(pd.cantidad) AS cantidad_vendida,
       COUNT(DISTINCT p.id) AS pedidos,
       SUM(pd.subtotal) AS ingreso_generado
     FROM pedidos p
     JOIN pedido_detalles pd ON pd.pedido_id = p.id
     JOIN productos prod ON prod.id = pd.producto_id
     JOIN categorias cat ON cat.id = prod.categoria_id
     WHERE p.sucursal_id = ?
       AND p.estado = 'ENTREGADO'
       AND DATE(p.fecha_pedido) BETWEEN ? AND ?
     GROUP BY prod.id, prod.nombre, cat.nombre
     ORDER BY cantidad_vendida DESC, ingreso_generado DESC, prod.nombre
     LIMIT 100`,
    [sucursal_id, from, to]
  );
  const normalizedRows = (rows || []).map((row, index) => ({
    ...row,
    posicion: index + 1,
    producto_id: Number(row.producto_id),
    cantidad_vendida: Number(row.cantidad_vendida),
    pedidos: Number(row.pedidos),
    ingreso_generado: money(row.ingreso_generado),
  }));
  return {
    fecha_desde: from,
    fecha_hasta: to,
    rows: normalizedRows,
    summary: {
      platos_distintos: normalizedRows.length,
      unidades_vendidas: normalizedRows.reduce((sum, row) => sum + row.cantidad_vendida, 0),
      ingreso_generado: money(normalizedRows.reduce((sum, row) => sum + row.ingreso_generado, 0)),
    },
  };
}

async function getComprobantesSunat({ sucursal_id, fecha_desde, fecha_hasta }) {
  const { from, to } = normalizeRange({ fecha_desde, fecha_hasta });
  const baseFrom = `
    FROM comprobantes comp
    LEFT JOIN cuentas cu ON cu.id = comp.cuenta_id
    LEFT JOIN pedidos ped ON ped.id = cu.pedido_id
    LEFT JOIN clientes cli ON cli.id = comp.cliente_id
    LEFT JOIN comprobantes ref ON ref.id = comp.comprobante_referencia_id
    WHERE COALESCE(comp.sucursal_id, ped.sucursal_id) = ?
      AND comp.tipo IN ('BOLETA', 'FACTURA', 'NOTA_CREDITO')
      AND DATE(comp.fecha_emision) BETWEEN ? AND ?
  `;
  const params = [sucursal_id, from, to];
  const [rows] = await db.query(
    `SELECT
       comp.id, comp.tipo, comp.serie, comp.numero, comp.fecha_emision,
       comp.subtotal, comp.igv, comp.total, comp.estado,
       comp.sunat_estado, comp.sunat_codigo, comp.sunat_mensaje,
       comp.sunat_enviado_at, comp.sunat_aceptado_at,
       comp.origen, comp.motivo_descripcion,
       cli.tipo_documento, cli.numero_documento,
       COALESCE(
         cli.razon_social,
         NULLIF(TRIM(CONCAT(COALESCE(cli.nombres, ''), ' ', COALESCE(cli.apellidos, ''))), '')
       ) AS cliente,
       ref.tipo AS referencia_tipo, ref.serie AS referencia_serie, ref.numero AS referencia_numero
     ${baseFrom}
     ORDER BY comp.fecha_emision DESC, comp.id DESC
     LIMIT 1000`,
    params
  );
  const [countRows] = await db.query(`SELECT COUNT(*) AS total ${baseFrom}`, params);
  const normalizedRows = (rows || []).map((row) => ({
    ...row,
    id: Number(row.id),
    numero: Number(row.numero),
    subtotal: money(row.subtotal),
    igv: money(row.igv),
    total: money(row.total),
    documento: `${row.serie}-${String(row.numero).padStart(8, '0')}`,
  }));
  const typeMap = new Map();
  const statusMap = new Map();
  let netSubtotal = 0;
  let netIgv = 0;
  let netTotal = 0;
  for (const row of normalizedRows) {
    const sign = row.tipo === 'NOTA_CREDITO' ? -1 : 1;
    netSubtotal += sign * row.subtotal;
    netIgv += sign * row.igv;
    netTotal += sign * row.total;
    const type = typeMap.get(row.tipo) || { tipo: row.tipo, cantidad: 0, total: 0 };
    type.cantidad += 1;
    type.total += sign * row.total;
    typeMap.set(row.tipo, type);
    const statusName = row.sunat_estado || 'NO_APLICA';
    const status = statusMap.get(statusName) || { estado: statusName, cantidad: 0 };
    status.cantidad += 1;
    statusMap.set(statusName, status);
  }
  const totalFound = Number(countRows?.[0]?.total || 0);
  return {
    fecha_desde: from,
    fecha_hasta: to,
    rows: normalizedRows,
    truncated: totalFound > normalizedRows.length,
    summary: {
      cantidad: totalFound,
      subtotal_neto: money(netSubtotal),
      igv_neto: money(netIgv),
      total_neto: money(netTotal),
      tipos: [...typeMap.values()].map((item) => ({ ...item, total: money(item.total) })),
      estados: [...statusMap.values()],
    },
  };
}

async function getVentasPorMetodoPago({ sucursal_id, fecha_desde, fecha_hasta }) {
  const { from, to } = normalizeRange({ fecha_desde, fecha_hasta });
  const [rows] = await db.query(
    `SELECT
       mp.id AS metodo_id,
       mp.nombre AS metodo,
       COUNT(pg.id) AS operaciones,
       SUM(pg.monto) AS total
     FROM pagos pg
     JOIN metodos_pago mp ON mp.id = pg.metodo_pago_id
     LEFT JOIN comprobantes comp ON comp.id = pg.comprobante_id
     LEFT JOIN pedidos ped ON ped.id = pg.pedido_id
     WHERE COALESCE(comp.sucursal_id, ped.sucursal_id) = ?
       AND pg.estado = 'ACTIVO'
       AND DATE(pg.fecha_pago) BETWEEN ? AND ?
     GROUP BY mp.id, mp.nombre
     ORDER BY total DESC, mp.nombre`,
    [sucursal_id, from, to]
  );
  const total = money((rows || []).reduce((sum, row) => sum + Number(row.total || 0), 0));
  return {
    fecha_desde: from,
    fecha_hasta: to,
    rows: (rows || []).map((row) => ({
      metodo_id: Number(row.metodo_id),
      metodo: row.metodo,
      operaciones: Number(row.operaciones),
      total: money(row.total),
      porcentaje: total > 0 ? Number(((Number(row.total) / total) * 100).toFixed(2)) : 0,
    })),
    summary: {
      total,
      operaciones: (rows || []).reduce((sum, row) => sum + Number(row.operaciones || 0), 0),
      metodos: (rows || []).length,
    },
  };
}

module.exports = {
  getConsumoInsumos,
  getRankingPlatos,
  getComprobantesSunat,
  getVentasPorMetodoPago,
};
