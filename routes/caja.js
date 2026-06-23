const express = require('express');
const router = express.Router();
const cajaService = require('../services/cajaService');
const auth = require('../middleware/authMiddleware');

router.use(auth);

router.get('/activa', async (req, res) => {
  try {
    const sucursalId = req.query.sucursal_id || req.query.sucursalId;
    if (!sucursalId) return res.status(400).json({ error: 'sucursal_id is required' });
    const session = await cajaService.getActiveBySucursal(sucursalId);
    res.json(session);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/resumen', async (req, res) => {
  try {
    const summary = await cajaService.getSummary(req.params.id);
    if (!summary) return res.status(404).json({ error: 'Not found' });
    res.json(summary);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/apertura', async (req, res) => {
  try {
    const { sucursal_id, monto_inicial, observacion_apertura } = req.body;
    if (!sucursal_id) return res.status(400).json({ error: 'sucursal_id is required' });
    const session = await cajaService.open({
      sucursal_id,
      usuario_id: req.user.id,
      monto_inicial,
      observacion_apertura,
    });
    res.status(201).json(session);
  } catch (err) {
    if (err.code === 'CAJA_ABIERTA') return res.status(409).json({ error: err.message, session: err.session });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/cierre', async (req, res) => {
  try {
    const { monto_final, observacion_cierre } = req.body;
    if (monto_final === undefined || monto_final === null || monto_final === '') {
      return res.status(400).json({ error: 'monto_final is required' });
    }
    const summary = await cajaService.close({
      id: req.params.id,
      usuario_id: req.user.id,
      monto_final,
      observacion_cierre,
    });
    res.json(summary);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'CAJA_CERRADA') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
