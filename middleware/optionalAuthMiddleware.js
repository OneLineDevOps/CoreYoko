'use strict';
const authService = require('../services/authService');

module.exports = async function (req, _res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return next();

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return next();

  const user = await authService.verifyToken(parts[1]);
  if (user) req.user = user;
  next();
};
