'use strict';
const db = require('../models/db');
const config = require('../config/db');
const PDFDocument = require('pdfkit');
const cajaService = require('./cajaService');
const {
  TICKET_WIDTH,
  centerLine,
  centerWrapped,
  receiptPresentation,
} = require('../utils/receiptPresentation');
const trabajoImpresionService = require('./trabajoImpresionService');
const sunatService = require('./sunatService');

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

async function getCuentaContext(cuentaId, conn = db.pool) {
  const [rows] = await conn.execute(
    `SELECT
       c.*,
       p.sucursal_id,
       p.cliente_id AS pedido_cliente_id,
       s.restaurante_id
     FROM cuentas c
     JOIN pedidos p ON p.id = c.pedido_id
     JOIN sucursales s ON s.id = p.sucursal_id
     WHERE c.id = ?
     LIMIT 1`,
    [cuentaId]
  );
  return rows && rows.length ? rows[0] : null;
}

async function getCuentaDetalles(cuentaId, conn = db.pool) {
  const [rows] = await conn.execute(
    `SELECT
       cd.cantidad,
       pd.producto_id,
       pd.cantidad AS pedido_cantidad,
       pd.precio_unitario,
       pd.subtotal AS pedido_subtotal,
       p.nombre AS producto_nombre
     FROM cuenta_detalles cd
     JOIN pedido_detalles pd ON pd.id = cd.pedido_detalle_id
     LEFT JOIN productos p ON p.id = pd.producto_id
     WHERE cd.cuenta_id = ?
     ORDER BY cd.id`,
    [cuentaId]
  );
  return rows || [];
}

async function nextSerie(tipo, restauranteId, conn, options = {}) {
  const referenceType = String(options.referenceType || '').toUpperCase();
  const seriesPrefix = tipo === 'FACTURA'
    ? 'F'
    : tipo === 'BOLETA'
      ? 'B'
      : tipo === 'NOTA_CREDITO'
        ? (referenceType === 'FACTURA' ? 'FC' : 'BC')
        : 'NP';
  const lockName = `serie-comprobante-${restauranteId}-${tipo}-${seriesPrefix}`;
  const [lockRows] = await conn.query('SELECT GET_LOCK(?, 5) AS acquired', [lockName]);
  if (!lockRows?.[0] || Number(lockRows[0].acquired) !== 1) {
    const err = new Error('No se pudo reservar la numeración del comprobante');
    err.code = 'SERIE_LOCK';
    throw err;
  }

  try {
    const [rows] = await conn.execute(
      `SELECT * FROM series_comprobante
       WHERE tipo = ? AND restaurante_id = ? AND activo = 1
         AND serie REGEXP ?
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
      [
        tipo,
        restauranteId,
        tipo === 'NOTA_CREDITO' ? `^${seriesPrefix}[A-Z0-9]{2}$` : `^${seriesPrefix}[0-9]{3}$`,
      ]
    );

    let serie = rows?.[0] || null;
    if (!serie) {
      const [numberRows] = await conn.execute(
        `SELECT COALESCE(
           MAX(CAST(SUBSTRING(serie, ?) AS UNSIGNED)),
           0
         ) + 1 AS siguiente
         FROM series_comprobante
         WHERE tipo = ? AND serie REGEXP ?`,
        [
          seriesPrefix.length + 1,
          tipo,
          tipo === 'NOTA_CREDITO' ? `^${seriesPrefix}[0-9]{2}$` : `^${seriesPrefix}[0-9]{3}$`
        ]
      );
      const sequence = Number(numberRows?.[0]?.siguiente || 1);
      const serieCode = `${seriesPrefix}${String(sequence).padStart(tipo === 'NOTA_CREDITO' ? 2 : 3, '0')}`;
      const [res] = await conn.execute(
        `INSERT INTO series_comprobante
         (restaurante_id, tipo, serie, ultimo_numero, activo)
         VALUES (?, ?, ?, 0, 1)`,
        [restauranteId, tipo, serieCode]
      );
      serie = {
        id: res.insertId,
        restaurante_id: restauranteId,
        tipo,
        serie: serieCode,
        ultimo_numero: 0
      };
    }

    const [usedRows] = await conn.execute(
      `SELECT COALESCE(MAX(numero), 0) AS ultimo_emitido
       FROM comprobantes
       WHERE tipo = ? AND serie = ?`,
      [tipo, serie.serie]
    );
    const numero = Math.max(
      Number(serie.ultimo_numero || 0),
      Number(usedRows?.[0]?.ultimo_emitido || 0)
    ) + 1;
    await conn.execute(
      'UPDATE series_comprobante SET ultimo_numero = ? WHERE id = ?',
      [numero, serie.id]
    );
    return { id: serie.id, serie: serie.serie, numero };
  } finally {
    try {
      await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
    } catch (releaseErr) {
      console.error('No se pudo liberar el bloqueo de serie', releaseErr);
    }
  }
}

async function createWithConnection(
  { cuenta_id, cliente_id, tipo = 'BOLETA', metodo_pago_id = null, sesion_caja_id = null },
  conn
) {
    const cuenta = await getCuentaContext(cuenta_id, conn);
    if (!cuenta) {
      const err = new Error('Cuenta no encontrada');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const activeSession = sesion_caja_id
      ? await cajaService.getById(sesion_caja_id)
      : await cajaService.getActiveBySucursal(cuenta.sucursal_id);
    if (!activeSession || activeSession.estado !== 'ABIERTA' || Number(activeSession.sucursal_id) !== Number(cuenta.sucursal_id)) {
      const err = new Error('Debe aperturar caja antes de emitir comprobantes');
      err.code = 'CAJA_NO_ABIERTA';
      throw err;
    }

    const detalles = await getCuentaDetalles(cuenta_id, conn);
    if (!detalles.length) {
      const err = new Error('La cuenta no tiene detalles');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    const totalCuenta = money(cuenta.total);
    const descuento = money(cuenta.descuento);
    const total = money(totalCuenta - descuento);
    const subtotal = money(total / (1 + config.igv));
    const igv = money(total - subtotal);
    const numeracion = await nextSerie(tipo, cuenta.restaurante_id || 1, conn);
    const clienteId = cliente_id || cuenta.pedido_cliente_id || null;

    const [res] = await conn.execute(
      `INSERT INTO comprobantes
       (cuenta_id, sucursal_id, cliente_id, tipo, serie, numero, fecha_emision,
        subtotal, descuento, igv, total, metodo_pago_id, sesion_caja_id, origen, estado)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, 'PEDIDO', 'EMITIDO')`,
      [
        cuenta_id,
        cuenta.sucursal_id,
        clienteId,
        tipo,
        numeracion.serie,
        numeracion.numero,
        subtotal.toFixed(2),
        descuento.toFixed(2),
        igv.toFixed(2),
        total.toFixed(2),
        metodo_pago_id || null,
        activeSession.id,
      ]
    );
    const comprobanteId = res.insertId;

    for (const detalle of detalles) {
      const pedidoCantidad = Number(detalle.pedido_cantidad || 1) || 1;
      const unitSubtotal = Number(detalle.pedido_subtotal || 0) / pedidoCantidad;
      const cantidad = Number(detalle.cantidad || 1);
      await conn.execute(
        `INSERT INTO comprobante_detalles
         (comprobante_id, producto_id, descripcion, cantidad, precio_unitario, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          comprobanteId,
          detalle.producto_id || null,
          detalle.producto_nombre || 'Producto',
          cantidad,
          Number(detalle.precio_unitario || unitSubtotal).toFixed(2),
          money(unitSubtotal * cantidad).toFixed(2)
        ]
      );
    }

    await sunatService.enqueueComprobante(comprobanteId, conn);
    await conn.execute('UPDATE cuentas SET estado = "FACTURADA", total = ? WHERE id = ?', [total.toFixed(2), cuenta_id]);
    return { id: comprobanteId };
}

async function create(payload) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const created = await createWithConnection(payload, conn);
    await conn.commit();
    const receipt = await getById(created.id);
    try {
      await trabajoImpresionService.enqueueReceipt(receipt);
    } catch (printError) {
      console.error('No se pudo encolar el comprobante', printError);
    }
    return receipt;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function validateFiscalClient(tipo, client) {
  if (!client) {
    const err = new Error('Seleccione un cliente válido');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (tipo === 'FACTURA' && (
    String(client.tipo_documento || '').toUpperCase() !== 'RUC'
    || !/^\d{11}$/.test(String(client.numero_documento || ''))
  )) {
    const err = new Error('La factura requiere un cliente con RUC válido');
    err.code = 'INVALID_INPUT';
    throw err;
  }
}

async function createDirect({
  sucursal_id,
  sesion_caja_id,
  cliente_id,
  tipo,
  metodo_pago_id,
  detalles,
  observacion,
  usuario_id,
}) {
  if (!['BOLETA', 'FACTURA'].includes(tipo) || !sucursal_id || !sesion_caja_id || !cliente_id || !metodo_pago_id) {
    const err = new Error('Complete sucursal, caja, cliente, tipo y método de pago');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const normalizedDetails = (Array.isArray(detalles) ? detalles : []).map((detail) => ({
    descripcion: String(detail.descripcion || '').trim(),
    cantidad: Number(detail.cantidad || 0),
    precio_unitario: money(detail.precio_unitario),
  }));
  if (!normalizedDetails.length || normalizedDetails.some((detail) => (
    !detail.descripcion || detail.cantidad <= 0 || detail.precio_unitario <= 0
  ))) {
    const err = new Error('Agregue al menos un ítem con descripción, cantidad y precio válidos');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [[branch]] = await conn.execute(
      'SELECT id, restaurante_id FROM sucursales WHERE id = ? AND activo = 1 LIMIT 1',
      [sucursal_id]
    );
    const [[client]] = await conn.execute('SELECT * FROM clientes WHERE id = ? LIMIT 1', [cliente_id]);
    const [[method]] = await conn.execute(
      'SELECT id FROM metodos_pago WHERE id = ? AND activo = 1 LIMIT 1',
      [metodo_pago_id]
    );
    const activeSession = await cajaService.getById(sesion_caja_id);
    if (!branch || !method) {
      const err = new Error('Sucursal o método de pago no disponible');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    if (!activeSession || activeSession.estado !== 'ABIERTA' || Number(activeSession.sucursal_id) !== Number(sucursal_id)) {
      const err = new Error('La caja seleccionada no está abierta para esta sucursal');
      err.code = 'CAJA_NO_ABIERTA';
      throw err;
    }
    validateFiscalClient(tipo, client);

    const total = money(normalizedDetails.reduce(
      (sum, detail) => sum + detail.cantidad * detail.precio_unitario,
      0
    ));
    const subtotal = money(total / (1 + config.igv));
    const igv = money(total - subtotal);
    const numeracion = await nextSerie(tipo, branch.restaurante_id, conn);
    const [result] = await conn.execute(
      `INSERT INTO comprobantes
       (cuenta_id, sucursal_id, cliente_id, tipo, serie, numero, fecha_emision,
        subtotal, descuento, igv, total, metodo_pago_id, sesion_caja_id, usuario_id,
        origen, motivo_descripcion, estado)
       VALUES (NULL, ?, ?, ?, ?, ?, NOW(), ?, 0, ?, ?, ?, ?, ?, 'FACTURADOR', ?, 'EMITIDO')`,
      [
        sucursal_id,
        cliente_id,
        tipo,
        numeracion.serie,
        numeracion.numero,
        subtotal.toFixed(2),
        igv.toFixed(2),
        total.toFixed(2),
        metodo_pago_id,
        sesion_caja_id,
        usuario_id || null,
        observacion || null,
      ]
    );
    const comprobanteId = result.insertId;
    for (const detail of normalizedDetails) {
      await conn.execute(
        `INSERT INTO comprobante_detalles
         (comprobante_id, producto_id, descripcion, cantidad, precio_unitario, subtotal)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        [
          comprobanteId,
          detail.descripcion,
          detail.cantidad,
          detail.precio_unitario.toFixed(2),
          money(detail.cantidad * detail.precio_unitario).toFixed(2),
        ]
      );
    }
    await conn.execute(
      `INSERT INTO pagos
       (pedido_id, comprobante_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id)
       VALUES (NULL, ?, ?, ?, ?, ?, ?)`,
      [
        comprobanteId,
        metodo_pago_id,
        total.toFixed(2),
        `Facturador ${tipo} ${numeracion.serie}-${numeracion.numero}`,
        usuario_id || null,
        sesion_caja_id,
      ]
    );
    await sunatService.enqueueComprobante(comprobanteId, conn);
    await conn.commit();
    const receipt = await getById(comprobanteId);
    try {
      await trabajoImpresionService.enqueueReceipt(receipt);
    } catch (printError) {
      console.error('No se pudo encolar el comprobante directo', printError);
    }
    return receipt;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function createCreditNote(referenceId, {
  motivo_descripcion,
  sesion_caja_id = null,
  usuario_id = null,
} = {}) {
  const reason = String(motivo_descripcion || '').trim();
  if (reason.length < 3) {
    const err = new Error('Ingrese el motivo de la anulación');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT comp.*, COALESCE(comp.sucursal_id, ped.sucursal_id) AS sucursal_id_resuelta,
              s.restaurante_id
       FROM comprobantes comp
       LEFT JOIN cuentas cu ON cu.id = comp.cuenta_id
       LEFT JOIN pedidos ped ON ped.id = cu.pedido_id
       JOIN sucursales s ON s.id = COALESCE(comp.sucursal_id, ped.sucursal_id)
       WHERE comp.id = ?
       LIMIT 1
       FOR UPDATE`,
      [referenceId]
    );
    const reference = rows?.[0];
    if (!reference) {
      const err = new Error('Comprobante no encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (!['BOLETA', 'FACTURA'].includes(reference.tipo)) {
      const err = new Error('Solo se pueden anular boletas y facturas mediante nota de crédito');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    if (reference.estado === 'ANULADO') {
      const err = new Error('El comprobante ya está anulado');
      err.code = 'INVALID_STATE';
      throw err;
    }
    if (reference.sunat_estado !== 'ACEPTADO') {
      const err = new Error('Solo se puede anular un comprobante aceptado por SUNAT');
      err.code = 'INVALID_STATE';
      throw err;
    }
    const [existing] = await conn.execute(
      `SELECT id, sunat_estado
       FROM comprobantes
       WHERE comprobante_referencia_id = ?
         AND tipo = 'NOTA_CREDITO'
         AND sunat_estado NOT IN ('RECHAZADO')
       ORDER BY id DESC LIMIT 1`,
      [referenceId]
    );
    if (existing?.length) {
      const err = new Error('Ya existe una nota de crédito para este comprobante');
      err.code = 'INVALID_STATE';
      throw err;
    }

    const numeracion = await nextSerie(
      'NOTA_CREDITO',
      reference.restaurante_id,
      conn,
      { referenceType: reference.tipo }
    );
    const [result] = await conn.execute(
      `INSERT INTO comprobantes
       (cuenta_id, sucursal_id, cliente_id, tipo, serie, numero, fecha_emision,
        subtotal, descuento, igv, total, metodo_pago_id, sesion_caja_id, usuario_id,
        origen, estado, comprobante_referencia_id, motivo_codigo, motivo_descripcion)
       VALUES (?, ?, ?, 'NOTA_CREDITO', ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?,
               'ANULACION', 'EMITIDO', ?, '01', ?)`,
      [
        reference.cuenta_id,
        reference.sucursal_id_resuelta,
        reference.cliente_id,
        numeracion.serie,
        numeracion.numero,
        reference.subtotal,
        reference.descuento,
        reference.igv,
        reference.total,
        reference.metodo_pago_id,
        sesion_caja_id || reference.sesion_caja_id || null,
        usuario_id,
        reference.id,
        reason,
      ]
    );
    await conn.execute(
      `INSERT INTO comprobante_detalles
       (comprobante_id, producto_id, descripcion, cantidad, precio_unitario, subtotal)
       SELECT ?, producto_id, descripcion, cantidad, precio_unitario, subtotal
       FROM comprobante_detalles
       WHERE comprobante_id = ?`,
      [result.insertId, reference.id]
    );
    await sunatService.enqueueComprobante(result.insertId, conn);
    await conn.commit();
    const creditNote = await getById(result.insertId);
    try {
      await trabajoImpresionService.enqueueReceipt(creditNote);
    } catch (printError) {
      console.error('No se pudo encolar la nota de crédito', printError);
    }
    return creditNote;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function cancelOrderDocument(referenceId, {
  motivo_descripcion,
  usuario_id = null,
} = {}) {
  const reason = String(motivo_descripcion || '').trim();
  if (reason.length < 3) {
    const err = new Error('Ingrese el motivo de la anulación');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT comp.*, cu.pedido_id, ped.mesa_id
       FROM comprobantes comp
       JOIN cuentas cu ON cu.id = comp.cuenta_id
       JOIN pedidos ped ON ped.id = cu.pedido_id
       WHERE comp.id = ?
       LIMIT 1
       FOR UPDATE`,
      [referenceId]
    );
    const document = rows?.[0];
    if (!document) {
      const err = new Error('Comprobante no encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (document.tipo !== 'NOTA_PEDIDO') {
      const err = new Error('Este comprobante requiere una nota de crédito');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    if (document.estado === 'ANULADO') {
      const err = new Error('El pago ya está anulado');
      err.code = 'INVALID_STATE';
      throw err;
    }
    const [payments] = await conn.execute(
      `SELECT pg.id
       FROM pagos pg
       WHERE pg.estado = 'ACTIVO'
         AND (
           pg.comprobante_id = ?
           OR (
             pg.pedido_id = ?
             AND pg.metodo_pago_id = ?
             AND ABS(pg.monto - ?) < 0.01
           )
         )
       ORDER BY pg.id DESC
       LIMIT 1
       FOR UPDATE`,
      [document.id, document.pedido_id, document.metodo_pago_id, document.total]
    );
    const payment = payments?.[0];
    if (!payment) {
      const err = new Error('No se encontró un pago activo para anular');
      err.code = 'INVALID_STATE';
      throw err;
    }
    await conn.execute(
      `UPDATE pagos
       SET estado = 'ANULADO', motivo_anulacion = ?, anulado_at = NOW(), anulado_por = ?
       WHERE id = ?`,
      [reason, usuario_id, payment.id]
    );
    await conn.execute(
      `UPDATE comprobantes
       SET estado = 'ANULADO', motivo_codigo = '01', motivo_descripcion = ?
       WHERE id = ?`,
      [reason, document.id]
    );
    await conn.execute('UPDATE cuentas SET estado = "ABIERTA" WHERE id = ?', [document.cuenta_id]);
    await conn.execute('UPDATE pedidos SET estado = "LISTO" WHERE id = ?', [document.pedido_id]);
    if (document.mesa_id) {
      await conn.execute('UPDATE mesas SET estado = "OCUPADA" WHERE id = ?', [document.mesa_id]);
    }
    await conn.execute(
      `INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion)
       VALUES (?, 'LISTO', ?, ?)`,
      [document.pedido_id, usuario_id, `Pago anulado: ${reason}`]
    );
    await conn.commit();
    return {
      tipo_anulacion: 'DIRECTA',
      comprobante_id: Number(document.id),
      pago_id: Number(payment.id),
      pedido_id: Number(document.pedido_id),
      estado: 'ANULADO',
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function cancelPayment(referenceId, payload = {}) {
  const document = await getById(referenceId);
  if (!document) {
    const err = new Error('Comprobante no encontrado');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (document.tipo === 'NOTA_PEDIDO') {
    return cancelOrderDocument(referenceId, payload);
  }
  if (['BOLETA', 'FACTURA'].includes(document.tipo)) {
    const note = await createCreditNote(referenceId, payload);
    return { ...note, tipo_anulacion: 'NOTA_CREDITO' };
  }
  const err = new Error('Este comprobante no admite anulación de pago');
  err.code = 'INVALID_INPUT';
  throw err;
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT comp.*, c.pedido_id, p.numero AS pedido_numero, p.mesa_id,
            COALESCE(comp.sucursal_id, p.sucursal_id) AS sucursal_id,
            COALESCE(m.codigo, p.mesa_temporal_codigo) AS mesa_codigo,
            COALESCE(comp.sesion_caja_id, (
              SELECT pg.sesion_caja_id
              FROM pagos pg
              WHERE pg.comprobante_id = comp.id OR pg.pedido_id = c.pedido_id
                AND pg.sesion_caja_id IS NOT NULL
              ORDER BY pg.fecha_pago DESC, pg.id DESC
              LIMIT 1
            )) AS sesion_caja_id,
            s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
            r.id AS restaurante_id, r.nombre AS restaurante_nombre, r.ruc AS restaurante_ruc,
            r.direccion AS restaurante_direccion, r.telefono AS restaurante_telefono,
            cli.tipo_documento, cli.numero_documento, cli.razon_social, cli.nombres, cli.apellidos,
            ref.tipo AS referencia_tipo, ref.serie AS referencia_serie, ref.numero AS referencia_numero,
            nc.id AS nota_credito_id, nc.sunat_estado AS nota_credito_sunat_estado
     FROM comprobantes comp
     LEFT JOIN cuentas c ON c.id = comp.cuenta_id
     LEFT JOIN pedidos p ON p.id = c.pedido_id
     LEFT JOIN mesas m ON m.id = p.mesa_id
     LEFT JOIN sucursales s ON s.id = COALESCE(comp.sucursal_id, p.sucursal_id)
     LEFT JOIN restaurantes r ON r.id = s.restaurante_id
     LEFT JOIN clientes cli ON cli.id = comp.cliente_id
     LEFT JOIN comprobantes ref ON ref.id = comp.comprobante_referencia_id
     LEFT JOIN comprobantes nc ON nc.id = (
       SELECT nc2.id FROM comprobantes nc2
       WHERE nc2.comprobante_referencia_id = comp.id AND nc2.tipo = 'NOTA_CREDITO'
       ORDER BY nc2.id DESC LIMIT 1
     )
     WHERE comp.id = ?
     LIMIT 1`,
    [id]
  );
  if (!rows || !rows.length) return null;
  const comprobante = rows[0];
  const [detalles] = await db.query('SELECT * FROM comprobante_detalles WHERE comprobante_id = ? ORDER BY id', [id]);
  comprobante.detalles = detalles || [];
  return comprobante;
}

function renderPrintText(comprobante) {
  const presentation = receiptPresentation(comprobante);
  const line = '-'.repeat(TICKET_WIDTH);
  const lines = [
    ...centerWrapped(presentation.restaurantName.toUpperCase()),
    presentation.restaurantRuc ? centerLine(`RUC: ${presentation.restaurantRuc}`) : '',
    presentation.branchName ? centerLine(`Sucursal: ${presentation.branchName}`) : '',
    ...centerWrapped(presentation.address),
    presentation.phone ? centerLine(`Telefono: ${presentation.phone}`) : '',
    line,
    centerLine(presentation.typeLabel),
    centerLine(presentation.number),
    line,
    presentation.dateTime ? `Fecha: ${presentation.dateTime}` : '',
    comprobante.sesion_caja_id ? `Caja: #${comprobante.sesion_caja_id}` : '',
    comprobante.pedido_numero ? `Pedido: ${comprobante.pedido_numero}` : '',
    comprobante.mesa_codigo ? `Mesa: ${comprobante.mesa_codigo}` : '',
    comprobante.referencia_serie
      ? `Comprobante afectado: ${comprobante.referencia_serie}-${comprobante.referencia_numero}`
      : '',
    comprobante.motivo_descripcion ? `Motivo: ${comprobante.motivo_descripcion}` : '',
    line,
    `Cliente: ${presentation.customer}`,
    comprobante.numero_documento ? `Documento: ${comprobante.numero_documento}` : '',
    line,
    ...comprobante.detalles.map((d) => {
      const qty = Number(d.cantidad || 0);
      const unit = Number(d.precio_unitario || 0);
      const sub = Number(d.subtotal || 0);
      return `${d.descripcion}\n  ${qty} x ${unit.toFixed(2)}      ${sub.toFixed(2)}`;
    }),
    line,
    `Op. gravada: S/ ${Number(comprobante.subtotal).toFixed(2)}`,
    `IGV incluido: S/ ${Number(comprobante.igv).toFixed(2)}`,
    `TOTAL: S/ ${Number(comprobante.total).toFixed(2)}`,
    line,
    ...presentation.closingLines.map((message) => centerLine(message)),
  ];
  return lines.filter(Boolean).join('\n');
}

function generatePdfBuffer(comprobante) {
  return new Promise((resolve, reject) => {
    const detailHeight = (comprobante.detalles || []).reduce((height, detail) => {
      const descriptionLines = Math.max(1, Math.ceil(String(detail.descripcion || 'Producto').length / 30));
      return height + 21 + (descriptionLines - 1) * 10;
    }, 0);
    const ticketHeight = Math.max(400, 295 + detailHeight);
    const doc = new PDFDocument({ size: [226, ticketHeight], margin: 16 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const presentation = receiptPresentation(comprobante);

    const writeLine = (text, opts = {}) => {
      if (!text) return;
      doc
        .font(opts.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(opts.size || 9)
        .text(String(text), { align: opts.align || 'left' });
    };

    doc.font('Helvetica-Bold').fontSize(13).text(presentation.restaurantName.toUpperCase(), { align: 'center' });
    if (presentation.restaurantRuc) {
      doc.font('Helvetica-Bold').fontSize(9).text(`RUC: ${presentation.restaurantRuc}`, { align: 'center' });
    }
    if (presentation.branchName) writeLine(`Sucursal: ${presentation.branchName}`, { align: 'center' });
    if (presentation.address) writeLine(presentation.address, { align: 'center' });
    if (presentation.phone) writeLine(`Telefono: ${presentation.phone}`, { align: 'center' });
    doc.moveDown(0.4);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.4);

    doc.font('Helvetica-Bold').fontSize(11).text(presentation.typeLabel, { align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).text(presentation.number, { align: 'center' });
    doc.font('Helvetica').fontSize(7).text('Representacion impresa del comprobante electronico', { align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.3);

    if (presentation.dateTime) writeLine(`Fecha: ${presentation.dateTime}`);
    if (comprobante.sesion_caja_id) writeLine(`Caja: #${comprobante.sesion_caja_id}`);
    if (comprobante.pedido_numero) writeLine(`Pedido: ${comprobante.pedido_numero}`);
    if (comprobante.mesa_codigo) writeLine(`Mesa: ${comprobante.mesa_codigo}`);
    if (comprobante.referencia_serie) {
      writeLine(`Comprobante afectado: ${comprobante.referencia_serie}-${comprobante.referencia_numero}`);
    }
    if (comprobante.motivo_descripcion) writeLine(`Motivo: ${comprobante.motivo_descripcion}`);
    doc.moveDown(0.2);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.2);

    writeLine(`Cliente: ${presentation.customer}`);
    if (comprobante.numero_documento) writeLine(`Documento: ${comprobante.numero_documento}`);
    doc.moveDown(0.2);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.2);

    comprobante.detalles.forEach((d) => {
      const qty = Number(d.cantidad || 0);
      const unit = Number(d.precio_unitario || 0);
      const sub = Number(d.subtotal || 0);
      doc.font('Helvetica').fontSize(8.5).text(String(d.descripcion || 'Producto'));
      doc.fontSize(8).text(`${qty} x ${unit.toFixed(2)}`, { continued: true });
      doc.text(`   ${sub.toFixed(2)}`, { align: 'right' });
      doc.moveDown(0.2);
    });

    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.2);
    writeLine(`Op. gravada: S/ ${Number(comprobante.subtotal).toFixed(2)}`);
    writeLine(`IGV incluido: S/ ${Number(comprobante.igv).toFixed(2)}`);
    doc.font('Helvetica-Bold').fontSize(11).text(`TOTAL: S/ ${Number(comprobante.total).toFixed(2)}`);
    doc.moveDown(0.2);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(10).text(presentation.closingLines[0], { align: 'center' });
    doc.font('Helvetica').fontSize(8.5).text(presentation.closingLines.slice(1).join('\n'), { align: 'center' });

    doc.end();
  });
}

module.exports = {
  create,
  createWithConnection,
  createDirect,
  createCreditNote,
  cancelPayment,
  nextSerie,
  getById,
  renderPrintText,
  generatePdfBuffer,
};
