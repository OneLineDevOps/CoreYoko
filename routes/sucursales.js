const express = require('express');
const router = express.Router();
const sucursalService = require('../services/sucursalService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

const requireRoot = [auth, requireRoles(['ROOT'])];

router.get('/', async (req, res) => {
  try {
    const restaurante_id = req.query.restaurante_id || req.query.restauranteId;
    const includeInactive = req.query.include_inactive === '1' || req.query.includeInactive === 'true';
    const rows = await sucursalService.getByRestaurant(restaurante_id, { includeInactive });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/codigo/:codigo', async (req, res) => {
  try {
    const sucursal = await sucursalService.getByCode(req.params.codigo);
    if (!sucursal) {
      return res.status(404).json({ error: 'La sucursal no existe o está inactiva' });
    }
    res.json(sucursal);
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

router.post('/', requireRoot, async (req, res) => {
  try {
    const created = await sucursalService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', requireRoot, async (req, res) => {
  try {
    const updated = await sucursalService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', requireRoot, async (req, res) => {
  try {
    const result = await sucursalService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
