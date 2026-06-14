const express = require('express');
const router = express.Router();
const modificadorService = require('../services/modificadorService');

router.get('/', async (req, res) => {
  try {
    const producto_id = req.query.producto_id || req.query.productoId;
    if (!producto_id) return res.json([]);
    const rows = await modificadorService.getByProduct(producto_id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
