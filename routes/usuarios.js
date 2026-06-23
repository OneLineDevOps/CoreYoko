const express = require('express');
const router = express.Router();
const usuarioService = require('../services/usuarioService');
const restaurantService = require('../services/restaurantService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

router.use(auth);
router.use(requireRoles(['ROOT']));

router.get('/meta', async (_req, res) => {
  try {
    const [roles, restaurantes] = await Promise.all([
      usuarioService.getRoles(),
      restaurantService.getAll({ includeInactive: false }),
    ]);
    res.json({ roles, restaurantes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === '1' || req.query.includeInactive === 'true';
    const rows = await usuarioService.list({ includeInactive });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await usuarioService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await usuarioService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await usuarioService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    const result = await usuarioService.resetPassword(req.params.id, req.body.password);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await usuarioService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
