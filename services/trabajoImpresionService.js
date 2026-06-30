'use strict';

const db = require('../models/db');
const ws = require('../utils/ws');
const {
  TICKET_WIDTH,
  centerLine,
  centerWrapped,
  receiptPresentation,
} = require('../utils/receiptPresentation');
const impresoraService = require('./impresoraService');

function center(text, width = 42) {
  const value = String(text || '').slice(0, width);
  return `${' '.repeat(Math.max(0, Math.floor((width - value.length) / 2)))}${value}`;
}

function formatOrderTicket(order, details, title, purpose) {
  const width = 42;
  const line = '-'.repeat(width);
  const rows = [
    center('YOKO', width),
    center(title, width),
    line,
    `Pedido: ${order.numero || order.id}`,
    `Mesa: ${order.mesa_nombre || order.mesa_temporal_codigo || order.mesa_id || 'Sin mesa'}`,
    `Tipo: ${order.tipo_pedido || 'MESA'}`,
    order.usuario_creacion_nombre ? `Mesero: ${order.usuario_creacion_nombre}` : '',
    `Destino: ${purpose}`,
    line,
  ].filter(Boolean);
  for (const detail of details || []) {
    rows.push(`${Number(detail.cantidad || 1)}x ${detail.producto_nombre || detail.descripcion || 'Producto'}`);
    for (const modifier of detail.modificadores || []) {
      rows.push(`  + ${Number(modifier.cantidad || 1)}x ${modifier.opcion_nombre || 'Modificador'}`);
    }
    if (detail.observacion) rows.push(`  Obs: ${detail.observacion}`);
    rows.push('');
  }
  rows.push(line, center('SIN IMPORTES', width), '', '', '');
  return rows.join('\n');
}

function formatReceiptTicket(receipt) {
  const width = TICKET_WIDTH;
  const line = '-'.repeat(width);
  const presentation = receiptPresentation(receipt);
  const rows = [
    ...centerWrapped(presentation.restaurantName.toUpperCase(), width),
    presentation.restaurantRuc ? centerLine(`RUC: ${presentation.restaurantRuc}`, width) : '',
    presentation.branchName ? centerLine(`Sucursal: ${presentation.branchName}`, width) : '',
    ...centerWrapped(presentation.address, width),
    presentation.phone ? centerLine(`Telefono: ${presentation.phone}`, width) : '',
    line,
    centerLine(presentation.typeLabel, width),
    centerLine(presentation.number, width),
    line,
    presentation.dateTime ? `Fecha: ${presentation.dateTime}` : '',
    receipt.sesion_caja_id ? `Caja: #${receipt.sesion_caja_id}` : '',
    receipt.pedido_numero ? `Pedido: ${receipt.pedido_numero}` : '',
    receipt.mesa_codigo ? `Mesa: ${receipt.mesa_codigo}` : '',
    line,
    `Cliente: ${presentation.customer}`,
    receipt.numero_documento ? `Documento: ${receipt.numero_documento}` : '',
    line,
  ].filter(Boolean);
  for (const detail of receipt.detalles || []) {
    rows.push(`${Number(detail.cantidad || 1)}x ${detail.descripcion || 'Producto'}`);
    rows.push(
      `  ${Number(detail.cantidad || 1)} x S/ ${Number(detail.precio_unitario || 0).toFixed(2)}`,
      `  Subtotal: S/ ${Number(detail.subtotal || 0).toFixed(2)}`
    );
  }
  rows.push(
    line,
    `Op. gravada: S/ ${Number(receipt.subtotal || 0).toFixed(2)}`,
    `IGV incluido: S/ ${Number(receipt.igv || 0).toFixed(2)}`,
    `TOTAL: S/ ${Number(receipt.total || 0).toFixed(2)}`,
    line,
    ...presentation.closingLines.map((message) => centerLine(message, width)),
    '',
    '',
    ''
  );
  return rows.join('\n');
}

async function enqueueForPurpose({
  sucursalId,
  purpose,
  type,
  referenceType,
  referenceId,
  idempotencyKey,
  content,
}) {
  await impresoraService.markStaleDetected(sucursalId);
  const [printers] = await db.query(
    `SELECT i.id
     FROM impresoras i
     JOIN impresora_propositos ip ON ip.impresora_id = i.id
     WHERE i.sucursal_id = ?
       AND i.activo = 1
       AND i.estado = 'ACTIVA'
       AND ip.activo = 1
       AND ip.proposito = ?`,
    [sucursalId, purpose]
  );
  const created = [];
  for (const printer of printers || []) {
    try {
      const [result] = await db.pool.execute(
        `INSERT INTO trabajos_impresion
         (sucursal_id, impresora_id, proposito, tipo, referencia_tipo, referencia_id,
          clave_idempotencia, contenido, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE')`,
        [
          sucursalId,
          printer.id,
          purpose,
          type,
          referenceType || null,
          referenceId || null,
          idempotencyKey,
          content,
        ]
      );
      created.push(result.insertId);
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
    }
  }
  if (created.length) {
    const branch = await impresoraService.branchById(sucursalId);
    ws.broadcastToSucursal(branch?.codigo, {
      type: 'trabajo_impresion',
      data: { ids: created, proposito: purpose },
    });
  }
  return created;
}

async function enqueueOrder(order, eventName = 'NUEVO') {
  if (!order?.id || !order?.sucursal_id) return [];
  const [stationRows] = await db.query(
    `SELECT pe.producto_id, UPPER(ec.nombre) AS estacion
     FROM producto_estaciones pe
     JOIN estaciones_cocina ec ON ec.id = pe.estacion_id AND ec.activo = 1
     WHERE pe.producto_id IN (?)`,
    [(order.detalles || []).map((detail) => detail.producto_id).filter(Boolean).length
      ? (order.detalles || []).map((detail) => detail.producto_id).filter(Boolean)
      : [0]]
  );
  const stationByProduct = new Map();
  for (const row of stationRows || []) {
    if (!stationByProduct.has(Number(row.producto_id))) stationByProduct.set(Number(row.producto_id), []);
    stationByProduct.get(Number(row.producto_id)).push(row.estacion);
  }

  const groups = { COCINA: [], BAR: [] };
  for (const detail of order.detalles || []) {
    const stations = stationByProduct.get(Number(detail.producto_id)) || [];
    if (stations.includes('BAR')) groups.BAR.push(detail);
    if (!stations.includes('BAR') || stations.some((station) => station !== 'BAR')) groups.COCINA.push(detail);
  }

  const stamp = eventName === 'NUEVO' ? 'NUEVO' : `ACT-${Date.now()}`;
  const jobs = [];
  if (groups.COCINA.length) {
    jobs.push(...await enqueueForPurpose({
      sucursalId: order.sucursal_id,
      purpose: 'COCINA',
      type: `PEDIDO_${eventName}`,
      referenceType: 'PEDIDO',
      referenceId: order.id,
      idempotencyKey: `PEDIDO:${order.id}:${stamp}:COCINA`,
      content: formatOrderTicket(order, groups.COCINA, eventName === 'NUEVO' ? 'NUEVO PEDIDO' : 'PEDIDO ACTUALIZADO', 'COCINA'),
    }));
  }
  if (groups.BAR.length) {
    jobs.push(...await enqueueForPurpose({
      sucursalId: order.sucursal_id,
      purpose: 'BAR',
      type: `PEDIDO_${eventName}`,
      referenceType: 'PEDIDO',
      referenceId: order.id,
      idempotencyKey: `PEDIDO:${order.id}:${stamp}:BAR`,
      content: formatOrderTicket(order, groups.BAR, eventName === 'NUEVO' ? 'NUEVO PEDIDO' : 'PEDIDO ACTUALIZADO', 'BAR'),
    }));
  }
  if (String(order.tipo_pedido).toUpperCase() === 'DELIVERY') {
    jobs.push(...await enqueueForPurpose({
      sucursalId: order.sucursal_id,
      purpose: 'DELIVERY',
      type: `PEDIDO_${eventName}`,
      referenceType: 'PEDIDO',
      referenceId: order.id,
      idempotencyKey: `PEDIDO:${order.id}:${stamp}:DELIVERY`,
      content: formatOrderTicket(order, order.detalles || [], 'PEDIDO DELIVERY', 'DELIVERY'),
    }));
  }
  return jobs;
}

async function enqueueReceipt(receipt, options = {}) {
  if (!receipt?.id || !receipt?.sucursal_id) return [];
  const idempotencyKey = options.idempotencyKey || `COMPROBANTE:${receipt.id}`;
  return enqueueForPurpose({
    sucursalId: receipt.sucursal_id,
    purpose: 'CAJA',
    type: receipt.tipo || 'COMPROBANTE',
    referenceType: 'COMPROBANTE',
    referenceId: receipt.id,
    idempotencyKey,
    content: formatReceiptTicket(receipt),
  });
}

async function list({ sucursalId, status, limit = 100 }) {
  const params = [sucursalId];
  let filter = '';
  if (status) {
    filter = 'AND t.estado = ?';
    params.push(status);
  }
  params.push(Math.min(500, Math.max(1, Number(limit || 100))));
  const [rows] = await db.query(
    `SELECT t.*, i.nombre AS impresora_nombre, i.ip, i.puerto
     FROM trabajos_impresion t
     JOIN impresoras i ON i.id = t.impresora_id
     WHERE t.sucursal_id = ? ${filter}
     ORDER BY t.id DESC
     LIMIT ?`,
    params
  );
  return rows || [];
}

async function claim({ sucursalCodigo, agenteId, limit = 10 }) {
  const branch = await impresoraService.branchByCode(sucursalCodigo);
  if (!branch) {
    const error = new Error('Sucursal no encontrada');
    error.code = 'NOT_FOUND';
    throw error;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE trabajos_impresion t
       JOIN impresoras i ON i.id = t.impresora_id
       SET t.estado = 'ERROR',
           t.error_mensaje = 'El agente no confirmó la impresión a tiempo'
       WHERE t.sucursal_id = ?
         AND i.agente_id = ?
         AND t.estado = 'ENVIADO'
         AND t.fecha_envio < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`,
      [branch.id, agenteId]
    );
    const [rows] = await conn.execute(
      `SELECT
         t.*, i.nombre AS impresora_nombre, i.ip, i.puerto, i.protocolo
       FROM trabajos_impresion t
       JOIN impresoras i ON i.id = t.impresora_id
       WHERE t.sucursal_id = ?
         AND i.agente_id = ?
         AND i.activo = 1
         AND t.estado IN ('PENDIENTE','ERROR')
         AND t.intentos < t.max_intentos
       ORDER BY t.id
       LIMIT ?
       FOR UPDATE`,
      [branch.id, agenteId, Math.min(50, Math.max(1, Number(limit || 10)))]
    );
    for (const row of rows || []) {
      await conn.execute(
        `UPDATE trabajos_impresion
         SET estado = 'ENVIADO', intentos = intentos + 1, fecha_envio = NOW(), error_mensaje = NULL
         WHERE id = ?`,
        [row.id]
      );
      row.estado = 'ENVIADO';
      row.intentos = Number(row.intentos || 0) + 1;
    }
    await conn.commit();
    return rows || [];
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function updateStatus({ id, agenteId, status, errorMessage }) {
  if (!['IMPRESO', 'ERROR'].includes(status)) {
    const error = new Error('Estado de trabajo inválido');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const printed = status === 'IMPRESO';
  const [result] = await db.pool.execute(
    `UPDATE trabajos_impresion t
     JOIN impresoras i ON i.id = t.impresora_id
     SET t.estado = ?,
         t.error_mensaje = ?,
         t.fecha_impresion = ${printed ? 'NOW()' : 't.fecha_impresion'},
         i.estado = ?,
         i.ultimo_error = ?,
         i.ultima_conexion = NOW()
     WHERE t.id = ? AND i.agente_id = ?`,
    [
      status,
      errorMessage || null,
      printed ? 'ACTIVA' : 'ERROR',
      printed ? null : (errorMessage || null),
      id,
      agenteId,
    ]
  );
  if (!result.affectedRows) {
    const error = new Error('Trabajo no encontrado para este agente');
    error.code = 'NOT_FOUND';
    throw error;
  }
  return { id: Number(id), estado: status };
}

async function retry(id) {
  const [result] = await db.pool.execute(
    `UPDATE trabajos_impresion
     SET estado = 'PENDIENTE', error_mensaje = NULL, intentos = 0
     WHERE id = ?`,
    [id]
  );
  return result.affectedRows ? { id: Number(id), estado: 'PENDIENTE' } : null;
}

module.exports = {
  formatOrderTicket,
  formatReceiptTicket,
  enqueueForPurpose,
  enqueueOrder,
  enqueueReceipt,
  list,
  claim,
  updateStatus,
  retry,
};
