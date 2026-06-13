'use strict';
const pedidoService = require('../services/pedidoService');

async function create(req, res) {
  try {
    const payload = req.body;
    const result = await pedidoService.createPedido(payload);
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getById(req, res) {
  try {
    const pedido = await pedidoService.getPedidoById(req.params.id);
    if (!pedido) return res.status(404).json({ error: 'Not found' });
    res.json(pedido);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function list(req, res) {
  try {
    const sucursal_id = req.query.sucursal_id;
    if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id is required' });
    const estado = req.query.estado;
    const rows = await pedidoService.listPedidosBySucursal(sucursal_id, estado);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function updateEstado(req, res) {
  try {
    const pedidoId = req.params.id;
    const { estado, usuario_id, observacion } = req.body;
    if (!estado) return res.status(400).json({ error: 'estado is required' });
    await pedidoService.updatePedidoEstado(pedidoId, estado, usuario_id, observacion);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { create, getById, list, updateEstado };
