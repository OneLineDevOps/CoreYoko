const express = require('express');
const { randomUUID } = require('crypto');
const router = express.Router();
const comprobanteService = require('../services/comprobanteService');
const trabajoImpresionService = require('../services/trabajoImpresionService');
const auth = require('../middleware/authMiddleware');
const optionalAuth = require('../middleware/optionalAuthMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const sunatService = require('../services/sunatService');
const sucursalService = require('../services/sucursalService');

const fiscalAccess = [auth, requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO'])];
const documentAccess = [auth, requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO'])];
const rootFiscalAccess = [auth, requireRoles(['ROOT'])];

async function canAccessFiscalDocument(req, comprobanteId) {
  const comprobante = await sunatService.getComprobanteContext(comprobanteId);
  if (!comprobante) return null;
  const isRoot = (req.user?.role_names || []).includes('ROOT');
  if (!isRoot && Number(comprobante.restaurante_id) !== Number(req.user?.restaurante_id)) {
    return false;
  }
  return comprobante;
}

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

router.post('/sunat/reconciliar', ...rootFiscalAccess, async (req, res) => {
  try {
    const result = await sunatService.reconcilePending(req.body?.dias || 3);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo reconciliar la cola SUNAT' });
  }
});

router.post('/facturador', ...documentAccess, async (req, res) => {
  try {
    const branch = await sucursalService.getById(req.body?.sucursal_id);
    const isRoot = (req.user?.role_names || []).includes('ROOT');
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });
    if (!isRoot && Number(branch.restaurante_id) !== Number(req.user?.restaurante_id)) {
      return res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    }
    const created = await comprobanteService.createDirect({
      ...req.body,
      usuario_id: req.user.id,
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'CAJA_NO_ABIERTA') return res.status(409).json({ error: err.message });
    if (err.code === 'SERIE_LOCK') return res.status(503).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'No se pudo emitir el comprobante' });
  }
});

router.post('/app', auth, async (req, res) => {
  try {
    const created = await comprobanteService.createFromPaidAccountForApp({
      ...req.body,
      usuario_id: req.user?.id || null,
      restaurante_id: req.user?.restaurante_id || null,
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'FORBIDDEN') return res.status(403).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message });
    if (err.code === 'SERIE_LOCK') return res.status(503).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'No se pudo emitir el comprobante desde AppYoko' });
  }
});

router.post('/:id/sunat/reintentar', ...fiscalAccess, async (req, res) => {
  try {
    const access = await canAccessFiscalDocument(req, req.params.id);
    if (access === null) return res.status(404).json({ error: 'Comprobante no encontrado' });
    if (access === false) return res.status(403).json({ error: 'Comprobante fuera de su restaurante' });
    const result = await sunatService.retry(req.params.id);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo reencolar el comprobante' });
  }
});

for (const kind of ['xml', 'cdr']) {
  router.get(`/:id/sunat/${kind}`, ...fiscalAccess, async (req, res) => {
    try {
      const access = await canAccessFiscalDocument(req, req.params.id);
      if (access === null) return res.status(404).json({ error: 'Comprobante no encontrado' });
      if (access === false) return res.status(403).json({ error: 'Comprobante fuera de su restaurante' });
      const file = await sunatService.downloadFile(req.params.id, kind);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.send(file.buffer);
    } catch (err) {
      if (err.code === 'SUNAT_NOT_ACCEPTED') return res.status(409).json({ error: err.message });
      if (err.code === 'SUNAT_NOT_CONFIGURED') return res.status(409).json({ error: err.message });
      if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
      console.error(err);
      res.status(502).json({ error: err.message || `No se pudo descargar ${kind.toUpperCase()}` });
    }
  });
}

router.post('/:id/anular', ...documentAccess, async (req, res) => {
  try {
    const access = await canAccessFiscalDocument(req, req.params.id);
    if (access === null) return res.status(404).json({ error: 'Comprobante no encontrado' });
    if (access === false) return res.status(403).json({ error: 'Comprobante fuera de su restaurante' });
    const created = await comprobanteService.cancelPayment(req.params.id, {
      motivo_descripcion: req.body?.motivo_descripcion,
      sesion_caja_id: req.body?.sesion_caja_id,
      usuario_id: req.user.id,
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'INVALID_STATE') return res.status(409).json({ error: err.message });
    if (err.code === 'SERIE_LOCK') return res.status(503).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'No se pudo generar la nota de crédito' });
  }
});

router.get('/:id', ...documentAccess, async (req, res) => {
  try {
    const access = await canAccessFiscalDocument(req, req.params.id);
    if (access === null) return res.status(404).json({ error: 'Comprobante no encontrado' });
    if (access === false) return res.status(403).json({ error: 'Comprobante fuera de su restaurante' });
    const row = await comprobanteService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/print', ...documentAccess, async (req, res) => {
  try {
    const access = await canAccessFiscalDocument(req, req.params.id);
    if (access === null) return res.status(404).send('Not found');
    if (access === false) return res.status(403).send('Forbidden');
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

router.get('/:id/pdf', ...documentAccess, async (req, res) => {
  try {
    const access = await canAccessFiscalDocument(req, req.params.id);
    if (access === null) return res.status(404).send('Not found');
    if (access === false) return res.status(403).send('Forbidden');
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
