const express = require('express');
const router = express.Router();
const sucursalService = require('../services/sucursalService');

router.get('/', async (req, res) => {
  try {
    const restaurante_id = req.query.restaurante_id || req.query.restauranteId;
    const rows = await sucursalService.getByRestaurant(restaurante_id);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await sucursalService.getById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await sucursalService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
