"use strict";
const db = require('../models/db');

// Fallback en memoria
const _fallback = {
  categorias: [
    { id: 1, nombre: 'Entradas', descripcion: 'Entradas y aperitivos', activo: 1 },
    { id: 2, nombre: 'Platos Principales', descripcion: 'Platos fuertes', activo: 1 }
  ],
  nextId: 3
};

async function getAll() {
  try {
    const [rows] = await db.query('SELECT * FROM categorias WHERE activo = 1');
    return rows;
  } catch (err) {
    return _fallback.categorias.filter(c => c.activo === 1);
  }
}

async function getById(id) {
  try {
    const [rows] = await db.query('SELECT * FROM categorias WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.categorias.find(c => Number(c.id) === Number(id)) || null;
  }
}

async function create({ nombre, descripcion }) {
  try {
    const [res] = await db.pool.execute('INSERT INTO categorias (nombre, descripcion, activo) VALUES (?, ?, 1)', [nombre, descripcion || null]);
    return { id: res.insertId, nombre, descripcion };
  } catch (err) {
    const id = _fallback.nextId++;
    const c = { id, nombre, descripcion: descripcion || null, activo: 1 };
    _fallback.categorias.push(c);
    return c;
  }
}

async function update(id, { nombre, descripcion, activo }) {
  try {
    const pNombre = nombre !== undefined ? nombre : null;
    const pDescripcion = descripcion !== undefined ? descripcion : null;
    const pActivo = activo !== undefined ? activo : null;
    await db.pool.execute('UPDATE categorias SET nombre = COALESCE(?, nombre), descripcion = COALESCE(?, descripcion), activo = COALESCE(?, activo) WHERE id = ?', [pNombre, pDescripcion, pActivo, id]);
    return await getById(id);
  } catch (err) {
    const c = _fallback.categorias.find(x => Number(x.id) === Number(id));
    if (!c) return null;
    if (nombre !== undefined) c.nombre = nombre;
    if (descripcion !== undefined) c.descripcion = descripcion;
    if (activo !== undefined) c.activo = activo;
    return c;
  }
}

async function remove(id) {
  try {
    await db.pool.execute('UPDATE categorias SET activo = 0 WHERE id = ?', [id]);
    return { id: Number(id), deleted: true };
  } catch (err) {
    const c = _fallback.categorias.find(x => Number(x.id) === Number(id));
    if (!c) return null;
    c.activo = 0;
    return { id: Number(id), deleted: true };
  }
}

module.exports = { getAll, getById, create, update, remove };
