const express = require('express');
const router = express.Router();
const pedidoService = require('../services/pedidoService');

router.put('/:id', async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { detalles } = req.body;
    if (!Array.isArray(detalles)) return res.status(400).json({ error: 'detalles must be array' });
    await pedidoService.updatePedidoDetalles(pedidoId, detalles);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
