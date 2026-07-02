const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pedidoController');
const optionalAuth = require('../middleware/optionalAuthMiddleware');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

router.post('/', optionalAuth, ctrl.create);
router.post(
  '/:id/items',
  auth,
  requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO', 'MOZO']),
  ctrl.appendItems
);
router.post(
  '/:id/precuenta',
  auth,
  requireRoles(['ROOT', 'ADMINISTRADOR', 'CAJERO', 'MOZO']),
  ctrl.printPrecuenta
);
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.patch('/:id/estado', optionalAuth, ctrl.updateEstado);
router.delete(
  '/:id',
  auth,
  requireRoles(['ROOT', 'ADMINISTRADOR']),
  ctrl.remove
);

module.exports = router;
