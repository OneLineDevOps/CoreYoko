const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pedidoController');
const optionalAuth = require('../middleware/optionalAuthMiddleware');

router.post('/', optionalAuth, ctrl.create);
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.patch('/:id/estado', optionalAuth, ctrl.updateEstado);

module.exports = router;
