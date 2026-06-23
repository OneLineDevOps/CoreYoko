const express = require('express');
const router = express.Router();
const metodoPagoService = require('../services/metodoPagoService');

router.get('/', async (req, res) => {
  try {
    const rows = await metodoPagoService.listActivos();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
