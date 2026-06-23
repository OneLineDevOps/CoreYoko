const express = require('express');
const router = express.Router();
const pagoService = require('../services/pagoService');
const optionalAuth = require('../middleware/optionalAuthMiddleware');

router.get('/', async (req, res) => {
  try {
    if (!req.query.pedido_id) return res.status(400).json({ error: 'pedido_id is required' });
    const rows = await pagoService.listByPedido(req.query.pedido_id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', optionalAuth, async (req, res) => {
  try {
    const created = await pagoService.create({ ...req.body, usuario_id: req.user?.id || req.body.usuario_id || null });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'CAJA_NO_ABIERTA') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
