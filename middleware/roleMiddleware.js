'use strict';

function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

function requireRoles(allowedRoles = []) {
  const allowed = new Set(allowedRoles.map(normalizeRole).filter(Boolean));
  return (req, res, next) => {
    const userRoles = [
      ...(req.user?.role_names || []),
      ...(req.user?.roles || []).map((role) => role?.nombre || role),
      req.user?.role,
    ].map(normalizeRole).filter(Boolean);

    if (userRoles.some((role) => allowed.has(role))) return next();
    return res.status(403).json({ error: 'Acceso restringido' });
  };
}

module.exports = { requireRoles };
