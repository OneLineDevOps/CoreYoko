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

function orderDateParts(value) {
  const date = value ? new Date(value) : new Date();
  const validDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return {
    date: new Intl.DateTimeFormat('es-PE', {
      timeZone: 'America/Lima',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(validDate),
    time: new Intl.DateTimeFormat('es-PE', {
      timeZone: 'America/Lima',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(validDate),
  };
}

function bigText(text) {
  return `[[YOKO_BIG_ON]]${text}[[YOKO_NORMAL]]`;
}

function heroText(text) {
  return `[[YOKO_HERO_ON]]${text}[[YOKO_NORMAL]]`;
}

function detailText(text) {
  return `[[YOKO_DETAIL_ON]]${text}[[YOKO_NORMAL]]`;
}

function identificationTicket(printer, branch) {
  const now = new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
  return [
    center('YOKO', 42),
    center('IDENTIFICACION IMPRESORA', 42),
    '-'.repeat(42),
    `Nombre: ${printer.nombre || 'Impresora'}`,
    bigText(`IP: ${printer.ip}`),
    bigText(`Puerto: ${printer.puerto || 9100}`),
    `Protocolo: ${printer.protocolo || 'RAW9100'}`,
    `Estado: ${printer.estado || '-'}`,
    printer.ultimo_error ? `Error: ${printer.ultimo_error}` : '',
    '-'.repeat(42),
    `Sucursal: ${branch?.nombre || branch?.codigo || printer.sucursal_id}`,
    branch?.codigo ? `Codigo: ${branch.codigo}` : '',
    `Agente: ${printer.agente_nombre || printer.agente_id || 'Sin agente'}`,
    `Origen: ${printer.origen || '-'}`,
    `Fecha: ${now}`,
    '-'.repeat(42),
    'Use esta hoja para identificar y etiquetar',
    'la impresora fisica en cocina/caja.',
    '',
    '',
    '',
  ].filter((row) => row !== '').join('\n');
}

function formatOrderTicket(order, details, title, purpose) {
  const width = 42;
  const line = '-'.repeat(width);
  const issuedAt = orderDateParts(order.fecha_pedido || order.fecha_creacion || order.created_at);
  const rows = [
    center('YOKO', width),
    center(title, width),
    heroText(center(issuedAt.time, width)),
    line,
    `Pedido: ${order.numero || order.id}`,
    `Fecha: ${issuedAt.date}`,
    `Mesa: ${order.mesa_nombre || order.mesa_temporal_codigo || order.mesa_id || 'Sin mesa'}`,
    `Tipo: ${order.tipo_pedido || 'MESA'}`,
    order.usuario_creacion_nombre ? `Mesero: ${order.usuario_creacion_nombre}` : '',
    `Destino: ${purpose}`,
    line,
  ].filter(Boolean);
  for (const detail of details || []) {
    rows.push(detailText(`${Number(detail.cantidad || 1)}x ${detail.producto_nombre || detail.descripcion || 'Producto'}`));
    for (const modifier of detail.modificadores || []) {
      rows.push(detailText(`  + ${Number(modifier.cantidad || 1)}x ${modifier.opcion_nombre || 'Modificador'}`));
    }
    if (detail.observacion) rows.push(detailText(`  Obs: ${detail.observacion}`));
    rows.push('');
  }
  rows.push(line, '', '', '');
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
    receipt.referencia_serie
      ? `Comprobante afectado: ${receipt.referencia_serie}-${receipt.referencia_numero}`
      : '',
    receipt.motivo_descripcion ? `Motivo: ${receipt.motivo_descripcion}` : '',
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
    `IGV incluido (${Number(receipt.igv_porcentaje || 18)}%): S/ ${Number(receipt.igv || 0).toFixed(2)}`,
    `TOTAL: S/ ${Number(receipt.total || 0).toFixed(2)}`,
    line,
    ...presentation.closingLines.map((message) => centerLine(message, width)),
    '',
    '',
    ''
  );
  return rows.join('\n');
}

function formatPrecuentaTicket(order) {
  const width = TICKET_WIDTH;
  const line = '-'.repeat(width);
  const rows = [
    centerLine('YOKO', width),
    centerLine('PRECUENTA', width),
    centerLine('NO ES COMPROBANTE DE PAGO', width),
    line,
    `Pedido: ${order.numero || order.id}`,
    `Mesa: ${order.mesa_nombre || order.mesa_temporal_codigo || order.mesa_id || 'Sin mesa'}`,
    order.usuario_creacion_nombre ? `Mesero: ${order.usuario_creacion_nombre}` : '',
    line,
  ].filter(Boolean);
  for (const detail of order.detalles || []) {
    const quantity = Number(detail.cantidad || 1);
    const unitPrice = Number(detail.precio_unitario || 0);
    rows.push(`${quantity}x ${detail.producto_nombre || detail.descripcion || 'Producto'}`);
    rows.push(`  ${quantity} x S/ ${unitPrice.toFixed(2)}`);
    for (const modifier of detail.modificadores || []) {
      rows.push(
        `  + ${Number(modifier.cantidad || 1)}x ${modifier.opcion_nombre || 'Modificador'}`
        + ` S/ ${Number(modifier.precio || 0).toFixed(2)}`
      );
    }
    if (detail.observacion) rows.push(`  Obs: ${detail.observacion}`);
    rows.push(`  Subtotal: S/ ${Number(detail.subtotal || 0).toFixed(2)}`, '');
  }
  rows.push(
    line,
    `TOTAL: S/ ${Number(order.total || 0).toFixed(2)}`,
    line,
    centerLine('Documento informativo', width),
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
    `SELECT pe.producto_id, UPPER(TRIM(ec.nombre)) AS estacion
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

  const groups = new Map();
  for (const detail of order.detalles || []) {
    const stations = stationByProduct.get(Number(detail.producto_id)) || [];
    const destinations = stations.length ? stations : ['COCINA'];
    for (const station of destinations) {
      if (!groups.has(station)) groups.set(station, []);
      groups.get(station).push(detail);
    }
  }

  const stamp = eventName === 'NUEVO' ? 'NUEVO' : `ACT-${Date.now()}`;
  const jobs = [];
  for (const [station, stationDetails] of groups.entries()) {
    jobs.push(...await enqueueForPurpose({
      sucursalId: order.sucursal_id,
      purpose: station,
      type: `PEDIDO_${eventName}`,
      referenceType: 'PEDIDO',
      referenceId: order.id,
      idempotencyKey: `PEDIDO:${order.id}:${stamp}:${station}`,
      content: formatOrderTicket(
        order,
        stationDetails,
        eventName === 'NUEVO' ? 'NUEVO PEDIDO' : (eventName === 'AGREGADO' ? 'ITEMS AGREGADOS' : 'PEDIDO ACTUALIZADO'),
        station
      ),
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

async function enqueuePrecuenta(order) {
  if (!order?.id || !order?.sucursal_id) return [];
  return enqueueForPurpose({
    sucursalId: order.sucursal_id,
    purpose: 'CAJA',
    type: 'PRECUENTA',
    referenceType: 'PEDIDO',
    referenceId: order.id,
    idempotencyKey: `PRECUENTA:${order.id}:${Date.now()}`,
    content: formatPrecuentaTicket(order),
  });
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

async function enqueuePrinterIdentification(printer, branch) {
  if (!printer?.id || !printer?.sucursal_id) return null;
  const idempotencyKey = `IDENTIFICACION_IP:${printer.id}:${Date.now()}`;
  const [result] = await db.pool.execute(
    `INSERT INTO trabajos_impresion
     (sucursal_id, impresora_id, proposito, tipo, referencia_tipo, referencia_id,
      clave_idempotencia, contenido, estado)
     VALUES (?, ?, 'DIAGNOSTICO', 'IDENTIFICACION_IP', 'IMPRESORA', ?, ?, ?, 'PENDIENTE')`,
    [
      printer.sucursal_id,
      printer.id,
      printer.id,
      idempotencyKey,
      identificationTicket(printer, branch),
    ]
  );
  const branchRow = branch || await impresoraService.branchById(printer.sucursal_id);
  ws.broadcastToSucursal(branchRow?.codigo, {
    type: 'trabajo_impresion',
    data: { ids: [result.insertId], proposito: 'DIAGNOSTICO' },
  });
  return { id: result.insertId, estado: 'PENDIENTE' };
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
     WHERE t.sucursal_id = ?
       AND t.fecha_creacion >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ${filter}
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
         AND t.estado = 'PENDIENTE'
         AND t.intentos < t.max_intentos
         AND t.fecha_creacion >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
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
     WHERE t.id = ?
       AND i.agente_id = ?
       AND t.estado = 'ENVIADO'`,
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
    const [rows] = await db.query(
      `SELECT t.estado
       FROM trabajos_impresion t
       JOIN impresoras i ON i.id = t.impresora_id
       WHERE t.id = ? AND i.agente_id = ?
       LIMIT 1`,
      [id, agenteId]
    );
    if (rows?.[0]?.estado === 'CANCELADO') {
      return { id: Number(id), estado: 'CANCELADO', ignored: true };
    }
    const error = new Error('Trabajo no encontrado para este agente');
    error.code = 'NOT_FOUND';
    throw error;
  }
  return { id: Number(id), estado: status };
}

async function retry(id) {
  const [result] = await db.pool.execute(
    `UPDATE trabajos_impresion
     SET estado = 'PENDIENTE',
         error_mensaje = NULL,
         intentos = 0,
         max_intentos = GREATEST(max_intentos, 1)
     WHERE id = ?
       AND estado IN ('ERROR','CANCELADO')`,
    [id]
  );
  return result.affectedRows ? { id: Number(id), estado: 'PENDIENTE' } : null;
}

async function cancel(id, reason = 'Cancelado manualmente') {
  const [result] = await db.pool.execute(
    `UPDATE trabajos_impresion
     SET estado = 'CANCELADO',
         error_mensaje = ?,
         max_intentos = intentos
     WHERE id = ?
       AND estado IN ('PENDIENTE','ENVIADO','ERROR')`,
    [reason, id]
  );
  return result.affectedRows ? { id: Number(id), estado: 'CANCELADO' } : null;
}

async function reprint(id) {
  const [rows] = await db.query(
    `SELECT *
     FROM trabajos_impresion
     WHERE id = ?
       AND estado IN ('IMPRESO','ERROR','CANCELADO')
       AND fecha_creacion >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
     LIMIT 1`,
    [id]
  );
  const source = rows?.[0];
  if (!source) return null;
  const [result] = await db.pool.execute(
    `INSERT INTO trabajos_impresion
     (sucursal_id, impresora_id, proposito, tipo, referencia_tipo, referencia_id,
      clave_idempotencia, contenido, estado, max_intentos)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDIENTE', 1)`,
    [
      source.sucursal_id,
      source.impresora_id,
      source.proposito,
      String(source.tipo || 'TICKET').includes('REIMPRESION')
        ? source.tipo
        : `${String(source.tipo || 'TICKET').slice(0, 37)}_REIMPRESION`,
      source.referencia_tipo,
      source.referencia_id,
      `REIMPRESION:${source.id}:${Date.now()}`,
      source.contenido,
    ]
  );
  const branch = await impresoraService.branchById(source.sucursal_id);
  ws.broadcastToSucursal(branch?.codigo, {
    type: 'trabajo_impresion',
    data: { ids: [result.insertId], proposito: source.proposito },
  });
  return { id: result.insertId, estado: 'PENDIENTE' };
}

module.exports = {
  formatOrderTicket,
  formatReceiptTicket,
  formatPrecuentaTicket,
  enqueueForPurpose,
  enqueueOrder,
  enqueueReceipt,
  enqueuePrecuenta,
  enqueuePrinterIdentification,
  list,
  claim,
  updateStatus,
  retry,
  cancel,
  reprint,
};
