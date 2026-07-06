'use strict';

const db = require('../models/db');

const UNITS = new Set(['UNIDAD', 'GRAMO', 'MILILITRO']);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_INPUT';
  return error;
}

function normalizeAccess(access = {}) {
  return {
    isRoot: Boolean(access.isRoot),
    restauranteId: access.restauranteId ? Number(access.restauranteId) : null,
  };
}

async function getProductContext(productId, access = {}, conn = db.pool) {
  const normalized = normalizeAccess(access);
  const [rows] = await conn.execute(
    `SELECT p.id, p.nombre, s.restaurante_id
     FROM productos p
     JOIN categorias c ON c.id = p.categoria_id
     JOIN cartas ca ON ca.id = c.carta_id
     JOIN sucursales s ON s.id = ca.sucursal_id
     WHERE p.id = ? AND p.activo = 1
     LIMIT 1`,
    [productId]
  );
  const product = rows?.[0] || null;
  if (!product) return null;
  if (!normalized.isRoot && Number(product.restaurante_id) !== normalized.restauranteId) return null;
  return product;
}

async function getIngredientContext(ingredientId, access = {}) {
  const normalized = normalizeAccess(access);
  const [rows] = await db.query(
    'SELECT * FROM ingredientes WHERE id = ? LIMIT 1',
    [ingredientId]
  );
  const ingredient = rows?.[0] || null;
  if (!ingredient) return null;
  if (!normalized.isRoot && Number(ingredient.restaurante_id) !== normalized.restauranteId) return null;
  return ingredient;
}

async function getProductRecipe(productId, access = {}) {
  const product = await getProductContext(productId, access);
  if (!product) return null;
  const [ingredients, recipe] = await Promise.all([
    db.query(
      `SELECT id, nombre, unidad_base, activo
       FROM ingredientes
       WHERE restaurante_id = ? AND activo = 1
       ORDER BY nombre, id`,
      [product.restaurante_id]
    ),
    db.query(
      `SELECT pr.id, pr.producto_id, pr.ingrediente_id, pr.cantidad,
              i.nombre AS ingrediente_nombre, i.unidad_base
       FROM producto_recetas pr
       JOIN ingredientes i ON i.id = pr.ingrediente_id AND i.activo = 1
       WHERE pr.producto_id = ?
       ORDER BY i.nombre, i.id`,
      [productId]
    ),
  ]);
  return {
    producto: {
      id: Number(product.id),
      nombre: product.nombre,
    },
    ingredientes: ingredients[0] || [],
    receta: (recipe[0] || []).map((row) => ({
      ...row,
      cantidad: Number(row.cantidad),
    })),
  };
}

async function createIngredient(payload, access = {}) {
  const product = await getProductContext(payload.producto_id, access);
  if (!product) return null;
  const name = String(payload.nombre || '').trim().replace(/\s+/g, ' ');
  const unit = String(payload.unidad_base || '').toUpperCase();
  if (!name || !UNITS.has(unit)) {
    throw invalid('Ingrese el nombre y una unidad válida para el insumo');
  }
  try {
    const [result] = await db.pool.execute(
      `INSERT INTO ingredientes (restaurante_id, nombre, unidad_base, activo)
       VALUES (?, ?, ?, 1)`,
      [product.restaurante_id, name, unit]
    );
    return getIngredientContext(result.insertId, access);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw invalid('Ya existe un insumo con ese nombre');
    throw error;
  }
}

async function updateIngredient(id, payload, access = {}) {
  const current = await getIngredientContext(id, access);
  if (!current) return null;
  const name = payload.nombre === undefined
    ? current.nombre
    : String(payload.nombre || '').trim().replace(/\s+/g, ' ');
  if (!name) throw invalid('El nombre del insumo es obligatorio');
  if (payload.unidad_base && payload.unidad_base !== current.unidad_base) {
    const [uses] = await db.query(
      'SELECT id FROM producto_recetas WHERE ingrediente_id = ? LIMIT 1',
      [id]
    );
    if (uses?.length) {
      throw invalid('No se puede cambiar la unidad de un insumo que ya pertenece a una receta');
    }
  }
  const unit = String(payload.unidad_base || current.unidad_base).toUpperCase();
  if (!UNITS.has(unit)) throw invalid('La unidad del insumo no es válida');
  try {
    await db.pool.execute(
      `UPDATE ingredientes
       SET nombre = ?, unidad_base = ?, activo = COALESCE(?, activo)
       WHERE id = ?`,
      [name, unit, payload.activo === undefined ? null : Number(Boolean(payload.activo)), id]
    );
    return getIngredientContext(id, access);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') throw invalid('Ya existe un insumo con ese nombre');
    throw error;
  }
}

async function saveProductRecipe(productId, items, access = {}) {
  const normalizedItems = (Array.isArray(items) ? items : []).map((item) => ({
    ingrediente_id: Number(item.ingrediente_id),
    cantidad: Number(item.cantidad),
  }));
  if (normalizedItems.some((item) => (
    !Number.isInteger(item.ingrediente_id)
    || item.ingrediente_id <= 0
    || !Number.isFinite(item.cantidad)
    || item.cantidad <= 0
  ))) {
    throw invalid('Cada insumo debe tener una cantidad mayor que cero');
  }
  if (new Set(normalizedItems.map((item) => item.ingrediente_id)).size !== normalizedItems.length) {
    throw invalid('Un insumo no puede repetirse en la misma receta');
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const product = await getProductContext(productId, access, conn);
    if (!product) {
      await conn.rollback();
      return null;
    }
    if (normalizedItems.length) {
      const [validIngredients] = await conn.query(
        `SELECT id
         FROM ingredientes
         WHERE restaurante_id = ? AND activo = 1 AND id IN (?)`,
        [product.restaurante_id, normalizedItems.map((item) => item.ingrediente_id)]
      );
      if ((validIngredients || []).length !== normalizedItems.length) {
        throw invalid('Uno o más insumos no pertenecen al restaurante');
      }
    }
    await conn.execute('DELETE FROM producto_recetas WHERE producto_id = ?', [productId]);
    for (const item of normalizedItems) {
      await conn.execute(
        `INSERT INTO producto_recetas (producto_id, ingrediente_id, cantidad)
         VALUES (?, ?, ?)`,
        [productId, item.ingrediente_id, item.cantidad.toFixed(3)]
      );
    }
    await conn.commit();
    return getProductRecipe(productId, access);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  getProductRecipe,
  createIngredient,
  updateIngredient,
  saveProductRecipe,
};
