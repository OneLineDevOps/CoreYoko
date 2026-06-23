const express = require('express');
const router = express.Router();
const historialService = require('../services/historialService');
const auth = require('../middleware/authMiddleware');

router.use(auth);

router.get('/', async (req, res) => {
  try {
    const data = await historialService.getHistorial(req.query);
    res.json(data);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
