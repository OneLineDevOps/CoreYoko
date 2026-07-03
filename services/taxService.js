'use strict';

const DEFAULT_IGV_PERCENTAGE = 18;

function normalizePercentage(value) {
  const percentage = Number(value);
  return Number.isFinite(percentage) && percentage > 0 && percentage <= 100
    ? percentage
    : DEFAULT_IGV_PERCENTAGE;
}

function money(value) {
  return Number(Number(value || 0).toFixed(2));
}

function calculateIncluded(totalValue, percentageValue) {
  const total = money(totalValue);
  const percentage = normalizePercentage(percentageValue);
  const subtotal = money(total / (1 + percentage / 100));
  return {
    subtotal,
    igv: money(total - subtotal),
    total,
    percentage,
  };
}

async function getPercentageByRestaurant(restauranteId, conn) {
  const [rows] = await conn.execute(
    'SELECT igv_porcentaje FROM restaurantes WHERE id = ? LIMIT 1',
    [restauranteId]
  );
  return normalizePercentage(rows?.[0]?.igv_porcentaje);
}

async function getPercentageBySucursal(sucursalId, conn) {
  const [rows] = await conn.execute(
    `SELECT r.igv_porcentaje
     FROM sucursales s
     JOIN restaurantes r ON r.id = s.restaurante_id
     WHERE s.id = ?
     LIMIT 1`,
    [sucursalId]
  );
  return normalizePercentage(rows?.[0]?.igv_porcentaje);
}

async function getPercentageByPedido(pedidoId, conn) {
  const [rows] = await conn.execute(
    `SELECT r.igv_porcentaje
     FROM pedidos p
     JOIN sucursales s ON s.id = p.sucursal_id
     JOIN restaurantes r ON r.id = s.restaurante_id
     WHERE p.id = ?
     LIMIT 1`,
    [pedidoId]
  );
  return normalizePercentage(rows?.[0]?.igv_porcentaje);
}

async function getPercentageByCuenta(cuentaId, conn) {
  const [rows] = await conn.execute(
    `SELECT r.igv_porcentaje
     FROM cuentas c
     JOIN pedidos p ON p.id = c.pedido_id
     JOIN sucursales s ON s.id = p.sucursal_id
     JOIN restaurantes r ON r.id = s.restaurante_id
     WHERE c.id = ?
     LIMIT 1`,
    [cuentaId]
  );
  return normalizePercentage(rows?.[0]?.igv_porcentaje);
}

module.exports = {
  DEFAULT_IGV_PERCENTAGE,
  normalizePercentage,
  calculateIncluded,
  getPercentageByRestaurant,
  getPercentageBySucursal,
  getPercentageByPedido,
  getPercentageByCuenta,
};
