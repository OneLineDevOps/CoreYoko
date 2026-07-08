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

async function hydrateStations(products = []) {
  if (!products.length) return products;
  const [rows] = await db.query(
    `SELECT pe.producto_id, ec.id, ec.nombre
     FROM producto_estaciones pe
     JOIN estaciones_cocina ec ON ec.id = pe.estacion_id AND ec.activo = 1
     WHERE pe.producto_id IN (?)
     ORDER BY ec.nombre, ec.id`,
    [products.map((product) => product.id)]
  );
  const byProduct = new Map();
  for (const row of rows || []) {
    if (!byProduct.has(Number(row.producto_id))) byProduct.set(Number(row.producto_id), []);
    byProduct.get(Number(row.producto_id)).push({
      id: Number(row.id),
      nombre: row.nombre
    });
  }
  return products.map((product) => ({
    ...product,
    estaciones: byProduct.get(Number(product.id)) || []
  }));
}

async function getStations() {
  const [rows] = await db.query(
    `SELECT id, nombre
     FROM estaciones_cocina
     WHERE activo = 1
     ORDER BY nombre, id`
  );
  return (rows || []).map((row) => ({ ...row, id: Number(row.id) }));
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
  return hydrateStations(rows || []);
}

async function getByBranch(sucursalId, access = {}) {
  if (!sucursalId) return [];
  const filter = restaurantFilter(access);
  const [rows] = await db.query(
    `SELECT p.id, p.categoria_id, p.codigo, p.nombre, p.descripcion, p.imagen,
            p.controla_stock, p.activo
     FROM productos p
     JOIN categorias c ON c.id = p.categoria_id AND c.activo = 1
     JOIN cartas ca ON ca.id = c.carta_id AND ca.activa = 1
     JOIN sucursales s ON s.id = ca.sucursal_id AND s.activo = 1
     WHERE ca.sucursal_id = ? AND p.activo = 1${filter.sql}
     ORDER BY c.nombre, p.nombre, p.id`,
    [sucursalId, ...filter.params]
  );
  return hydrateStations(rows || []);
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
  if (!rows || !rows.length) return null;
  const hydrated = await hydrateStations([rows[0]]);
  return hydrated[0] || null;
}

async function setProductStations(productId, stationIds = [], access = {}) {
  const product = await getById(productId, access);
  if (!product) return null;
  const ids = [...new Set((stationIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length) {
    const [stationRows] = await db.query(
      'SELECT id FROM estaciones_cocina WHERE activo = 1 AND id IN (?)',
      [ids]
    );
    if ((stationRows || []).length !== ids.length) {
      const err = new Error('Una o más estaciones de impresión no son válidas');
      err.code = 'INVALID_INPUT';
      throw err;
    }
  }
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM producto_estaciones WHERE producto_id = ?', [productId]);
    for (const stationId of ids) {
      await conn.execute(
        'INSERT INTO producto_estaciones (producto_id, estacion_id) VALUES (?, ?)',
        [productId, stationId]
      );
    }
    await conn.commit();
    return getById(productId, access);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function create({ categoria_id, codigo, nombre, descripcion, imagen, controla_stock, estacion_ids }, access = {}) {
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
  if (Array.isArray(estacion_ids)) {
    return setProductStations(result.insertId, estacion_ids, access);
  }
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
  if (Array.isArray(payload.estacion_ids)) {
    return setProductStations(id, payload.estacion_ids, access);
  }
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
  getByBranch,
  getById,
  create,
  update,
  remove,
  getPrices,
  createPrice,
  updatePrice,
  removePrice,
  getStations,
  setProductStations,
};
