const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const comprobanteService = require('../services/comprobanteService');
const trabajoImpresionService = require('../services/trabajoImpresionService');
const auth = require('../middleware/authMiddleware');
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

router.post('/:id/imprimir-red', auth, async (req, res) => {
  try {
    const comprobante = await comprobanteService.getById(req.params.id);
    if (!comprobante) return res.status(404).json({ error: 'Comprobante no encontrado' });

    const isRoot = (req.user?.role_names || []).includes('ROOT');
    if (!isRoot && Number(comprobante.restaurante_id) !== Number(req.user?.restaurante_id)) {
      return res.status(403).json({ error: 'Comprobante fuera de su restaurante' });
    }

    const jobs = await trabajoImpresionService.enqueueReceipt(comprobante, {
      idempotencyKey: `REIMPRESION:${comprobante.id}:${randomUUID()}`,
    });
    if (!jobs.length) {
      return res.status(409).json({
        error: 'No existe una impresora activa con el propósito CAJA en esta sucursal',
      });
    }
    res.status(201).json({
      message: 'Impresión en red enviada a la cola',
      trabajos: jobs,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo enviar la impresión en red' });
  }
});

module.exports = router;
