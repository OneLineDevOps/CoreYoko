const express = require('express');
const router = express.Router();
const comprobanteService = require('../services/comprobanteService');
const optionalAuth = require('../middleware/optionalAuthMiddleware');

router.post('/', optionalAuth, async (req, res) => {
  try {
    const created = await comprobanteService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'CAJA_NO_ABIERTA') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await comprobanteService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/print', async (req, res) => {
  try {
    const row = await comprobanteService.getById(req.params.id);
    if (!row) return res.status(404).send('Not found');
    const pdf = await comprobanteService.generatePdfBuffer(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="comprobante-${row.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal server error');
  }
});

router.get('/:id/pdf', async (req, res) => {
  try {
    const row = await comprobanteService.getById(req.params.id);
    if (!row) return res.status(404).send('Not found');
    const pdf = await comprobanteService.generatePdfBuffer(row);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="comprobante-${row.id}.pdf"`);
    res.send(pdf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;
