"use strict";
const db = require('../models/db');

// Fallback en memoria para entornos sin DB accesible
const _fallback = {
  sucursales: [
    { id: 1, restaurante_id: 1, nombre: 'Sucursal Demo', direccion: null, telefono: null, activo: 1 }
  ],
  nextSucursalId: 2
};

async function getByRestaurant(restaurante_id) {
  if (!restaurante_id) return [];
  try {
    const [rows] = await db.query(
      'SELECT * FROM sucursales WHERE restaurante_id = ? AND activo = 1',
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

async function create({ restaurante_id, nombre, direccion, telefono }) {
  try {
    const [res] = await db.pool.execute(
      'INSERT INTO sucursales (restaurante_id, nombre, direccion, telefono, activo) VALUES (?, ?, ?, ?, 1)',
      [restaurante_id, nombre, direccion || null, telefono || null]
    );
    return { id: res.insertId, restaurante_id, nombre, direccion, telefono };
  } catch (err) {
    const id = _fallback.nextSucursalId++;
    const s = { id, restaurante_id, nombre, direccion: direccion || null, telefono: telefono || null, activo: 1 };
    _fallback.sucursales.push(s);
    return s;
  }
}

module.exports = { getByRestaurant, getById, create };
