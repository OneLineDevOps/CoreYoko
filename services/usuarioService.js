'use strict';
const bcrypt = require('bcryptjs');
const db = require('../models/db');

const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10', 10);

function normalizeUser(data = {}) {
  return {
    nombre: data.nombre ? String(data.nombre).trim() : '',
    apellido: data.apellido ? String(data.apellido).trim() : null,
    usuario: data.usuario ? String(data.usuario).trim() : '',
    correo: data.correo ? String(data.correo).trim() : null,
    restaurante_id: data.restaurante_id || null,
    activo: data.activo === undefined ? 1 : Number(Boolean(data.activo)),
  };
}

async function getRoles() {
  const [rows] = await db.query('SELECT id, nombre, descripcion FROM roles ORDER BY id');
  return rows || [];
}

async function getUserRoles(userId) {
  const [rows] = await db.query(
    `SELECT r.id, r.nombre, r.descripcion
     FROM usuario_roles ur
     JOIN roles r ON r.id = ur.rol_id
     WHERE ur.usuario_id = ?
     ORDER BY r.id`,
    [userId]
  );
  return rows || [];
}

async function attachRoles(users) {
  const list = Array.isArray(users) ? users : [users];
  await Promise.all(list.map(async (user) => {
    user.roles = await getUserRoles(user.id);
  }));
  return users;
}

async function list({ includeInactive = true, restauranteId = null } = {}) {
  const filters = [];
  const params = [];
  if (!includeInactive) filters.push('u.activo = 1');
  if (restauranteId) {
    filters.push('u.restaurante_id = ?');
    params.push(restauranteId);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const [rows] = await db.query(
    `SELECT
       u.id, u.nombre, u.apellido, u.usuario, u.correo, u.restaurante_id, u.activo,
       u.fecha_creacion, u.fecha_actualizacion,
       r.nombre AS restaurante_nombre
     FROM usuarios u
     LEFT JOIN restaurantes r ON r.id = u.restaurante_id
     ${where}
     ORDER BY u.id DESC`,
    params
  );
  return attachRoles(rows || []);
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT
       u.id, u.nombre, u.apellido, u.usuario, u.correo, u.restaurante_id, u.activo,
       u.fecha_creacion, u.fecha_actualizacion,
       r.nombre AS restaurante_nombre
     FROM usuarios u
     LEFT JOIN restaurantes r ON r.id = u.restaurante_id
     WHERE u.id = ?
     LIMIT 1`,
    [id]
  );
  if (!rows || !rows.length) return null;
  return attachRoles(rows[0]);
}

async function setRoles(userId, roleIds = [], conn = db.pool) {
  await conn.execute('DELETE FROM usuario_roles WHERE usuario_id = ?', [userId]);
  const uniqueIds = [...new Set((roleIds || []).map((id) => Number(id)).filter(Boolean))];
  for (const roleId of uniqueIds) {
    await conn.execute('INSERT INTO usuario_roles (usuario_id, rol_id) VALUES (?, ?)', [userId, roleId]);
  }
}

async function create(data) {
  const payload = normalizeUser(data);
  if (!payload.nombre || !payload.usuario || !data.password) {
    const err = new Error('nombre, usuario y password son requeridos');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (String(data.password).length < 6) {
    const err = new Error('password debe tener al menos 6 caracteres');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const passwordHash = await bcrypt.hash(String(data.password), SALT_ROUNDS);
    const [res] = await conn.execute(
      `INSERT INTO usuarios (nombre, apellido, usuario, correo, password_hash, restaurante_id, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [payload.nombre, payload.apellido, payload.usuario, payload.correo, passwordHash, payload.restaurante_id, payload.activo]
    );
    await setRoles(res.insertId, data.role_ids || [], conn);
    await conn.commit();
    return getById(res.insertId);
  } catch (err) {
    await conn.rollback();
    if (err && err.code === 'ER_DUP_ENTRY') {
      const dup = new Error('usuario o correo ya existe');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function update(id, data) {
  const current = await getById(id);
  if (!current) return null;
  const payload = normalizeUser({ ...current, ...data });
  if (!payload.nombre || !payload.usuario) {
    const err = new Error('nombre y usuario son requeridos');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE usuarios
       SET nombre = ?, apellido = ?, usuario = ?, correo = ?, restaurante_id = ?, activo = ?
       WHERE id = ?`,
      [payload.nombre, payload.apellido, payload.usuario, payload.correo, payload.restaurante_id, payload.activo, id]
    );
    if (Array.isArray(data.role_ids)) await setRoles(id, data.role_ids, conn);
    await conn.commit();
    return getById(id);
  } catch (err) {
    await conn.rollback();
    if (err && err.code === 'ER_DUP_ENTRY') {
      const dup = new Error('usuario o correo ya existe');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function resetPassword(id, password) {
  const current = await getById(id);
  if (!current) return null;
  if (!password || String(password).length < 6) {
    const err = new Error('password debe tener al menos 6 caracteres');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);
  await db.pool.execute('UPDATE usuarios SET password_hash = ? WHERE id = ?', [passwordHash, id]);
  return { id: Number(id), reset: true };
}

async function remove(id) {
  const current = await getById(id);
  if (!current) return null;
  await db.pool.execute('UPDATE usuarios SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = { list, getById, create, update, resetPassword, remove, getRoles };
