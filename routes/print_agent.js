'use strict';

const express = require('express');
const router = express.Router();
const impresoraService = require('../services/impresoraService');
const trabajoService = require('../services/trabajoImpresionService');

function authorizeAgent(req, res, next) {
  const expected = String(process.env.PRINT_AGENT_KEY || '').trim();
  if (!expected) return next();
  const received = String(req.headers['x-print-agent-key'] || '').trim();
  if (received !== expected) return res.status(401).json({ error: 'Agente de impresión no autorizado' });
  next();
}

router.use(authorizeAgent);

router.post('/sync', async (req, res) => {
  try {
    const result = await impresoraService.syncAgent({
      sucursalCodigo: req.body.sucursal_codigo,
      agenteId: req.body.agente_id,
      agenteNombre: req.body.agente_nombre,
      printers: req.body.impresoras || [],
    });
    res.json(result);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const rows = await trabajoService.claim({
      sucursalCodigo: req.query.sucursal_codigo,
      agenteId: req.query.agente_id,
      limit: req.query.limit,
    });
    res.json(rows);
  } catch (error) {
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/jobs/:id', async (req, res) => {
  try {
    const updated = await trabajoService.updateStatus({
      id: req.params.id,
      agenteId: req.body.agente_id,
      status: req.body.estado,
      errorMessage: req.body.error_mensaje,
    });
    res.json(updated);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    if (error.code === 'NOT_FOUND') return res.status(404).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
