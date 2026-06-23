const express = require('express');
const router = express.Router();
const cocinaService = require('../services/cocinaService');

router.get('/', async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id || req.query.sucursalId;
    if (!sucursalId) return res.status(400).json({ error: 'sucursal_id is required' });
    const board = await cocinaService.getBoardBySucursalId(sucursalId);
    if (!board) return res.status(404).json({ error: 'Sucursal not found' });
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:codigo', async (req, res) => {
  try {
    const board = await cocinaService.getBoardBySucursalCode(req.params.codigo);
    if (!board) return res.status(404).json({ error: 'Sucursal not found' });
    res.json(board);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
