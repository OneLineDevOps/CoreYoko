'use strict';
const pedidoService = require('../services/pedidoService');

async function create(req, res) {
  try {
    const payload = {
      ...req.body,
      usuario_creacion: req.user?.id || req.body.usuario_creacion || null
    };
    const result = await pedidoService.createPedido(payload);
    res.status(201).json(result);
  } catch (err) {
    console.error(err);
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({ error: err.message });
    }
    if (err.code === 'TEMPORAL_CODE_LOCK') {
      return res.status(503).json({ error: err.message });
    }
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
    await pedidoService.updatePedidoEstado(pedidoId, estado, req.user?.id || usuario_id, observacion);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function remove(req, res) {
  try {
    await pedidoService.deletePedido(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    if (err.code === 'NOT_FOUND') {
      return res.status(404).json({ error: err.message });
    }
    if (err.code === 'ORDER_HAS_FINANCIAL_RECORDS' || err.code === 'ORDER_CLOSED') {
      return res.status(409).json({ error: err.message });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { create, getById, list, updateEstado, remove };
