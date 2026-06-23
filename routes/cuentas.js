const express = require('express');
const router = express.Router();
const cuentaService = require('../services/cuentaService');

router.get('/', async (req, res) => {
  try {
    if (!req.query.pedido_id) return res.status(400).json({ error: 'pedido_id is required' });
    const rows = await cuentaService.listByPedido(req.query.pedido_id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await cuentaService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await cuentaService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/detalles', async (req, res) => {
  try {
    const updated = await cuentaService.addDetalle(req.params.id, req.body);
    res.status(201).json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/detalles/:detalleId', async (req, res) => {
  try {
    const result = await cuentaService.removeDetalle(req.params.detalleId);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await cuentaService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/estado', async (req, res) => {
  try {
    const updated = await cuentaService.updateEstado(req.params.id, req.body.estado);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
