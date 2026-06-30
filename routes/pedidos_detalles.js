const express = require('express');
const router = express.Router();
const pedidoService = require('../services/pedidoService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

router.put('/:id', auth, requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO']), async (req, res) => {
  try {
    const pedidoId = req.params.id;
    const { detalles, mesa_temporal_codigo } = req.body;
    if (!Array.isArray(detalles)) return res.status(400).json({ error: 'detalles must be array' });
    await pedidoService.updatePedidoDetalles(pedidoId, detalles, mesa_temporal_codigo);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR') return res.status(400).json({ error: err.message });
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
