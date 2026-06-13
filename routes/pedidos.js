const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/pedidoController');

router.post('/', ctrl.create);
router.get('/', ctrl.list);
router.get('/:id', ctrl.getById);
router.patch('/:id/estado', ctrl.updateEstado);

module.exports = router;
