"use strict";
const db = require('../models/db');

// Fallback en memoria
const _fallback = {
  mesas: [
    { id: 1, seccion_id: 1, codigo: 'M01', capacidad: 4, estado: 'LIBRE', activo: 1 }
  ],
  nextMesaId: 2
};

async function getBySeccion(seccion_id) {
  if (!seccion_id) return [];
  try {
    const [rows] = await db.query('SELECT * FROM mesas WHERE seccion_id = ? AND activo = 1', [seccion_id]);
    return rows;
  } catch (err) {
    return _fallback.mesas.filter(m => Number(m.seccion_id) === Number(seccion_id) && m.activo === 1);
  }
}

async function getBySucursal(sucursal_id) {
  if (!sucursal_id) return [];
  try {
    const [rows] = await db.query(
      `SELECT m.* FROM mesas m
       JOIN secciones_mesa s ON m.seccion_id = s.id
       WHERE s.sucursal_id = ? AND m.activo = 1`,
      [sucursal_id]
    );
    return rows;
  } catch (err) {
    // fallback: unir mesas con secciones en memoria
    const secciones = require('./seccionService').getBySucursal;
    // getBySucursal may return a promise or array; handle
    try {
      const secs = await secciones(sucursal_id);
      const secIds = (secs || []).map(s => s.id);
      return _fallback.mesas.filter(m => secIds.includes(m.seccion_id) && m.activo === 1);
    } catch (e) {
      return [];
    }
  }
}

async function create({ seccion_id, codigo, capacidad }) {
  try {
    const [res] = await db.pool.execute(
      'INSERT INTO mesas (seccion_id, codigo, capacidad, estado, activo) VALUES (?, ?, ?, "LIBRE", 1)',
      [seccion_id || null, codigo, capacidad || 4]
    );
    return { id: res.insertId, seccion_id, codigo, capacidad };
  } catch (err) {
    const id = _fallback.nextMesaId++;
    const m = { id, seccion_id: seccion_id || null, codigo, capacidad: capacidad || 4, estado: 'LIBRE', activo: 1 };
    _fallback.mesas.push(m);
    return m;
  }
}
async function getById(id) {
  try {
    const [rows] = await db.query('SELECT * FROM mesas WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.mesas.find(m => Number(m.id) === Number(id)) || null;
  }
}

async function update(id, { seccion_id, codigo, capacidad, estado, activo }) {
  try {
    // Use SQL COALESCE to preserve column values when parameter is NULL/undefined
    const pCodigo = codigo !== undefined ? codigo : null;
    const pCapacidad = capacidad !== undefined ? capacidad : null;
    const pEstado = estado !== undefined ? estado : null;
    const pActivo = activo !== undefined ? activo : null;

    if (seccion_id !== undefined) {
      // cambiar también la sucursal
      await db.pool.execute(
        `UPDATE mesas SET seccion_id = ?, codigo = COALESCE(?, codigo), capacidad = COALESCE(?, capacidad), estado = COALESCE(?, estado), activo = COALESCE(?, activo) WHERE id = ?`,
        [seccion_id, pCodigo, pCapacidad, pEstado, pActivo, id]
      );
    } else {
      // no tocar seccion_id
      await db.pool.execute(
        `UPDATE mesas SET codigo = COALESCE(?, codigo), capacidad = COALESCE(?, capacidad), estado = COALESCE(?, estado), activo = COALESCE(?, activo) WHERE id = ?`,
        [pCodigo, pCapacidad, pEstado, pActivo, id]
      );
    }
    return await getById(id);
  } catch (err) {
    const m = _fallback.mesas.find(x => Number(x.id) === Number(id));
    if (!m) return null;
    if (seccion_id !== undefined) m.seccion_id = seccion_id;
    if (codigo !== undefined) m.codigo = codigo;
    if (capacidad !== undefined) m.capacidad = capacidad;
    if (estado !== undefined) m.estado = estado;
    if (activo !== undefined) m.activo = activo;
    return m;
  }
}

async function remove(id) {
  try {
    await db.pool.execute('UPDATE mesas SET activo = 0 WHERE id = ?', [id]);
    return { id: Number(id), deleted: true };
  } catch (err) {
    const m = _fallback.mesas.find(x => Number(x.id) === Number(id));
    if (!m) return null;
    m.activo = 0;
    return { id: Number(id), deleted: true };
  }
}

module.exports = { getBySeccion, getBySucursal, create, getById, update, remove };
