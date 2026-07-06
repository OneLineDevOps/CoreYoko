'use strict';

const express = require('express');
const router = express.Router();
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const impresoraService = require('../services/impresoraService');
const trabajoService = require('../services/trabajoImpresionService');

router.use(auth);
router.use(requireRoles(['ROOT', 'ADMINISTRADOR']));

function isRoot(req) {
  return (req.user?.role_names || []).includes('ROOT');
}

async function canManageBranch(req, branchId) {
  const branch = await impresoraService.branchById(branchId);
  if (!branch) return null;
  if (isRoot(req) || Number(branch.restaurante_id) === Number(req.user?.restaurante_id)) return branch;
  return null;
}

async function canManagePrinter(req, printerId) {
  const printer = await impresoraService.getById(printerId);
  if (!printer) return null;
  const branch = await canManageBranch(req, printer.sucursal_id);
  return branch ? printer : null;
}

router.get('/', async (req, res) => {
  try {
    if (!req.query.sucursal_id) return res.status(400).json({ error: 'sucursal_id es obligatorio' });
    if (!(await canManageBranch(req, req.query.sucursal_id))) {
      return res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    }
    const rows = await impresoraService.listBySucursal(
      req.query.sucursal_id,
      req.query.include_inactive === '1'
    );
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    if (!(await canManageBranch(req, req.body.sucursal_id))) {
      return res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    }
    const created = await impresoraService.create({ ...req.body, origen: 'MANUAL' });
    res.status(201).json(created);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    if (error.code === 'DUPLICATE') return res.status(409).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!(await canManagePrinter(req, req.params.id))) {
      return res.status(403).json({ error: 'Impresora fuera de su restaurante' });
    }
    const updated = await impresoraService.update(req.params.id, req.body);
    res.json(updated);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    if (error.code === 'DUPLICATE') return res.status(409).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/propositos', async (req, res) => {
  try {
    if (!(await canManagePrinter(req, req.params.id))) {
      return res.status(403).json({ error: 'Impresora fuera de su restaurante' });
    }
    const updated = await impresoraService.setPurposes(req.params.id, req.body.propositos || []);
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/imprimir-ip', async (req, res) => {
  try {
    const printer = await canManagePrinter(req, req.params.id);
    if (!printer) {
      return res.status(403).json({ error: 'Impresora fuera de su restaurante' });
    }
    if (!printer.activo) {
      return res.status(400).json({ error: 'La impresora está desactivada' });
    }
    const branch = await impresoraService.branchById(printer.sucursal_id);
    const created = await trabajoService.enqueuePrinterIdentification(printer, branch);
    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (!(await canManagePrinter(req, req.params.id))) {
      return res.status(403).json({ error: 'Impresora fuera de su restaurante' });
    }
    const removed = await impresoraService.remove(req.params.id);
    res.json(removed);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/trabajos/lista', async (req, res) => {
  try {
    if (!req.query.sucursal_id) return res.status(400).json({ error: 'sucursal_id es obligatorio' });
    if (!(await canManageBranch(req, req.query.sucursal_id))) {
      return res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    }
    const rows = await trabajoService.list({
      sucursalId: req.query.sucursal_id,
      status: req.query.estado,
      limit: req.query.limit,
    });
    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/trabajos/:id/reintentar', async (req, res) => {
  try {
    const [rows] = await require('../models/db').query(
      'SELECT sucursal_id FROM trabajos_impresion WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!rows?.length || !(await canManageBranch(req, rows[0].sucursal_id))) {
      return res.status(403).json({ error: 'Trabajo fuera de su restaurante' });
    }
    const updated = await trabajoService.retry(req.params.id);
    if (!updated) return res.status(400).json({ error: 'Solo se pueden reintentar trabajos en ERROR o CANCELADO' });
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/trabajos/:id/cancelar', async (req, res) => {
  try {
    const [rows] = await require('../models/db').query(
      'SELECT sucursal_id FROM trabajos_impresion WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!rows?.length || !(await canManageBranch(req, rows[0].sucursal_id))) {
      return res.status(403).json({ error: 'Trabajo fuera de su restaurante' });
    }
    const updated = await trabajoService.cancel(req.params.id, req.body?.motivo || 'Cancelado manualmente');
    if (!updated) return res.status(400).json({ error: 'Este trabajo ya no se puede cancelar' });
    res.json(updated);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/trabajos/:id/reimprimir', async (req, res) => {
  try {
    const [rows] = await require('../models/db').query(
      'SELECT sucursal_id FROM trabajos_impresion WHERE id = ? LIMIT 1',
      [req.params.id]
    );
    if (!rows?.length || !(await canManageBranch(req, rows[0].sucursal_id))) {
      return res.status(403).json({ error: 'Trabajo fuera de su restaurante' });
    }
    const created = await trabajoService.reprint(req.params.id);
    if (!created) return res.status(400).json({ error: 'Solo se puede reimprimir tickets de las últimas 24 horas' });
    res.status(201).json(created);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
