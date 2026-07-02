const express = require('express');
const router = express.Router();
const clienteService = require('../services/clienteService');
const auth = require('../middleware/authMiddleware');

router.use(auth);

router.get('/by-document', async (req, res) => {
  try {
    const numero = req.query.numero_documento || req.query.numero;
    const tipo = req.query.tipo_documento || req.query.tipo;
    const externalLookup = req.query.consulta_externa !== '0';
    const row = externalLookup
      ? await clienteService.findOrCreateByDocument(tipo, numero)
      : await clienteService.findByDocument(numero);
    res.json(row);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    const rows = await clienteService.search(req.query.q || '');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await clienteService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const created = await clienteService.create(req.body);
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const updated = await clienteService.update(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
