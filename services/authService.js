'use strict';
const db = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10', 10);

async function getUserRoles(userId) {
  const [rows] = await db.query(
    `SELECT r.id, r.nombre
     FROM usuario_roles ur
     JOIN roles r ON r.id = ur.rol_id
     WHERE ur.usuario_id = ?
     ORDER BY r.id`,
    [userId]
  );
  return (rows || []).map((r) => ({
    id: r.id,
    nombre: String(r.nombre || '').trim().toUpperCase()
  })).filter((r) => r.nombre);
}

function publicUser(user, roles = []) {
  return {
    id: user.id,
    nombre: user.nombre,
    apellido: user.apellido,
    usuario: user.usuario,
    correo: user.correo,
    restaurante_id: user.restaurante_id,
    activo: user.activo,
    roles
  };
}

function signUserToken(user, roles) {
  const roleNames = roles.map((r) => r.nombre);
  return jwt.sign({
    sub: user.id,
    usuario: user.usuario,
    nombre: user.nombre,
    apellido: user.apellido,
    correo: user.correo,
    restaurante_id: user.restaurante_id,
    roles: roleNames,
    role: roleNames[0] || null
  }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function register({ nombre, apellido, usuario, correo, password }) {
  if (!nombre || !usuario || !password) {
    const e = new Error('nombre, usuario y password son requeridos');
    e.code = 'INVALID_INPUT';
    throw e;
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  try {
    const [res] = await db.pool.execute(
      `INSERT INTO usuarios (nombre, apellido, usuario, correo, password_hash) VALUES (?, ?, ?, ?, ?)`,
      [nombre, apellido || null, usuario, correo || null, password_hash]
    );
    return { id: res.insertId, nombre, apellido, usuario, correo };
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const dup = new Error('usuario o correo ya existe');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    logger.error('auth.register error', err);
    throw err;
  }
}

async function login({ username, password }) {
  if (!username || !password) {
    const e = new Error('username  y password son requeridos');
    e.code = 'INVALID_INPUT';
    throw e;
  }

  const [rows] = await db.query(`SELECT * FROM usuarios WHERE usuario = ? LIMIT 1`, [username]);
  if (!rows || rows.length === 0) {
    const e = new Error('Credenciales inválidas');
    e.code = 'INVALID_CREDENTIALS';
    throw e;
  }

  const user = rows[0];
  if (!user.activo) {
    const e = new Error('Credenciales inválidas');
    e.code = 'INVALID_CREDENTIALS';
    throw e;
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const e = new Error('Credenciales inválidas');
    e.code = 'INVALID_CREDENTIALS';
    throw e;
  }

  const roles = await getUserRoles(user.id);
  const token = signUserToken(user, roles);
  return { token, user: publicUser(user, roles) };
}

async function verifyToken(token) {
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const [rows] = await db.query(`SELECT id, nombre, apellido, usuario, correo, restaurante_id, activo FROM usuarios WHERE id = ? LIMIT 1`, [data.sub]);
    if (!rows || rows.length === 0) return null;
    const user = rows[0];
    if (!user.activo) return null;
    const roles = await getUserRoles(user.id);
    return { ...user, roles, role_names: roles.map((r) => r.nombre) };
  } catch (err) {
    return null;
  }
}

async function updateProfile(userId, data = {}) {
  const nombre = data.nombre ? String(data.nombre).trim() : '';
  const apellido = data.apellido ? String(data.apellido).trim() : null;
  const usuario = data.usuario ? String(data.usuario).trim() : '';
  const correo = data.correo ? String(data.correo).trim() : null;

  if (!nombre || !usuario) {
    const err = new Error('nombre y usuario son requeridos');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  try {
    await db.pool.execute(
      `UPDATE usuarios
       SET nombre = ?, apellido = ?, usuario = ?, correo = ?
       WHERE id = ? AND activo = 1`,
      [nombre, apellido, usuario, correo, userId]
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const dup = new Error('usuario o correo ya existe');
      dup.code = 'DUPLICATE';
      throw dup;
    }
    throw err;
  }

  const [rows] = await db.query(
    `SELECT id, nombre, apellido, usuario, correo, restaurante_id, activo
     FROM usuarios WHERE id = ? AND activo = 1 LIMIT 1`,
    [userId]
  );
  if (!rows || !rows.length) return null;
  const user = rows[0];
  const roles = await getUserRoles(user.id);
  return { token: signUserToken(user, roles), user: publicUser(user, roles) };
}

async function changePassword(userId, currentPassword, newPassword) {
  if (!currentPassword || !newPassword) {
    const err = new Error('contraseña actual y nueva contraseña son requeridas');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (String(newPassword).length < 6) {
    const err = new Error('la nueva contraseña debe tener al menos 6 caracteres');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (String(currentPassword) === String(newPassword)) {
    const err = new Error('la nueva contraseña debe ser diferente a la actual');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const [rows] = await db.query(
    'SELECT id, password_hash FROM usuarios WHERE id = ? AND activo = 1 LIMIT 1',
    [userId]
  );
  if (!rows || !rows.length) return null;

  const matches = await bcrypt.compare(String(currentPassword), rows[0].password_hash);
  if (!matches) {
    const err = new Error('la contraseña actual no es correcta');
    err.code = 'INVALID_CREDENTIALS';
    throw err;
  }

  const passwordHash = await bcrypt.hash(String(newPassword), SALT_ROUNDS);
  await db.pool.execute('UPDATE usuarios SET password_hash = ? WHERE id = ?', [passwordHash, userId]);
  return { changed: true };
}

module.exports = {
  register,
  login,
  verifyToken,
  getUserRoles,
  updateProfile,
  changePassword
};
