'use strict';
const db = require('../models/db');

function normalizePayload(data = {}) {
  return {
    nombre: data.nombre ? String(data.nombre).trim() : '',
    ruc: data.ruc ? String(data.ruc).trim() : null,
    direccion: data.direccion ? String(data.direccion).trim() : null,
    telefono: data.telefono ? String(data.telefono).trim() : null,
    activo: data.activo === undefined ? 1 : Number(Boolean(data.activo)),
  };
}

async function getAll({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE r.activo = 1';
  const [rows] = await db.query(
    `SELECT
       r.*,
       COUNT(s.id) AS sucursales_count
     FROM restaurantes r
     LEFT JOIN sucursales s ON s.restaurante_id = r.id AND s.activo = 1
     ${where}
     GROUP BY r.id
     ORDER BY r.id DESC`
  );
  return rows || [];
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT
       r.*,
       COUNT(s.id) AS sucursales_count
     FROM restaurantes r
     LEFT JOIN sucursales s ON s.restaurante_id = r.id AND s.activo = 1
     WHERE r.id = ?
     GROUP BY r.id
     LIMIT 1`,
    [id]
  );
  return rows && rows.length ? rows[0] : null;
}

async function create(data) {
  const payload = normalizePayload(data);
  if (!payload.nombre) {
    const err = new Error('nombre is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const [res] = await db.pool.execute(
    `INSERT INTO restaurantes (nombre, ruc, direccion, telefono, activo)
     VALUES (?, ?, ?, ?, ?)`,
    [payload.nombre, payload.ruc, payload.direccion, payload.telefono, payload.activo]
  );
  return getById(res.insertId);
}

async function update(id, data) {
  const current = await getById(id);
  if (!current) return null;

  const payload = normalizePayload({ ...current, ...data });
  if (!payload.nombre) {
    const err = new Error('nombre is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  await db.pool.execute(
    `UPDATE restaurantes
     SET nombre = ?, ruc = ?, direccion = ?, telefono = ?, activo = ?
     WHERE id = ?`,
    [payload.nombre, payload.ruc, payload.direccion, payload.telefono, payload.activo, id]
  );
  return getById(id);
}

async function remove(id) {
  const current = await getById(id);
  if (!current) return null;
  await db.pool.execute('UPDATE restaurantes SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = { getAll, getById, create, update, remove };
