const express = require('express');
const router = express.Router();
const usuarioService = require('../services/usuarioService');
const restaurantService = require('../services/restaurantService');
const auth = require('../middleware/authMiddleware');
const { requireRoles } = require('../middleware/roleMiddleware');

router.use(auth);
router.use(requireRoles(['ROOT', 'ADMINISTRADOR']));

function isRoot(req) {
  return (req.user?.role_names || []).includes('ROOT');
}

function localRestaurantId(req) {
  return isRoot(req) ? null : Number(req.user?.restaurante_id || 0);
}

async function canManageUser(req, userId) {
  if (isRoot(req)) return true;
  const restauranteId = localRestaurantId(req);
  if (!restauranteId) return false;
  const user = await usuarioService.getById(userId);
  return Boolean(user && Number(user.restaurante_id) === restauranteId);
}

async function localRoleIds(req, requestedIds = []) {
  if (isRoot(req)) return requestedIds;
  const roles = await usuarioService.getRoles();
  const allowed = new Set(
    roles
      .filter((role) => String(role.nombre).toUpperCase() !== 'ROOT')
      .map((role) => Number(role.id))
  );
  return (requestedIds || []).map(Number).filter((id) => allowed.has(id));
}

router.get('/meta', async (req, res) => {
  try {
    let [roles, restaurantes] = await Promise.all([
      usuarioService.getRoles(),
      restaurantService.getAll({ includeInactive: false }),
    ]);
    if (!isRoot(req) || req.query.local === '1') {
      const restauranteId = localRestaurantId(req) || Number(req.query.restaurante_id || 0);
      roles = roles.filter((role) => String(role.nombre).toUpperCase() !== 'ROOT');
      restaurantes = restaurantes.filter((restaurant) => Number(restaurant.id) === restauranteId);
    }
    res.json({ roles, restaurantes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/', async (req, res) => {
  try {
    if (!isRoot(req) && !localRestaurantId(req)) {
      return res.status(400).json({ error: 'El administrador no tiene restaurante asignado' });
    }
    const includeInactive = req.query.include_inactive === '1' || req.query.includeInactive === 'true';
    const requestedRestaurantId = isRoot(req) ? Number(req.query.restaurante_id || 0) : 0;
    const rows = await usuarioService.list({
      includeInactive,
      restauranteId: localRestaurantId(req) || requestedRestaurantId || null,
    });
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    if (!(await canManageUser(req, req.params.id))) {
      return res.status(403).json({ error: 'No puede administrar usuarios de otro restaurante' });
    }
    const row = await usuarioService.getById(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const restauranteId = localRestaurantId(req);
    if (!isRoot(req) && !restauranteId) {
      return res.status(400).json({ error: 'El administrador no tiene restaurante asignado' });
    }
    const created = await usuarioService.create({
      ...req.body,
      restaurante_id: restauranteId || req.body.restaurante_id,
      role_ids: await localRoleIds(req, req.body.role_ids),
    });
    res.status(201).json(created);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (!(await canManageUser(req, req.params.id))) {
      return res.status(403).json({ error: 'No puede administrar usuarios de otro restaurante' });
    }
    if (
      Number(req.params.id) === Number(req.user?.id)
      && (req.body.activo === 0 || req.body.activo === false)
    ) {
      return res.status(400).json({ error: 'No puede desactivar su propio usuario' });
    }
    const restauranteId = localRestaurantId(req);
    const updated = await usuarioService.update(req.params.id, {
      ...req.body,
      ...(restauranteId ? { restaurante_id: restauranteId } : {}),
      ...(Array.isArray(req.body.role_ids)
        ? { role_ids: await localRoleIds(req, req.body.role_ids) }
        : {}),
    });
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    if (err.code === 'DUPLICATE') return res.status(409).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/reset-password', async (req, res) => {
  try {
    if (!(await canManageUser(req, req.params.id))) {
      return res.status(403).json({ error: 'No puede administrar usuarios de otro restaurante' });
    }
    const result = await usuarioService.resetPassword(req.params.id, req.body.password);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    if (err.code === 'INVALID_INPUT') return res.status(400).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    if (Number(req.params.id) === Number(req.user?.id)) {
      return res.status(400).json({ error: 'No puede desactivar su propio usuario' });
    }
    if (!(await canManageUser(req, req.params.id))) {
      return res.status(403).json({ error: 'No puede administrar usuarios de otro restaurante' });
    }
    const result = await usuarioService.remove(req.params.id);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
