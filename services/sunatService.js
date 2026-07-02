'use strict';

const { randomUUID } = require('crypto');
const db = require('../models/db');
const logger = require('../utils/logger');
const restaurantService = require('./restaurantService');

const DOCUMENT_TYPES = {
  FACTURA: '01',
  BOLETA: '03',
  NOTA_CREDITO: '07',
};

const ALICE_BASE_URL = String(process.env.ALICE_API_URL || 'https://alice.inubyte.com/api')
  .replace(/\/+$/, '');
const WORKER_INTERVAL_MS = Math.max(1000, Number(process.env.SUNAT_WORKER_INTERVAL_MS || 5000));
const RECONCILE_INTERVAL_MS = Math.max(60000, Number(process.env.SUNAT_RECONCILE_INTERVAL_MS || 300000));

let workerTimer = null;
let workerRunning = false;
let lastReconcileAt = 0;

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function fiscalType(tipo) {
  return DOCUMENT_TYPES[String(tipo || '').toUpperCase()] || null;
}

function clientDocumentType(client = {}) {
  const type = String(client.tipo_documento || '').trim().toUpperCase();
  if (type === 'RUC') return '6';
  if (type === 'DNI') return '1';
  if (['CE', 'CARNET_EXTRANJERIA', 'CARNET DE EXTRANJERIA'].includes(type)) return '4';
  if (type === 'PASAPORTE') return '7';
  return '0';
}

async function enqueueComprobante(comprobanteId, conn = db.pool) {
  const [rows] = await conn.execute(
    'SELECT id, tipo FROM comprobantes WHERE id = ? LIMIT 1',
    [comprobanteId]
  );
  const comprobante = rows?.[0];
  if (!comprobante || !fiscalType(comprobante.tipo)) return null;

  await conn.execute(
    `UPDATE comprobantes
     SET sunat_estado = 'PENDIENTE', sunat_codigo = NULL, sunat_mensaje = NULL
     WHERE id = ?`,
    [comprobanteId]
  );
  await conn.execute(
    `INSERT INTO sunat_envios (comprobante_id, estado, proximo_intento)
     VALUES (?, 'PENDIENTE', NOW())
     ON DUPLICATE KEY UPDATE
       estado = IF(estado = 'ACEPTADO', estado, 'PENDIENTE'),
       proximo_intento = IF(estado = 'ACEPTADO', proximo_intento, NOW()),
       bloqueado_hasta = NULL,
       lock_token = NULL`,
    [comprobanteId]
  );
  return { comprobante_id: Number(comprobanteId), estado: 'PENDIENTE' };
}

async function reconcilePending(days = 3) {
  const safeDays = Math.min(30, Math.max(1, Number(days || 3)));
  const [result] = await db.pool.execute(
    `INSERT INTO sunat_envios (comprobante_id, estado, proximo_intento)
     SELECT comp.id, 'PENDIENTE', NOW()
     FROM comprobantes comp
     WHERE comp.tipo IN ('BOLETA', 'FACTURA', 'NOTA_CREDITO')
       AND comp.estado <> 'ANULADO'
       AND comp.fecha_emision >= DATE_SUB(CURDATE(), INTERVAL ${safeDays} DAY)
       AND comp.sunat_estado <> 'ACEPTADO'
       AND NOT EXISTS (
         SELECT 1 FROM sunat_envios se WHERE se.comprobante_id = comp.id
       )`,
    []
  );
  return { encolados: Number(result.affectedRows || 0), dias: safeDays };
}

async function getComprobanteContext(comprobanteId) {
  const [rows] = await db.query(
    `SELECT
       comp.*,
       c.pedido_id,
       p.sucursal_id,
       s.restaurante_id,
       r.nombre AS restaurante_nombre,
       r.ruc AS restaurante_ruc,
       cli.tipo_documento,
       cli.numero_documento,
       cli.razon_social,
       cli.nombres,
       cli.apellidos,
       ref.tipo AS referencia_tipo,
       ref.serie AS referencia_serie,
       ref.numero AS referencia_numero
     FROM comprobantes comp
     JOIN cuentas c ON c.id = comp.cuenta_id
     JOIN pedidos p ON p.id = c.pedido_id
     JOIN sucursales s ON s.id = p.sucursal_id
     JOIN restaurantes r ON r.id = s.restaurante_id
     LEFT JOIN clientes cli ON cli.id = comp.cliente_id
     LEFT JOIN comprobantes ref ON ref.id = comp.comprobante_referencia_id
     WHERE comp.id = ?
     LIMIT 1`,
    [comprobanteId]
  );
  if (!rows?.length) return null;
  const comprobante = rows[0];
  const [details] = await db.query(
    `SELECT id, producto_id, descripcion, cantidad, precio_unitario, subtotal
     FROM comprobante_detalles
     WHERE comprobante_id = ?
     ORDER BY id`,
    [comprobanteId]
  );
  comprobante.detalles = details || [];
  return comprobante;
}

async function buildPayload(comprobante) {
  const tipoDoc = fiscalType(comprobante.tipo);
  if (!tipoDoc) {
    const error = new Error('El tipo de comprobante no se envía a SUNAT');
    error.code = 'SUNAT_NOT_APPLICABLE';
    throw error;
  }
  const credentials = await restaurantService.getSunatCredentials(comprobante.restaurante_id);
  if (!credentials) {
    const error = new Error('El restaurante no tiene credenciales SUNAT activas y completas');
    error.code = 'SUNAT_NOT_CONFIGURED';
    throw error;
  }
  const solParts = String(credentials.usuario_sol || '').split('#');
  if (solParts.length !== 2 || !solParts[0] || !solParts[1]) {
    const error = new Error('El usuario SOL configurado no tiene el formato usuario#clave');
    error.code = 'SUNAT_INVALID_CONFIG';
    throw error;
  }
  if (!comprobante.restaurante_ruc) {
    const error = new Error('El restaurante no tiene RUC configurado');
    error.code = 'SUNAT_INVALID_DOCUMENT';
    throw error;
  }
  if (!comprobante.detalles?.length) {
    const error = new Error('El comprobante no tiene detalles');
    error.code = 'SUNAT_INVALID_DOCUMENT';
    throw error;
  }

  const customerName = comprobante.razon_social
    || `${comprobante.nombres || ''} ${comprobante.apellidos || ''}`.trim()
    || 'CLIENTE GENERAL';
  const customerDocument = String(comprobante.numero_documento || '').trim();
  if (tipoDoc === '01' && (clientDocumentType(comprobante) !== '6' || customerDocument.length !== 11)) {
    const error = new Error('La factura requiere un cliente con RUC válido');
    error.code = 'SUNAT_INVALID_DOCUMENT';
    throw error;
  }

  const payload = {
    ublVersion: '2.1',
    serie: comprobante.serie,
    correlativo: Number(comprobante.numero),
    fechaEmision: new Date(comprobante.fecha_emision).toLocaleDateString('en-CA', {
      timeZone: 'America/Lima',
    }),
    tipoDoc,
    tipoOperacion: '0101',
    tipoMoneda: 'PEN',
    seguridad: {
      usuario_sol: solParts[0],
      clave_sol: solParts[1],
      passphrase: credentials.passphrase,
    },
    company: {
      ruc: comprobante.restaurante_ruc,
      address: {
        codLocal: '0000',
        codigoPais: 'PE',
      },
    },
    client: {
      tipoDoc: clientDocumentType(comprobante),
      numDoc: customerDocument || '-',
      rznSocial: customerName,
    },
    totalImpuestos: money(comprobante.igv),
    mtoOperGravadas: money(comprobante.subtotal),
    mtoIGV: money(comprobante.igv),
    valorVenta: money(comprobante.subtotal),
    subTotal: money(comprobante.total),
    mtoImpVenta: money(comprobante.total),
    formaPago: { tipo: 'Contado' },
    details: comprobante.detalles.map((detail) => {
      const quantity = Number(detail.cantidad || 1);
      const grossSubtotal = money(detail.subtotal);
      const netSubtotal = money(grossSubtotal / 1.18);
      const igv = money(grossSubtotal - netSubtotal);
      return {
        unidad: 'NIU',
        cantidad: quantity,
        mtoValorVenta: netSubtotal,
        mtoPrecioUnitario: money(grossSubtotal / quantity),
        totalImpuestos: igv,
        mtoBaseIgv: netSubtotal,
        igv,
        porcentajeIgv: 18,
        tipAfeIgv: 10,
        descripcion: detail.descripcion || 'Producto',
        mtoValorUnitario: money(netSubtotal / quantity),
      };
    }),
  };

  if (tipoDoc === '07') {
    if (!comprobante.referencia_tipo || !comprobante.referencia_serie || !comprobante.referencia_numero) {
      const error = new Error('La nota de crédito requiere un comprobante de referencia');
      error.code = 'SUNAT_INVALID_DOCUMENT';
      throw error;
    }
    payload.codMotivo = '01';
    payload.desMotivo = 'Anulación de comprobante';
    payload.numDocfectado = `${comprobante.referencia_serie}-${comprobante.referencia_numero}`;
    payload.tipDocAfectado = fiscalType(comprobante.referencia_tipo);
    delete payload.formaPago;
  }

  return { payload, token: credentials.token };
}

async function aliceRequest(path, { token, body, form = false }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ALICE_TIMEOUT_MS || 30000));
  try {
    const response = await fetch(`${ALICE_BASE_URL}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(form ? {} : { 'Content-Type': 'application/json' }),
      },
      body: form ? body : JSON.stringify(body),
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function claimNext() {
  const conn = await db.getConnection();
  const lockName = 'sunat-envios-claim';
  try {
    const [lockRows] = await conn.query('SELECT GET_LOCK(?, 2) AS acquired', [lockName]);
    if (Number(lockRows?.[0]?.acquired) !== 1) return null;
    await conn.execute(
      `UPDATE sunat_envios
       SET estado = 'ERROR', lock_token = NULL, bloqueado_hasta = NULL,
           mensaje = COALESCE(mensaje, 'El envío anterior no liberó el bloqueo')
       WHERE estado = 'PROCESANDO' AND bloqueado_hasta < NOW()`
    );
    const [rows] = await conn.execute(
      `SELECT id, comprobante_id, intentos, max_intentos
       FROM sunat_envios
       WHERE estado IN ('PENDIENTE', 'ERROR')
         AND intentos < max_intentos
         AND (proximo_intento IS NULL OR proximo_intento <= NOW())
         AND (bloqueado_hasta IS NULL OR bloqueado_hasta < NOW())
       ORDER BY created_at, id
       LIMIT 1`
    );
    if (!rows?.length) return null;
    const token = randomUUID();
    const job = rows[0];
    const [result] = await conn.execute(
      `UPDATE sunat_envios
       SET estado = 'PROCESANDO', lock_token = ?, bloqueado_hasta = DATE_ADD(NOW(), INTERVAL 2 MINUTE),
           intentos = intentos + 1, fecha_ultimo_intento = NOW()
       WHERE id = ? AND estado IN ('PENDIENTE', 'ERROR')`,
      [token, job.id]
    );
    if (!result.affectedRows) return null;
    await conn.execute(
      `UPDATE comprobantes SET sunat_estado = 'ENVIANDO' WHERE id = ?`,
      [job.comprobante_id]
    );
    return { ...job, intentos: Number(job.intentos || 0) + 1, lock_token: token };
  } finally {
    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch {}
    conn.release();
  }
}

function resultCode(result) {
  return String(result?.cdrResponse?.code ?? result?.error?.code ?? '');
}

function resultMessage(result) {
  return String(
    result?.cdrResponse?.description
      || result?.cdrResponse?.message
      || result?.error?.message
      || 'Respuesta SUNAT no especificada'
  ).slice(0, 1000);
}

async function finishJob(job, outcome) {
  const responseJson = outcome.response === undefined
    ? null
    : JSON.stringify(outcome.response).slice(0, 1000000);
  if (outcome.status === 'ACEPTADO') {
    await db.pool.execute(
      `UPDATE sunat_envios
       SET estado = 'ACEPTADO', http_code = ?, codigo_respuesta = ?, mensaje = ?,
           respuesta_json = ?, fecha_aceptacion = NOW(), lock_token = NULL, bloqueado_hasta = NULL
       WHERE id = ? AND lock_token = ?`,
      [outcome.httpCode || null, outcome.code || null, outcome.message || null, responseJson, job.id, job.lock_token]
    );
    await db.pool.execute(
      `UPDATE comprobantes
       SET sunat_estado = 'ACEPTADO', sunat_codigo = ?, sunat_mensaje = ?,
           sunat_enviado_at = COALESCE(sunat_enviado_at, NOW()), sunat_aceptado_at = NOW()
       WHERE id = ?`,
      [outcome.code || null, outcome.message || 'Aceptado por SUNAT', job.comprobante_id]
    );
    return;
  }
  if (outcome.status === 'RECHAZADO') {
    await db.pool.execute(
      `UPDATE sunat_envios
       SET estado = 'RECHAZADO', http_code = ?, codigo_respuesta = ?, mensaje = ?,
           respuesta_json = ?, lock_token = NULL, bloqueado_hasta = NULL
       WHERE id = ? AND lock_token = ?`,
      [outcome.httpCode || null, outcome.code || null, outcome.message, responseJson, job.id, job.lock_token]
    );
    await db.pool.execute(
      `UPDATE comprobantes
       SET sunat_estado = 'RECHAZADO', sunat_codigo = ?, sunat_mensaje = ?, sunat_enviado_at = NOW()
       WHERE id = ?`,
      [outcome.code || null, outcome.message, job.comprobante_id]
    );
    return;
  }

  const exhausted = job.intentos >= Number(job.max_intentos || 8);
  const delaySeconds = Math.min(3600, 30 * (2 ** Math.max(0, job.intentos - 1)));
  await db.pool.execute(
    `UPDATE sunat_envios
     SET estado = 'ERROR', http_code = ?, codigo_respuesta = ?, mensaje = ?, respuesta_json = ?,
         proximo_intento = ${exhausted ? 'NULL' : `DATE_ADD(NOW(), INTERVAL ${delaySeconds} SECOND)`},
         lock_token = NULL, bloqueado_hasta = NULL
     WHERE id = ? AND lock_token = ?`,
    [
      outcome.httpCode || null,
      outcome.code || null,
      outcome.message,
      responseJson,
      job.id,
      job.lock_token,
    ]
  );
  await db.pool.execute(
    `UPDATE comprobantes
     SET sunat_estado = 'ERROR', sunat_codigo = ?, sunat_mensaje = ?, sunat_enviado_at = NOW()
     WHERE id = ?`,
    [outcome.code || null, outcome.message, job.comprobante_id]
  );
}

async function processJob(job) {
  try {
    const comprobante = await getComprobanteContext(job.comprobante_id);
    if (!comprobante) {
      return finishJob(job, { status: 'RECHAZADO', message: 'Comprobante no encontrado' });
    }
    const { payload, token } = await buildPayload(comprobante);
    const response = await aliceRequest('/comprobantes/send', { token, body: payload });
    const text = await response.text();
    let result = null;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { raw: text.slice(0, 5000) };
    }
    if (!response.ok) {
      return finishJob(job, {
        status: 'ERROR',
        httpCode: response.status,
        message: `Alice respondió HTTP ${response.status}`,
        response: result,
      });
    }
    const code = resultCode(result);
    const message = resultMessage(result);
    if (result?.success === true || code === '1033') {
      return finishJob(job, {
        status: 'ACEPTADO',
        httpCode: response.status,
        code,
        message: code === '1033' ? 'El comprobante ya había sido enviado' : message,
        response: result,
      });
    }
    return finishJob(job, {
      status: 'RECHAZADO',
      httpCode: response.status,
      code,
      message,
      response: result,
    });
  } catch (error) {
    const permanent = ['SUNAT_INVALID_DOCUMENT', 'SUNAT_NOT_APPLICABLE'].includes(error.code);
    logger.error('SUNAT envío fallido', {
      comprobante_id: job.comprobante_id,
      code: error.code || null,
      message: error.message,
    });
    return finishJob(job, {
      status: permanent ? 'RECHAZADO' : 'ERROR',
      code: error.code || null,
      message: String(error.message || 'Error enviando a SUNAT').slice(0, 1000),
    });
  }
}

async function runOnce() {
  const job = await claimNext();
  if (!job) return false;
  await processJob(job);
  return true;
}

async function workerTick() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    if (Date.now() - lastReconcileAt >= RECONCILE_INTERVAL_MS) {
      await reconcilePending(3);
      lastReconcileAt = Date.now();
    }
    await runOnce();
  } catch (error) {
    logger.error('SUNAT worker error', error.message || error);
  } finally {
    workerRunning = false;
    workerTimer = setTimeout(workerTick, WORKER_INTERVAL_MS);
    workerTimer.unref?.();
  }
}

function startWorker() {
  if (process.env.SUNAT_WORKER_ENABLED !== 'true' || workerTimer) return;
  workerTimer = setTimeout(workerTick, 1000);
  workerTimer.unref?.();
  logger.info('SUNAT worker iniciado');
}

function stopWorker() {
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
}

async function retry(comprobanteId) {
  const [result] = await db.pool.execute(
    `UPDATE sunat_envios
     SET estado = 'PENDIENTE', intentos = 0, proximo_intento = NOW(),
         bloqueado_hasta = NULL, lock_token = NULL, mensaje = NULL
     WHERE comprobante_id = ? AND estado <> 'ACEPTADO'`,
    [comprobanteId]
  );
  if (!result.affectedRows) {
    await enqueueComprobante(comprobanteId);
  } else {
    await db.pool.execute(
      `UPDATE comprobantes
       SET sunat_estado = 'PENDIENTE', sunat_codigo = NULL, sunat_mensaje = NULL
       WHERE id = ?`,
      [comprobanteId]
    );
  }
  return { ok: true };
}

async function downloadFile(comprobanteId, kind) {
  if (!['xml', 'cdr'].includes(kind)) {
    const error = new Error('Tipo de archivo inválido');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const comprobante = await getComprobanteContext(comprobanteId);
  if (!comprobante) {
    const error = new Error('Comprobante no encontrado');
    error.code = 'NOT_FOUND';
    throw error;
  }
  if (comprobante.sunat_estado !== 'ACEPTADO') {
    const error = new Error('El comprobante todavía no fue aceptado por SUNAT');
    error.code = 'SUNAT_NOT_ACCEPTED';
    throw error;
  }
  const credentials = await restaurantService.getSunatCredentials(comprobante.restaurante_id);
  if (!credentials) {
    const error = new Error('Credenciales SUNAT no configuradas');
    error.code = 'SUNAT_NOT_CONFIGURED';
    throw error;
  }
  const form = new FormData();
  form.append('numeracion', `${comprobante.serie}-${comprobante.numero}`);
  form.append('tipo_doc', fiscalType(comprobante.tipo));
  const path = kind === 'cdr' ? '/files/downloadCDR' : '/files/downloadXML';
  const response = await aliceRequest(path, { token: credentials.token, body: form, form: true });
  if (!response.ok) {
    const error = new Error(`No se pudo descargar ${kind.toUpperCase()} (HTTP ${response.status})`);
    error.code = 'ALICE_DOWNLOAD_ERROR';
    throw error;
  }
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type')
      || (kind === 'cdr' ? 'application/zip' : 'application/xml'),
    filename: `${comprobante.restaurante_ruc}-${fiscalType(comprobante.tipo)}-${comprobante.serie}-${comprobante.numero}.${kind === 'cdr' ? 'zip' : 'xml'}`,
    restaurante_id: Number(comprobante.restaurante_id),
  };
}

module.exports = {
  DOCUMENT_TYPES,
  enqueueComprobante,
  reconcilePending,
  getComprobanteContext,
  buildPayload,
  runOnce,
  startWorker,
  stopWorker,
  retry,
  downloadFile,
};
