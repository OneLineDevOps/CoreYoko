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

async function nextSerie(tipo, restauranteId, conn) {
  const seriesPrefix = tipo === 'FACTURA'
    ? 'F'
    : tipo === 'BOLETA'
      ? 'B'
      : tipo === 'NOTA_CREDITO'
        ? 'NC'
        : 'NP';
  const lockName = `serie-comprobante-${tipo}`;
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
       ORDER BY id
       LIMIT 1
       FOR UPDATE`,
      [tipo, restauranteId]
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
          `^${seriesPrefix}[0-9]{3}$`
        ]
      );
      const sequence = Number(numberRows?.[0]?.siguiente || 1);
      const serieCode = `${seriesPrefix}${String(sequence).padStart(3, '0')}`;
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
       (cuenta_id, cliente_id, tipo, serie, numero, fecha_emision, subtotal, descuento, igv, total, metodo_pago_id, estado)
       VALUES (?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, 'EMITIDO')`,
      [
        cuenta_id,
        clienteId,
        tipo,
        numeracion.serie,
        numeracion.numero,
        subtotal.toFixed(2),
        descuento.toFixed(2),
        igv.toFixed(2),
        total.toFixed(2),
        metodo_pago_id || null
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

async function getById(id) {
  const [rows] = await db.query(
    `SELECT comp.*, c.pedido_id, p.numero AS pedido_numero, p.mesa_id, p.sucursal_id,
            COALESCE(m.codigo, p.mesa_temporal_codigo) AS mesa_codigo,
            (
              SELECT pg.sesion_caja_id
              FROM pagos pg
              WHERE pg.pedido_id = c.pedido_id
                AND pg.sesion_caja_id IS NOT NULL
              ORDER BY pg.fecha_pago DESC, pg.id DESC
              LIMIT 1
            ) AS sesion_caja_id,
            s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
            r.id AS restaurante_id, r.nombre AS restaurante_nombre, r.ruc AS restaurante_ruc,
            r.direccion AS restaurante_direccion, r.telefono AS restaurante_telefono,
            cli.tipo_documento, cli.numero_documento, cli.razon_social, cli.nombres, cli.apellidos
     FROM comprobantes comp
     LEFT JOIN cuentas c ON c.id = comp.cuenta_id
     LEFT JOIN pedidos p ON p.id = c.pedido_id
     LEFT JOIN mesas m ON m.id = p.mesa_id
     LEFT JOIN sucursales s ON s.id = p.sucursal_id
     LEFT JOIN restaurantes r ON r.id = s.restaurante_id
     LEFT JOIN clientes cli ON cli.id = comp.cliente_id
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

module.exports = { create, createWithConnection, nextSerie, getById, renderPrintText, generatePdfBuffer };
