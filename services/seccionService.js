"use strict";
const db = require('../models/db');

// Fallback en memoria
const _fallback = {
  secciones: [
    { id: 1, sucursal_id: 1, nombre: 'Principal', descripcion: null, activo: 1 }
  ],
  nextSeccionId: 2
};

async function getBySucursal(sucursal_id) {
  if (!sucursal_id) return [];
  try {
    const [rows] = await db.query(
      'SELECT * FROM secciones_mesa WHERE sucursal_id = ? AND activo = 1',
      [sucursal_id]
    );
    return rows;
  } catch (err) {
    return _fallback.secciones.filter(s => Number(s.sucursal_id) === Number(sucursal_id) && s.activo === 1);
  }
}

async function getById(id) {
  try {
    const [rows] = await db.query('SELECT * FROM secciones_mesa WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.secciones.find(s => Number(s.id) === Number(id)) || null;
  }
}

async function create({ sucursal_id, nombre, descripcion }) {
  try {
    const [res] = await db.pool.execute(
      'INSERT INTO secciones_mesa (sucursal_id, nombre, descripcion, activo) VALUES (?, ?, ?, 1)',
      [sucursal_id, nombre, descripcion || null]
    );
    return { id: res.insertId, sucursal_id, nombre, descripcion };
  } catch (err) {
    const id = _fallback.nextSeccionId++;
    const s = { id, sucursal_id, nombre, descripcion: descripcion || null, activo: 1 };
    _fallback.secciones.push(s);
    return s;
  }
}

async function update(id, { nombre, descripcion, activo }) {
  try {
    const pNombre = nombre !== undefined ? nombre : null;
    const pDescripcion = descripcion !== undefined ? descripcion : null;
    const pActivo = activo !== undefined ? activo : null;
    await db.pool.execute(
      'UPDATE secciones_mesa SET nombre = COALESCE(?, nombre), descripcion = COALESCE(?, descripcion), activo = COALESCE(?, activo) WHERE id = ?',
      [pNombre, pDescripcion, pActivo, id]
    );
    return await getById(id);
  } catch (err) {
    const s = _fallback.secciones.find(x => Number(x.id) === Number(id));
    if (!s) return null;
    if (nombre !== undefined) s.nombre = nombre;
    if (descripcion !== undefined) s.descripcion = descripcion;
    if (activo !== undefined) s.activo = activo;
    return s;
  }
}

async function remove(id) {
  try {
    await db.pool.execute('UPDATE secciones_mesa SET activo = 0 WHERE id = ?', [id]);
    return { id: Number(id), deleted: true };
  } catch (err) {
    const s = _fallback.secciones.find(x => Number(x.id) === Number(id));
    if (!s) return null;
    s.activo = 0;
    return { id: Number(id), deleted: true };
  }
}

module.exports = { getBySucursal, getById, create, update, remove };
