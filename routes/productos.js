const express = require('express');
const router = express.Router();
const productoService = require('../services/productoService');

router.get('/', async (req, res) => {
  try {
    const categoria_id = req.query.categoria_id || req.query.categoriaId;
    if (categoria_id) {
      const rows = await productoService.getByCategory(categoria_id);
      return res.json(rows);
    }
    // fallback: return empty or all productos? return empty to avoid large payloads
    return res.json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const r = await productoService.getById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json(r);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await productoService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await productoService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await productoService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
