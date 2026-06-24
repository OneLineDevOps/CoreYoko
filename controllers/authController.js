'use strict';
const authService = require('../services/authService');

async function register(req, res) {
  try {
    const payload = req.body;
    const created = await authService.register(payload);
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function login(req, res) {
  try {
    const { username, password } = req.body;
    const result = await authService.login({ username, password });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return res.status(401).json({ error: 'Credenciales inválidas' });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function me(req, res) {
  res.json(req.user || null);
}

async function updateMe(req, res) {
  try {
    const result = await authService.updateProfile(req.user.id, req.body);
    if (!result) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result);
  } catch (err) {
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function changePassword(req, res) {
  try {
    const result = await authService.changePassword(
      req.user.id,
      req.body.current_password,
      req.body.new_password
    );
    if (!result) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_CREDENTIALS') return res.status(400).json({ error: err.message });
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { register, login, me, updateMe, changePassword };
