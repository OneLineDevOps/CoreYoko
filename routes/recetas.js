'use strict';

const express = require('express');
const recetaService = require('../services/recetaService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

const router = express.Router();
router.use(auth);
router.use(requireRoles(['ROOT', 'ADMINISTRADOR']));

const accessFor = (req) => ({
  restauranteId: req.user?.restaurante_id,
  isRoot: (req.user?.role_names || []).includes('ROOT'),
});

router.get('/productos/:productoId', async (req, res) => {
  try {
    const result = await recetaService.getProductRecipe(req.params.productoId, accessFor(req));
    if (!result) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'No se pudo cargar la receta' });
  }
});

router.put('/productos/:productoId', async (req, res) => {
  try {
    const result = await recetaService.saveProductRecipe(
      req.params.productoId,
      req.body?.items,
      accessFor(req)
    );
    if (!result) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(result);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'No se pudo guardar la receta' });
  }
});

router.post('/ingredientes', async (req, res) => {
  try {
    const result = await recetaService.createIngredient(req.body, accessFor(req));
    if (!result) return res.status(404).json({ error: 'Producto no encontrado' });
    res.status(201).json(result);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'No se pudo crear el insumo' });
  }
});

router.put('/ingredientes/:id', async (req, res) => {
  try {
    const result = await recetaService.updateIngredient(req.params.id, req.body, accessFor(req));
    if (!result) return res.status(404).json({ error: 'Insumo no encontrado' });
    res.json(result);
  } catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'No se pudo actualizar el insumo' });
  }
});

module.exports = router;
