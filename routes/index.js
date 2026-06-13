const express = require('express');
const router = express.Router();

const restaurants = require('./restaurants');
const pedidos = require('./pedidos');
const auth = require('./auth');
const sucursales = require('./sucursales');
const secciones = require('./secciones');
const mesas = require('./mesas');
const categorias = require('./categorias');
const productos = require('./productos');
const productoPrecios = require('./producto_precios');

router.use('/restaurants', restaurants);
router.use('/pedidos', pedidos);
router.use('/auth', auth);
router.use('/sucursales', sucursales);
router.use('/secciones', secciones);
router.use('/mesas', mesas);
router.use('/categorias', categorias);
router.use('/productos', productos);
router.use('/producto_precios', productoPrecios);

module.exports = router;
