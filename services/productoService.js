"use strict";
const db = require('../models/db');

// Fallback en memoria
const _fallback = {
  productos: [
    { id: 1, categoria_id: 2, codigo: 'P001', nombre: 'Lomo Saltado', descripcion: 'Clásico peruano', imagen: null, controla_stock: 0, activo: 1 }
  ],
  precios: [
    { id: 1, producto_id: 1, nombre_precio: 'Regular', precio: 25.00, activo: 1 }
  ],
  nextProdId: 2,
  nextPrecioId: 2
};

async function getByCategory(categoria_id) {
  if (!categoria_id) return [];
  try {
    const [rows] = await db.query('SELECT * FROM productos WHERE categoria_id = ? AND activo = 1', [categoria_id]);
    return rows;
  } catch (err) {
    return _fallback.productos.filter(p => Number(p.categoria_id) === Number(categoria_id) && p.activo === 1);
  }
}

async function getById(id) {
  try {
    const [rows] = await db.query('SELECT * FROM productos WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    return _fallback.productos.find(p => Number(p.id) === Number(id)) || null;
  }
}

async function create({ categoria_id, codigo, nombre, descripcion, imagen, controla_stock }) {
  try {
    const [res] = await db.pool.execute('INSERT INTO productos (categoria_id, codigo, nombre, descripcion, imagen, controla_stock, activo) VALUES (?, ?, ?, ?, ?, ?, 1)', [categoria_id, codigo || null, nombre, descripcion || null, imagen || null, controla_stock || 0]);
    return { id: res.insertId, categoria_id, codigo, nombre, descripcion, imagen, controla_stock };
  } catch (err) {
    const id = _fallback.nextProdId++;
    const p = { id, categoria_id, codigo: codigo || null, nombre, descripcion: descripcion || null, imagen: imagen || null, controla_stock: controla_stock || 0, activo: 1 };
    _fallback.productos.push(p);
    return p;
  }
}

async function update(id, payload) {
  try {
    // Build params using COALESCE to preserve existing values
    const pCategoria = payload.categoria_id !== undefined ? payload.categoria_id : null;
    const pCodigo = payload.codigo !== undefined ? payload.codigo : null;
    const pNombre = payload.nombre !== undefined ? payload.nombre : null;
    const pDescripcion = payload.descripcion !== undefined ? payload.descripcion : null;
    const pImagen = payload.imagen !== undefined ? payload.imagen : null;
    const pControl = payload.controla_stock !== undefined ? payload.controla_stock : null;
    const pActivo = payload.activo !== undefined ? payload.activo : null;

    await db.pool.execute(
      'UPDATE productos SET categoria_id = COALESCE(?, categoria_id), codigo = COALESCE(?, codigo), nombre = COALESCE(?, nombre), descripcion = COALESCE(?, descripcion), imagen = COALESCE(?, imagen), controla_stock = COALESCE(?, controla_stock), activo = COALESCE(?, activo) WHERE id = ?',
      [pCategoria, pCodigo, pNombre, pDescripcion, pImagen, pControl, pActivo, id]
    );
    return await getById(id);
  } catch (err) {
    const p = _fallback.productos.find(x => Number(x.id) === Number(id));
    if (!p) return null;
    Object.keys(payload).forEach(k => { if (payload[k] !== undefined) p[k] = payload[k]; });
    return p;
  }
}

async function remove(id) {
  try {
    await db.pool.execute('UPDATE productos SET activo = 0 WHERE id = ?', [id]);
    return { id: Number(id), deleted: true };
  } catch (err) {
    const p = _fallback.productos.find(x => Number(x.id) === Number(id));
    if (!p) return null;
    p.activo = 0;
    return { id: Number(id), deleted: true };
  }
}

// Precios
async function getPrices(producto_id) {
  if (!producto_id) return [];
  try {
    const [rows] = await db.query('SELECT * FROM producto_precios WHERE producto_id = ? AND activo = 1', [producto_id]);
    return rows;
  } catch (err) {
    return _fallback.precios.filter(pr => Number(pr.producto_id) === Number(producto_id) && pr.activo === 1);
  }
}

async function createPrice({ producto_id, nombre_precio, precio }) {
  try {
    const [res] = await db.pool.execute('INSERT INTO producto_precios (producto_id, nombre_precio, precio, activo) VALUES (?, ?, ?, 1)', [producto_id, nombre_precio || 'Default', precio || 0]);
    return { id: res.insertId, producto_id, nombre_precio, precio };
  } catch (err) {
    const id = _fallback.nextPrecioId++;
    const pr = { id, producto_id, nombre_precio: nombre_precio || 'Default', precio: precio || 0, activo: 1 };
    _fallback.precios.push(pr);
    return pr;
  }
}

async function updatePrice(id, { nombre_precio, precio, activo }) {
  try {
    const pNombre = nombre_precio !== undefined ? nombre_precio : null;
    const pPrecio = precio !== undefined ? precio : null;
    const pActivo = activo !== undefined ? activo : null;
    await db.pool.execute('UPDATE producto_precios SET nombre_precio = COALESCE(?, nombre_precio), precio = COALESCE(?, precio), activo = COALESCE(?, activo) WHERE id = ?', [pNombre, pPrecio, pActivo, id]);
    const [rows] = await db.query('SELECT * FROM producto_precios WHERE id = ? LIMIT 1', [id]);
    return rows && rows.length ? rows[0] : null;
  } catch (err) {
    const pr = _fallback.precios.find(x => Number(x.id) === Number(id));
    if (!pr) return null;
    if (nombre_precio !== undefined) pr.nombre_precio = nombre_precio;
    if (precio !== undefined) pr.precio = precio;
    if (activo !== undefined) pr.activo = activo;
    return pr;
  }
}

async function removePrice(id) {
  try {
    await db.pool.execute('UPDATE producto_precios SET activo = 0 WHERE id = ?', [id]);
    return { id: Number(id), deleted: true };
  } catch (err) {
    const pr = _fallback.precios.find(x => Number(x.id) === Number(id));
    if (!pr) return null;
    pr.activo = 0;
    return { id: Number(id), deleted: true };
  }
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
