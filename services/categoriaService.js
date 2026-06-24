"use strict";
const db = require('../models/db');

function accessParams(access = {}) {
  const isRoot = Boolean(access.isRoot);
  const restauranteId = access.restauranteId ? Number(access.restauranteId) : null;
  return { isRoot, restauranteId };
}

async function migrateLegacyCatalog() {
  const [legacyRows] = await db.query(
    'SELECT COUNT(*) AS total FROM categorias WHERE carta_id IS NULL OR carta_id = 0'
  );
  if (!Number(legacyRows?.[0]?.total || 0)) return;

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [branches] = await conn.execute(
      `SELECT s.id
       FROM sucursales s
       JOIN restaurantes r ON r.id = s.restaurante_id
       WHERE s.activo = 1 AND r.activo = 1
       ORDER BY r.id, s.id
       LIMIT 1
       FOR UPDATE`
    );
    if (!branches || !branches.length) {
      await conn.rollback();
      return;
    }

    const branchId = branches[0].id;
    const [cartas] = await conn.execute(
      'SELECT id FROM cartas WHERE sucursal_id = ? AND activa = 1 ORDER BY id LIMIT 1',
      [branchId]
    );
    let cartaId = cartas?.[0]?.id;
    if (!cartaId) {
      const [result] = await conn.execute(
        'INSERT INTO cartas (sucursal_id, nombre, activa) VALUES (?, ?, 1)',
        [branchId, 'Carta principal']
      );
      cartaId = result.insertId;
    }
    await conn.execute(
      'UPDATE categorias SET carta_id = ? WHERE carta_id IS NULL OR carta_id = 0',
      [cartaId]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getBranch(sucursalId, access = {}, conn = db.pool) {
  if (!sucursalId) return null;
  const { isRoot, restauranteId } = accessParams(access);
  const conditions = ['s.id = ?', 's.activo = 1', 'r.activo = 1'];
  const params = [sucursalId];
  if (!isRoot) {
    if (!restauranteId) return null;
    conditions.push('s.restaurante_id = ?');
    params.push(restauranteId);
  }
  const [rows] = await conn.execute(
    `SELECT s.id, s.restaurante_id
     FROM sucursales s
     JOIN restaurantes r ON r.id = s.restaurante_id
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params
  );
  return rows && rows.length ? rows[0] : null;
}

async function getCartaId(sucursalId, access = {}, { create = false, conn = db.pool } = {}) {
  const branch = await getBranch(sucursalId, access, conn);
  if (!branch) return null;

  const [rows] = await conn.execute(
    'SELECT id FROM cartas WHERE sucursal_id = ? AND activa = 1 ORDER BY id LIMIT 1',
    [sucursalId]
  );
  if (rows && rows.length) return rows[0].id;
  if (!create) return null;

  const [result] = await conn.execute(
    'INSERT INTO cartas (sucursal_id, nombre, activa) VALUES (?, ?, 1)',
    [sucursalId, 'Carta principal']
  );
  return result.insertId;
}

async function getAll(sucursalId, access = {}) {
  await migrateLegacyCatalog();
  const cartaId = await getCartaId(sucursalId, access);
  if (!cartaId) return [];
  const [rows] = await db.query(
    `SELECT id, carta_id, nombre, descripcion, orden, activo
     FROM categorias
     WHERE carta_id = ? AND activo = 1
     ORDER BY orden, id`,
    [cartaId]
  );
  return rows || [];
}

async function getById(id, access = {}) {
  const { isRoot, restauranteId } = accessParams(access);
  const conditions = ['c.id = ?'];
  const params = [id];
  if (!isRoot) {
    if (!restauranteId) return null;
    conditions.push('s.restaurante_id = ?');
    params.push(restauranteId);
  }
  const [rows] = await db.query(
    `SELECT c.id, c.carta_id, c.nombre, c.descripcion, c.orden, c.activo
     FROM categorias c
     JOIN cartas ca ON ca.id = c.carta_id
     JOIN sucursales s ON s.id = ca.sucursal_id
     WHERE ${conditions.join(' AND ')}
     LIMIT 1`,
    params
  );
  return rows && rows.length ? rows[0] : null;
}

async function create({ sucursal_id, nombre, descripcion }, access = {}) {
  await migrateLegacyCatalog();
  if (!sucursal_id || !nombre || !String(nombre).trim()) {
    const err = new Error('sucursal_id y nombre son requeridos');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  const cartaId = await getCartaId(sucursal_id, access, { create: true });
  if (!cartaId) {
    const err = new Error('La sucursal no pertenece al restaurante del usuario');
    err.code = 'FORBIDDEN';
    throw err;
  }
  const [result] = await db.pool.execute(
    'INSERT INTO categorias (carta_id, nombre, descripcion, activo) VALUES (?, ?, ?, 1)',
    [cartaId, String(nombre).trim(), descripcion ? String(descripcion).trim() : null]
  );
  return getById(result.insertId, access);
}

async function update(id, { nombre, descripcion, activo }, access = {}) {
  const current = await getById(id, access);
  if (!current) return null;
  await db.pool.execute(
    `UPDATE categorias
     SET nombre = COALESCE(?, nombre),
         descripcion = ?,
         activo = COALESCE(?, activo)
     WHERE id = ?`,
    [
      nombre !== undefined ? String(nombre).trim() : null,
      descripcion !== undefined ? (descripcion ? String(descripcion).trim() : null) : current.descripcion,
      activo !== undefined ? activo : null,
      id
    ]
  );
  return getById(id, access);
}

async function remove(id, access = {}) {
  const current = await getById(id, access);
  if (!current) return null;
  await db.pool.execute('UPDATE categorias SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = { getAll, getById, create, update, remove, getCartaId, migrateLegacyCatalog };
