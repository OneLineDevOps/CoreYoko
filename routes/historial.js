const express = require('express');
const router = express.Router();
const historialService = require('../services/historialService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');
const sucursalService = require('../services/sucursalService');

router.use(auth);
router.use(requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO']));

router.get('/', async (req, res) => {
  try {
    if (!req.query.sucursal_id) {
      return res.status(400).json({ error: 'sucursal_id is required' });
    }
    const branch = await sucursalService.getById(req.query.sucursal_id);
    const isRoot = (req.user?.role_names || []).includes('ROOT');
    if (!branch) return res.status(404).json({ error: 'Sucursal no encontrada' });
    if (!isRoot && Number(branch.restaurante_id) !== Number(req.user?.restaurante_id)) {
      return res.status(403).json({ error: 'Sucursal fuera de su restaurante' });
    }
    const data = await historialService.getHistorial(req.query);
    res.json(data);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
