const express = require('express');
const router = express.Router();
const mesaService = require('../services/mesaService');

router.get('/', async (req, res) => {
  try {
    const { seccion_id, sucursal_id } = req.query;
    if (seccion_id) {
      const rows = await mesaService.getBySeccion(seccion_id);
      return res.json(rows);
    }

    if (sucursal_id) {
      const rows = await mesaService.getBySucursal(sucursal_id);
      return res.json(rows);
    }

    return res.status(400).json({ error: 'seccion_id or sucursal_id is required' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await mesaService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await mesaService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await mesaService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
