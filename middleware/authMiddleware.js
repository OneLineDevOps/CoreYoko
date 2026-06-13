'use strict';
const authService = require('../services/authService');

module.exports = async function (req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return res.status(401).json({ error: 'Invalid token format' });
  const token = parts[1];
  const user = await authService.verifyToken(token);
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
};
