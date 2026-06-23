"use strict";
const db = require('../models/db');

// Fallback en memoria para entornos sin DB accesible
const _fallback = {
  sucursales: [
    { id: 1, restaurante_id: 1, codigo: 'DEMO', nombre: 'Sucursal Demo', direccion: null, telefono: null, activo: 1 }
  ],
  nextSucursalId: 2
};

function normalizePayload(data = {}) {
  return {
    restaurante_id: data.restaurante_id,
    codigo: data.codigo ? String(data.codigo).trim().toUpperCase() : null,
    nombre: data.nombre ? String(data.nombre).trim() : '',
    direccion: data.direccion ? String(data.direccion).trim() : null,
    telefono: data.telefono ? String(data.telefono).trim() : null,
    activo: data.activo === undefined ? 1 : Number(Boolean(data.activo)),
  };
}

async function getByRestaurant(restaurante_id, { includeInactive = false } = {}) {
  if (!restaurante_id) return [];
  try {
    const whereActivo = includeInactive ? '' : 'AND activo = 1';
    const [rows] = await db.query(
      `SELECT * FROM sucursales WHERE restaurante_id = ? ${whereActivo} ORDER BY id`,
      [restaurante_id]
    );
    return rows;
  } catch (err) {
    // fallback
    return _fallback.sucursales.filter(s => Number(s.restaurante_id) === Number(restaurante_id) && s.activo === 1);
  }
}

async function getById(id) {
  try {
    const [rows] = await db.query('SELECT * FROM sucursales WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.sucursales.find(s => Number(s.id) === Number(id)) || null;
  }
}

async function getByCode(code) {
  const normalized = code ? String(code).trim().toUpperCase() : '';
  if (!normalized) return null;
  try {
    const [rows] = await db.query('SELECT * FROM sucursales WHERE UPPER(codigo) = ? AND activo = 1 LIMIT 1', [normalized]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.sucursales.find(s => String(s.codigo || '').toUpperCase() === normalized && s.activo === 1) || null;
  }
}

async function create(data) {
  const payload = normalizePayload(data);
  if (!payload.restaurante_id || !payload.nombre) {
    const err = new Error('restaurante_id and nombre are required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  try {
    const [res] = await db.pool.execute(
      'INSERT INTO sucursales (restaurante_id, codigo, nombre, direccion, telefono, activo) VALUES (?, ?, ?, ?, ?, ?)',
      [payload.restaurante_id, payload.codigo, payload.nombre, payload.direccion, payload.telefono, payload.activo]
    );
    return await getById(res.insertId);
  } catch (err) {
    const id = _fallback.nextSucursalId++;
    const s = { id, ...payload };
    _fallback.sucursales.push(s);
    return s;
  }
}

async function update(id, data) {
  const current = await getById(id);
  if (!current) return null;

  const payload = normalizePayload({ ...current, ...data });
  if (!payload.restaurante_id || !payload.nombre) {
    const err = new Error('restaurante_id and nombre are required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  await db.pool.execute(
    `UPDATE sucursales
     SET restaurante_id = ?, codigo = ?, nombre = ?, direccion = ?, telefono = ?, activo = ?
     WHERE id = ?`,
    [payload.restaurante_id, payload.codigo, payload.nombre, payload.direccion, payload.telefono, payload.activo, id]
  );
  return getById(id);
}

async function remove(id) {
  const current = await getById(id);
  if (!current) return null;
  await db.pool.execute('UPDATE sucursales SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = { getByRestaurant, getById, getByCode, create, update, remove };
