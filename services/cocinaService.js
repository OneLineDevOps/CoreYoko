'use strict';
const db = require('../models/db');
const pedidoService = require('./pedidoService');
const sucursalService = require('./sucursalService');

const KITCHEN_STATES = ['PENDIENTE', 'CONFIRMADO', 'PREPARACION', 'LISTO'];

async function loadKitchenPedidos(sucursalId) {
  const [rows] = await db.query(
    `SELECT id
     FROM pedidos
     WHERE sucursal_id = ?
       AND estado IN ('PENDIENTE', 'CONFIRMADO', 'PREPARACION', 'LISTO')
     ORDER BY fecha_pedido ASC
     LIMIT 80`,
    [sucursalId]
  );

  const pedidos = [];
  for (const row of rows || []) {
    const pedido = await pedidoService.getPedidoById(row.id);
    if (pedido) pedidos.push(pedido);
  }
  return pedidos;
}

async function getBoardBySucursalId(sucursalId) {
  const sucursal = await sucursalService.getById(sucursalId);
  if (!sucursal || Number(sucursal.activo) !== 1) return null;
  const pedidos = await loadKitchenPedidos(sucursal.id);
  return { sucursal, estados: KITCHEN_STATES, pedidos };
}

async function getBoardBySucursalCode(code) {
  const sucursal = await sucursalService.getByCode(code);
  if (!sucursal) return null;
  const pedidos = await loadKitchenPedidos(sucursal.id);
  return { sucursal, estados: KITCHEN_STATES, pedidos };
}

module.exports = { getBoardBySucursalId, getBoardBySucursalCode };
