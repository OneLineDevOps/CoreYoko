const express = require('express');
const router = express.Router();
const productoService = require('../services/productoService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

router.use(auth);

const canManage = requireRoles(['ROOT', 'ADMINISTRADOR']);
const accessFor = (req) => ({
  restauranteId: req.user?.restaurante_id,
  isRoot: (req.user?.role_names || []).includes('ROOT'),
});

router.get('/', async (req, res) => {
  try {
    const categoriaId = req.query.categoria_id || req.query.categoriaId;
    const sucursalId = req.query.sucursal_id || req.query.sucursalId;
    if (categoriaId) {
      return res.json(await productoService.getByCategory(categoriaId, accessFor(req)));
    }
    if (sucursalId) {
      return res.json(await productoService.getByBranch(sucursalId, accessFor(req)));
    }
    return res.status(400).json({ error: 'categoria_id or sucursal_id is required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/estaciones', async (_req, res) => {
  try {
    const rows = await productoService.getStations();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await productoService.getById(req.params.id, accessFor(req));
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', canManage, async (req, res) => {
  try {
    const created = await productoService.create(req.body, accessFor(req));
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', canManage, async (req, res) => {
  try {
    const updated = await productoService.update(req.params.id, req.body, accessFor(req));
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', canManage, async (req, res) => {
  try {
    const result = await productoService.remove(req.params.id, accessFor(req));
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
