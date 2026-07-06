'use strict';

const express = require('express');
const reporteService = require('../services/reporteService');
const sucursalService = require('../services/sucursalService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

const router = express.Router();
router.use(auth);
router.use(requireRoles(['ROOT', 'ADMINISTRADOR']));

async function validateBranchAccess(req, res) {
  if (!req.query.sucursal_id) {
    res.status(400).json({ error: 'Seleccione una sucursal' });
    return false;
  }
  const branch = await sucursalService.getById(req.query.sucursal_id);
  const isRoot = (req.user?.role_names || []).includes('ROOT');
  if (!branch) {
    res.status(404).json({ error: 'Sucursal no encontrada' });
    return false;
  }
  if (!isRoot && Number(branch.restaurante_id) !== Number(req.user?.restaurante_id)) {
    res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    return false;
  }
  return true;
}

const reportRoute = (serviceMethod, fallbackMessage) => async (req, res) => {
  try {
    if (!(await validateBranchAccess(req, res))) return;
    const result = await serviceMethod(req.query);
    res.json(result);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: fallbackMessage });
  }
};

router.get(
  '/consumo-insumos',
  reportRoute(reporteService.getConsumoInsumos, 'No se pudo generar el reporte de consumo')
);
router.get(
  '/ranking-platos',
  reportRoute(reporteService.getRankingPlatos, 'No se pudo generar el ranking de platos')
);
router.get(
  '/comprobantes-sunat',
  reportRoute(reporteService.getComprobantesSunat, 'No se pudo generar el reporte SUNAT')
);
router.get(
  '/ventas-metodo-pago',
  reportRoute(reporteService.getVentasPorMetodoPago, 'No se pudo generar el reporte de métodos de pago')
);

module.exports = router;
