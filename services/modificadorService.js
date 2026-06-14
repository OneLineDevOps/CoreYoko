'use strict';
const db = require('../models/db');

async function getByProduct(producto_id) {
  if (!producto_id) return [];
  try {
    const [rows] = await db.query(
      `SELECT m.id as modificador_id, m.nombre as modificador_nombre, m.obligatorio, m.multiple, om.id as opcion_id, om.nombre as opcion_nombre, om.precio_adicional
       FROM modificadores m
       JOIN producto_modificadores pm ON pm.modificador_id = m.id
       JOIN opciones_modificador om ON om.modificador_id = m.id
       WHERE pm.producto_id = ? AND m.activo = 1`,
      [producto_id]
    );

    const map = {};
    (rows || []).forEach((r) => {
      const mid = r.modificador_id;
      if (!map[mid]) {
        map[mid] = { id: mid, nombre: r.modificador_nombre, obligatorio: !!r.obligatorio, multiple: !!r.multiple, opciones: [] };
      }
      map[mid].opciones.push({ id: r.opcion_id, nombre: r.opcion_nombre, precio_adicional: Number(r.precio_adicional || 0) });
    });

    return Object.values(map);
  } catch (err) {
    console.error('modificadorService.getByProduct error', err);
    return [];
  }
}

module.exports = { getByProduct };
