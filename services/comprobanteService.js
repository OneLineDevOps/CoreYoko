'use strict';
const db = require('../models/db');
const config = require('../config/db');
const PDFDocument = require('pdfkit');
const cajaService = require('./cajaService');

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
  const [rows] = await conn.execute(
    `SELECT * FROM series_comprobante
     WHERE tipo = ? AND restaurante_id = ? AND activo = 1
     ORDER BY id
     LIMIT 1
     FOR UPDATE`,
    [tipo, restauranteId]
  );

  if (rows && rows.length) {
    const serie = rows[0];
    const numero = Number(serie.ultimo_numero || 0) + 1;
    await conn.execute('UPDATE series_comprobante SET ultimo_numero = ? WHERE id = ?', [numero, serie.id]);
    return { serie: serie.serie, numero };
  }

  const prefix = tipo === 'FACTURA' ? 'F001' : tipo === 'BOLETA' ? 'B001' : tipo === 'NOTA_CREDITO' ? 'NC001' : 'NP001';
  const [res] = await conn.execute(
    'INSERT INTO series_comprobante (restaurante_id, tipo, serie, ultimo_numero, activo) VALUES (?, ?, ?, 1, 1)',
    [restauranteId, tipo, prefix]
  );
  return { id: res.insertId, serie: prefix, numero: 1 };
}

async function create({ cuenta_id, cliente_id, tipo = 'BOLETA', metodo_pago_id = null, sesion_caja_id = null }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

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

    await conn.execute('UPDATE cuentas SET estado = "FACTURADA", total = ? WHERE id = ?', [total.toFixed(2), cuenta_id]);
    await conn.commit();
    return getById(comprobanteId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT comp.*, c.pedido_id, p.numero AS pedido_numero, p.mesa_id,
            m.codigo AS mesa_codigo,
            (
              SELECT pg.sesion_caja_id
              FROM pagos pg
              WHERE pg.pedido_id = c.pedido_id
                AND pg.sesion_caja_id IS NOT NULL
              ORDER BY pg.fecha_pago DESC, pg.id DESC
              LIMIT 1
            ) AS sesion_caja_id,
            s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
            r.nombre AS restaurante_nombre, r.ruc AS restaurante_ruc, r.direccion AS restaurante_direccion, r.telefono AS restaurante_telefono,
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
  const cliente = comprobante.razon_social || `${comprobante.nombres || ''} ${comprobante.apellidos || ''}`.trim() || 'Consumidor final';
  const restaurantName = comprobante.restaurante_nombre || 'Yoko Restaurante';
  const restaurantRuc = comprobante.restaurante_ruc || '';
  const address = comprobante.sucursal_direccion || comprobante.restaurante_direccion || '';
  const phone = comprobante.sucursal_telefono || comprobante.restaurante_telefono || '';
  const comprobanteNumber = `${comprobante.serie}-${String(comprobante.numero).padStart(8, '0')}`;
  const lines = [
    restaurantName.toUpperCase(),
    restaurantRuc ? `RUC: ${restaurantRuc}` : '',
    address,
    phone ? `Tel: ${phone}` : '',
    comprobante.sucursal_nombre ? `Sucursal: ${comprobante.sucursal_nombre}` : '',
    '--------------------------------',
    `${comprobante.tipo} ${comprobanteNumber}`,
    `Fecha: ${comprobante.fecha_emision}`,
    comprobante.sesion_caja_id ? `Caja: #${comprobante.sesion_caja_id}` : '',
    comprobante.pedido_numero ? `Pedido: ${comprobante.pedido_numero}` : '',
    comprobante.mesa_codigo ? `Mesa: ${comprobante.mesa_codigo}` : '',
    '--------------------------------',
    `Cliente: ${cliente}`,
    comprobante.numero_documento ? `Documento: ${comprobante.numero_documento}` : '',
    '--------------------------------',
    ...comprobante.detalles.map((d) => {
      const qty = Number(d.cantidad || 0);
      const unit = Number(d.precio_unitario || 0);
      const sub = Number(d.subtotal || 0);
      return `${d.descripcion}\n  ${qty} x ${unit.toFixed(2)}      ${sub.toFixed(2)}`;
    }),
    '--------------------------------',
    `Op. gravada: ${Number(comprobante.subtotal).toFixed(2)}`,
    `IGV incluido: ${Number(comprobante.igv).toFixed(2)}`,
    `TOTAL: ${Number(comprobante.total).toFixed(2)}`,
    '--------------------------------',
    'Gracias por su preferencia'
  ];
  return lines.filter(Boolean).join('\n');
}

function generatePdfBuffer(comprobante) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [226, 600], margin: 16 });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const cliente = comprobante.razon_social || `${comprobante.nombres || ''} ${comprobante.apellidos || ''}`.trim() || 'Consumidor final';
    const restaurantName = comprobante.restaurante_nombre || 'Yoko Restaurante';
    const restaurantRuc = comprobante.restaurante_ruc || '';
    const address = comprobante.sucursal_direccion || comprobante.restaurante_direccion || '';
    const phone = comprobante.sucursal_telefono || comprobante.restaurante_telefono || '';
    const comprobanteNumber = `${comprobante.serie}-${String(comprobante.numero).padStart(8, '0')}`;

    const writeLine = (text, opts = {}) => {
      if (!text) return;
      doc.fontSize(opts.size || 9).text(String(text), { align: opts.align || 'left' });
    };

    doc.font('Helvetica-Bold').fontSize(11).text(restaurantName.toUpperCase(), { align: 'center' });
    if (restaurantRuc) writeLine(`RUC: ${restaurantRuc}`, { align: 'center' });
    if (address) writeLine(address, { align: 'center' });
    if (phone) writeLine(`Tel: ${phone}`, { align: 'center' });
    if (comprobante.sucursal_nombre) writeLine(`Sucursal: ${comprobante.sucursal_nombre}`, { align: 'center' });
    doc.moveDown(0.4);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.4);

    doc.font('Helvetica-Bold').fontSize(10).text(`${comprobante.tipo} ${comprobanteNumber}`);
    writeLine(`Fecha: ${comprobante.fecha_emision}`);
    if (comprobante.sesion_caja_id) writeLine(`Caja: #${comprobante.sesion_caja_id}`);
    if (comprobante.pedido_numero) writeLine(`Pedido: ${comprobante.pedido_numero}`);
    if (comprobante.mesa_codigo) writeLine(`Mesa: ${comprobante.mesa_codigo}`);
    doc.moveDown(0.2);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.2);

    writeLine(`Cliente: ${cliente}`);
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
    writeLine(`Op. gravada: ${Number(comprobante.subtotal).toFixed(2)}`);
    writeLine(`IGV incluido: ${Number(comprobante.igv).toFixed(2)}`);
    doc.font('Helvetica-Bold').fontSize(10).text(`TOTAL: ${Number(comprobante.total).toFixed(2)}`);
    doc.moveDown(0.2);
    doc.moveTo(16, doc.y).lineTo(210, doc.y).stroke();
    doc.moveDown(0.2);
    writeLine('Gracias por su preferencia', { align: 'center' });

    doc.end();
  });
}

module.exports = { create, getById, renderPrintText, generatePdfBuffer };
