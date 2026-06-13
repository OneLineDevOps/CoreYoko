'use strict';
const db = require('../models/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const SALT_ROUNDS = parseInt(process.env.SALT_ROUNDS || '10', 10);

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

  const [rows] = await db.query(`SELECT * FROM usuarios WHERE (usuario = ?) LIMIT 1`, [username, username]);
  if (!rows || rows.length === 0) {
    const e = new Error('Credenciales inválidas');
    e.code = 'INVALID_CREDENTIALS';
    throw e;
  }

  const user = rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const e = new Error('Credenciales inválidas');
    e.code = 'INVALID_CREDENTIALS';
    throw e;
  }

  const payload = { sub: user.id, usuario: user.usuario, nombre: user.nombre, restaurante_id: user.restaurante_id };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  return { token, user: { id: user.id, nombre: user.nombre, apellido: user.apellido, usuario: user.usuario, restaurante_id: user.restaurante_id, activo: user.activo } };
}

async function verifyToken(token) {
  try {
    const data = jwt.verify(token, JWT_SECRET);
    const [rows] = await db.query(`SELECT id, nombre, apellido, usuario, restaurante_id, activo FROM usuarios WHERE id = ? LIMIT 1`, [data.sub]);
    if (!rows || rows.length === 0) return null;
    return rows[0];
  } catch (err) {
    return null;
  }
}

module.exports = { register, login, verifyToken };
