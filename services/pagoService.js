'use strict';
const db = require('../models/db');
const cajaService = require('./cajaService');
const comprobanteService = require('./comprobanteService');
const trabajoImpresionService = require('./trabajoImpresionService');

async function listByPedido(pedidoId) {
  const [rows] = await db.query(
    `SELECT p.*, mp.nombre AS metodo_pago
     FROM pagos p
     LEFT JOIN metodos_pago mp ON mp.id = p.metodo_pago_id
     WHERE p.pedido_id = ?
     ORDER BY p.fecha_pago DESC`,
    [pedidoId]
  );
  return rows;
}

async function create({ pedido_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id }) {
  let sessionId = sesion_caja_id || null;
  if (!sessionId) {
    const [pedidoRows] = await db.query('SELECT sucursal_id FROM pedidos WHERE id = ? LIMIT 1', [pedido_id]);
    const pedido = pedidoRows && pedidoRows.length ? pedidoRows[0] : null;
    if (!pedido) {
      const err = new Error('Pedido no encontrado');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const activeSession = await cajaService.getActiveBySucursal(pedido.sucursal_id);
    if (!activeSession) {
      const err = new Error('Debe aperturar caja antes de registrar pagos');
      err.code = 'CAJA_NO_ABIERTA';
      throw err;
    }
    sessionId = activeSession.id;
  }

  const [res] = await db.pool.execute(
    `INSERT INTO pagos (pedido_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [pedido_id, metodo_pago_id, Number(monto || 0).toFixed(2), referencia || null, usuario_id || null, sessionId]
  );
  const [rows] = await db.query('SELECT * FROM pagos WHERE id = ? LIMIT 1', [res.insertId]);
  return rows && rows.length ? rows[0] : { id: res.insertId };
}

async function processPayment({
  cuenta_id,
  cliente_id,
  tipo,
  metodo_pago_id,
  usuario_id,
  sesion_caja_id,
  observacion
}) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [accountRows] = await conn.execute(
      `SELECT c.*, p.sucursal_id, p.estado AS pedido_estado
       FROM cuentas c
       JOIN pedidos p ON p.id = c.pedido_id
       WHERE c.id = ?
       LIMIT 1
       FOR UPDATE`,
      [cuenta_id]
    );
    const cuenta = accountRows?.[0];
    if (!cuenta) {
      const err = new Error('Cuenta no encontrada');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (!cliente_id || !metodo_pago_id || !tipo || !sesion_caja_id) {
      const err = new Error('Complete cliente, comprobante, método de pago y caja');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    if (!['NOTA_PEDIDO', 'BOLETA', 'FACTURA'].includes(tipo)) {
      const err = new Error('El tipo de comprobante no es válido');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    const [clientRows] = await conn.execute('SELECT id FROM clientes WHERE id = ? LIMIT 1', [cliente_id]);
    if (!clientRows?.length) {
      const err = new Error('El cliente seleccionado no existe');
      err.code = 'INVALID_INPUT';
      throw err;
    }
    const [methodRows] = await conn.execute(
      'SELECT id FROM metodos_pago WHERE id = ? AND activo = 1 LIMIT 1',
      [metodo_pago_id]
    );
    if (!methodRows?.length) {
      const err = new Error('El método de pago no está disponible');
      err.code = 'INVALID_INPUT';
      throw err;
    }

    const activeSession = await cajaService.getById(sesion_caja_id);
    if (!activeSession || activeSession.estado !== 'ABIERTA' || Number(activeSession.sucursal_id) !== Number(cuenta.sucursal_id)) {
      const err = new Error('La caja seleccionada no está abierta para esta sucursal');
      err.code = 'CAJA_NO_ABIERTA';
      throw err;
    }

    let [comprobanteRows] = await conn.execute(
      `SELECT id, total
       FROM comprobantes
       WHERE cuenta_id = ? AND estado <> 'ANULADO'
       ORDER BY id DESC
       LIMIT 1`,
      [cuenta_id]
    );
    let comprobante = comprobanteRows?.[0] || null;
    if (!comprobante) {
      const created = await comprobanteService.createWithConnection(
        { cuenta_id, cliente_id, tipo, metodo_pago_id, sesion_caja_id },
        conn
      );
      const [createdRows] = await conn.execute(
        'SELECT id, total FROM comprobantes WHERE id = ? LIMIT 1',
        [created.id]
      );
      comprobante = createdRows[0];
    }

    const reference = `Pago cuenta #${cuenta_id} comprobante #${comprobante.id}`;
    const [paymentRows] = await conn.execute(
      `SELECT pg.id
       FROM pagos pg
       WHERE (pg.comprobante_id = ? OR pg.pedido_id = ?)
         AND pg.metodo_pago_id = ?
         AND ABS(pg.monto - ?) < 0.01
         AND pg.sesion_caja_id = ?
         AND (
           pg.referencia = ?
           OR (
             pg.referencia IS NULL
             AND pg.fecha_pago BETWEEN
               (SELECT DATE_SUB(fecha_emision, INTERVAL 1 MINUTE) FROM comprobantes WHERE id = ?)
               AND
               (SELECT DATE_ADD(fecha_emision, INTERVAL 5 MINUTE) FROM comprobantes WHERE id = ?)
           )
         )
       ORDER BY pg.id DESC
       LIMIT 1`,
      [
        comprobante.id,
        cuenta.pedido_id,
        metodo_pago_id,
        Number(comprobante.total || cuenta.total || 0).toFixed(2),
        sesion_caja_id,
        reference,
        comprobante.id,
        comprobante.id
      ]
    );
    let pagoId = paymentRows?.[0]?.id || null;
    if (!pagoId) {
      const [paymentResult] = await conn.execute(
        `INSERT INTO pagos
         (pedido_id, comprobante_id, metodo_pago_id, monto, referencia, usuario_id, sesion_caja_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          cuenta.pedido_id,
          comprobante.id,
          metodo_pago_id,
          Number(comprobante.total || cuenta.total || 0).toFixed(2),
          reference,
          usuario_id || null,
          sesion_caja_id
        ]
      );
      pagoId = paymentResult.insertId;
    }

    await conn.execute('UPDATE cuentas SET estado = "PAGADA" WHERE id = ?', [cuenta_id]);
    const [openRows] = await conn.execute(
      `SELECT COUNT(*) AS pendientes
       FROM cuentas
       WHERE pedido_id = ? AND estado NOT IN ('PAGADA', 'ANULADA')`,
      [cuenta.pedido_id]
    );
    const pedidoCerrado = Number(openRows?.[0]?.pendientes || 0) === 0;
    if (pedidoCerrado && cuenta.pedido_estado !== 'ENTREGADO') {
      await conn.execute('UPDATE pedidos SET estado = "ENTREGADO" WHERE id = ?', [cuenta.pedido_id]);
      await conn.execute(
        `INSERT INTO historial_estado_pedido (pedido_id, estado, usuario_id, observacion)
         VALUES (?, 'ENTREGADO', ?, ?)`,
        [cuenta.pedido_id, usuario_id || null, observacion || 'Pedido cerrado al completar el pago']
      );
    }

    await conn.commit();
    try {
      const receipt = await comprobanteService.getById(comprobante.id);
      await trabajoImpresionService.enqueueReceipt(receipt);
    } catch (printError) {
      console.error('No se pudo encolar el comprobante pagado', printError);
    }
    return {
      ok: true,
      cuenta_id: Number(cuenta_id),
      comprobante_id: Number(comprobante.id),
      pago_id: Number(pagoId),
      pedido_id: Number(cuenta.pedido_id),
      pedido_cerrado: pedidoCerrado
    };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { listByPedido, create, processPayment };
