"use strict";
const db = require('../models/db');

function scope(access = {}) {
  return {
    isRoot: Boolean(access.isRoot),
    restauranteId: access.restauranteId ? Number(access.restauranteId) : null,
  };
}

function restaurantFilter(access, alias = 's') {
  const { isRoot, restauranteId } = scope(access);
  if (isRoot) return { sql: '', params: [] };
  if (!restauranteId) return { sql: ' AND 1 = 0', params: [] };
  return { sql: ` AND ${alias}.restaurante_id = ?`, params: [restauranteId] };
}

async function getCategory(id, access = {}) {
  const filter = restaurantFilter(access);
  const [rows] = await db.query(
    `SELECT c.id, c.carta_id
     FROM categorias c
     JOIN cartas ca ON ca.id = c.carta_id AND ca.activa = 1
     JOIN sucursales s ON s.id = ca.sucursal_id AND s.activo = 1
     WHERE c.id = ? AND c.activo = 1${filter.sql}
     LIMIT 1`,
    [id, ...filter.params]
  );
  return rows && rows.length ? rows[0] : null;
}

async function getByCategory(categoriaId, access = {}) {
  if (!categoriaId || !(await getCategory(categoriaId, access))) return [];
  const [rows] = await db.query(
    `SELECT id, categoria_id, codigo, nombre, descripcion, imagen, controla_stock, activo
     FROM productos
     WHERE categoria_id = ? AND activo = 1
     ORDER BY nombre, id`,
    [categoriaId]
  );
  return rows || [];
}

async function getById(id, access = {}) {
  const filter = restaurantFilter(access);
  const [rows] = await db.query(
    `SELECT p.id, p.categoria_id, p.codigo, p.nombre, p.descripcion, p.imagen,
            p.controla_stock, p.activo
     FROM productos p
     JOIN categorias c ON c.id = p.categoria_id
     JOIN cartas ca ON ca.id = c.carta_id AND ca.activa = 1
     JOIN sucursales s ON s.id = ca.sucursal_id AND s.activo = 1
     WHERE p.id = ?${filter.sql}
     LIMIT 1`,
    [id, ...filter.params]
  );
  return rows && rows.length ? rows[0] : null;
}

async function create({ categoria_id, codigo, nombre, descripcion, imagen, controla_stock }, access = {}) {
  if (!categoria_id || !nombre || !String(nombre).trim()) {
    const err = new Error('categoria_id y nombre son requeridos');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  if (!(await getCategory(categoria_id, access))) {
    const err = new Error('La categoría no pertenece al restaurante del usuario');
    err.code = 'FORBIDDEN';
    throw err;
  }
  const [result] = await db.pool.execute(
    `INSERT INTO productos
     (categoria_id, codigo, nombre, descripcion, imagen, controla_stock, activo)
     VALUES (?, ?, ?, ?, ?, ?, 1)`,
    [
      categoria_id,
      codigo ? String(codigo).trim() : null,
      String(nombre).trim(),
      descripcion ? String(descripcion).trim() : null,
      imagen ? String(imagen).trim() : null,
      controla_stock ? 1 : 0
    ]
  );
  return getById(result.insertId, access);
}

async function update(id, payload, access = {}) {
  const current = await getById(id, access);
  if (!current) return null;
  if (payload.categoria_id !== undefined && !(await getCategory(payload.categoria_id, access))) {
    const err = new Error('La categoría no pertenece al restaurante del usuario');
    err.code = 'FORBIDDEN';
    throw err;
  }
  await db.pool.execute(
    `UPDATE productos
     SET categoria_id = COALESCE(?, categoria_id),
         codigo = ?,
         nombre = COALESCE(?, nombre),
         descripcion = ?,
         imagen = ?,
         controla_stock = COALESCE(?, controla_stock),
         activo = COALESCE(?, activo)
     WHERE id = ?`,
    [
      payload.categoria_id !== undefined ? payload.categoria_id : null,
      payload.codigo !== undefined ? (payload.codigo ? String(payload.codigo).trim() : null) : current.codigo,
      payload.nombre !== undefined ? String(payload.nombre).trim() : null,
      payload.descripcion !== undefined ? (payload.descripcion ? String(payload.descripcion).trim() : null) : current.descripcion,
      payload.imagen !== undefined ? (payload.imagen ? String(payload.imagen).trim() : null) : current.imagen,
      payload.controla_stock !== undefined ? (payload.controla_stock ? 1 : 0) : null,
      payload.activo !== undefined ? payload.activo : null,
      id
    ]
  );
  return getById(id, access);
}

async function remove(id, access = {}) {
  if (!(await getById(id, access))) return null;
  await db.pool.execute('UPDATE productos SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

async function getPriceById(id, access = {}) {
  const filter = restaurantFilter(access);
  const [rows] = await db.query(
    `SELECT pp.id, pp.producto_id, pp.nombre_precio, pp.precio, pp.activo
     FROM producto_precios pp
     JOIN productos p ON p.id = pp.producto_id
     JOIN categorias c ON c.id = p.categoria_id
     JOIN cartas ca ON ca.id = c.carta_id AND ca.activa = 1
     JOIN sucursales s ON s.id = ca.sucursal_id AND s.activo = 1
     WHERE pp.id = ?${filter.sql}
     LIMIT 1`,
    [id, ...filter.params]
  );
  return rows && rows.length ? rows[0] : null;
}

async function getPrices(productoId, access = {}) {
  if (!productoId || !(await getById(productoId, access))) return [];
  const [rows] = await db.query(
    `SELECT id, producto_id, nombre_precio, precio, activo
     FROM producto_precios
     WHERE producto_id = ? AND activo = 1
     ORDER BY id`,
    [productoId]
  );
  return rows || [];
}

async function createPrice({ producto_id, nombre_precio, precio }, access = {}) {
  if (!producto_id || !(await getById(producto_id, access))) {
    const err = new Error('El producto no pertenece al restaurante del usuario');
    err.code = 'FORBIDDEN';
    throw err;
  }
  const [result] = await db.pool.execute(
    `INSERT INTO producto_precios (producto_id, nombre_precio, precio, activo)
     VALUES (?, ?, ?, 1)`,
    [producto_id, nombre_precio ? String(nombre_precio).trim() : 'Default', Number(precio || 0)]
  );
  return getPriceById(result.insertId, access);
}

async function updatePrice(id, { nombre_precio, precio, activo }, access = {}) {
  const current = await getPriceById(id, access);
  if (!current) return null;
  await db.pool.execute(
    `UPDATE producto_precios
     SET nombre_precio = COALESCE(?, nombre_precio),
         precio = COALESCE(?, precio),
         activo = COALESCE(?, activo)
     WHERE id = ?`,
    [
      nombre_precio !== undefined ? String(nombre_precio).trim() : null,
      precio !== undefined ? Number(precio) : null,
      activo !== undefined ? activo : null,
      id
    ]
  );
  return getPriceById(id, access);
}

async function removePrice(id, access = {}) {
  if (!(await getPriceById(id, access))) return null;
  await db.pool.execute('UPDATE producto_precios SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = {
  getByCategory,
  getById,
  create,
  update,
  remove,
  getPrices,
  createPrice,
  updatePrice,
  removePrice,
};
