const express = require('express');
const router = express.Router();
const restaurantService = require('../services/restaurantService');

router.get('/', (req, res) => {
  res.json(restaurantService.getAll());
});

router.get('/:id', (req, res) => {
  const r = restaurantService.getById(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(r);
});

router.post('/', (req, res) => {
  const created = restaurantService.create(req.body);
  res.status(201).json(created);
});

module.exports = router;
