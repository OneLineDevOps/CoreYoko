'use strict';
const db = require('../models/db');

function normalizePayload(data = {}) {
  const igvPercentage = data.igv_porcentaje === undefined ? 18 : Number(data.igv_porcentaje);
  if (!Number.isFinite(igvPercentage) || igvPercentage <= 0 || igvPercentage > 100) {
    const err = new Error('El porcentaje de IGV debe ser mayor a 0 y menor o igual a 100');
    err.code = 'INVALID_INPUT';
    throw err;
  }
  return {
    nombre: data.nombre ? String(data.nombre).trim() : '',
    ruc: data.ruc ? String(data.ruc).trim() : null,
    direccion: data.direccion ? String(data.direccion).trim() : null,
    telefono: data.telefono ? String(data.telefono).trim() : null,
    igv_porcentaje: Number(igvPercentage.toFixed(2)),
    activo: data.activo === undefined ? 1 : Number(Boolean(data.activo)),
    sunat_activo: data.sunat_activo === undefined ? 0 : Number(Boolean(data.sunat_activo)),
  };
}

function validateSunatInput(data = {}) {
  if (data.sunat_usuario_sol !== undefined && data.sunat_usuario_sol !== null && String(data.sunat_usuario_sol).trim()) {
    const parts = String(data.sunat_usuario_sol).trim().split('#');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      const err = new Error('El usuario SOL debe tener el formato usuario#clave');
      err.code = 'INVALID_INPUT';
      throw err;
    }
  }
}

function safeSelect(includeCredentials = false) {
  return `r.id, r.nombre, r.ruc, r.direccion, r.telefono, r.igv_porcentaje, r.activo,
    ${includeCredentials ? 'r.sunat_usuario_sol, r.sunat_passphrase, r.sunat_token,' : ''}
    r.sunat_activo,
    CASE
      WHEN r.sunat_usuario_sol IS NOT NULL
       AND r.sunat_passphrase IS NOT NULL
       AND r.sunat_token IS NOT NULL
      THEN 1 ELSE 0
    END AS sunat_configurado`;
}

async function getAll({ includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE r.activo = 1';
  const [rows] = await db.query(
    `SELECT
       ${safeSelect()},
       COUNT(s.id) AS sucursales_count
     FROM restaurantes r
     LEFT JOIN sucursales s ON s.restaurante_id = r.id AND s.activo = 1
     ${where}
     GROUP BY r.id
     ORDER BY r.id DESC`
  );
  return rows || [];
}

async function getById(id) {
  const [rows] = await db.query(
    `SELECT
       ${safeSelect(true)},
       COUNT(s.id) AS sucursales_count
     FROM restaurantes r
     LEFT JOIN sucursales s ON s.restaurante_id = r.id AND s.activo = 1
     WHERE r.id = ?
     GROUP BY r.id
     LIMIT 1`,
    [id]
  );
  return rows && rows.length ? rows[0] : null;
}

async function getRawById(id) {
  const [rows] = await db.query('SELECT * FROM restaurantes WHERE id = ? LIMIT 1', [id]);
  return rows?.[0] || null;
}

async function getSunatCredentials(id) {
  const row = await getRawById(id);
  if (!row || !Number(row.activo) || !Number(row.sunat_activo)) return null;
  if (!row.sunat_usuario_sol || !row.sunat_passphrase || !row.sunat_token) return null;
  return {
    usuario_sol: row.sunat_usuario_sol,
    passphrase: row.sunat_passphrase,
    token: row.sunat_token,
  };
}

async function create(data) {
  const payload = normalizePayload(data);
  validateSunatInput(data);
  if (!payload.nombre) {
    const err = new Error('nombre is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  const [res] = await db.pool.execute(
    `INSERT INTO restaurantes
     (nombre, ruc, direccion, telefono, igv_porcentaje, activo, sunat_usuario_sol, sunat_passphrase, sunat_token, sunat_activo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      payload.nombre,
      payload.ruc,
      payload.direccion,
      payload.telefono,
      payload.igv_porcentaje,
      payload.activo,
      data.sunat_usuario_sol ? String(data.sunat_usuario_sol).trim() : null,
      data.sunat_passphrase ? String(data.sunat_passphrase) : null,
      data.sunat_token ? String(data.sunat_token).trim() : null,
      payload.sunat_activo,
    ]
  );
  return getById(res.insertId);
}

async function update(id, data) {
  const current = await getRawById(id);
  if (!current) return null;
  validateSunatInput(data);

  const payload = normalizePayload({ ...current, ...data });
  if (!payload.nombre) {
    const err = new Error('nombre is required');
    err.code = 'INVALID_INPUT';
    throw err;
  }

  await db.pool.execute(
    `UPDATE restaurantes
     SET nombre = ?, ruc = ?, direccion = ?, telefono = ?, igv_porcentaje = ?, activo = ?,
         sunat_usuario_sol = ?, sunat_passphrase = ?, sunat_token = ?, sunat_activo = ?
     WHERE id = ?`,
    [
      payload.nombre,
      payload.ruc,
      payload.direccion,
      payload.telefono,
      payload.igv_porcentaje,
      payload.activo,
      data.sunat_usuario_sol !== undefined ? (String(data.sunat_usuario_sol).trim() || null) : current.sunat_usuario_sol,
      data.sunat_passphrase !== undefined ? (String(data.sunat_passphrase) || null) : current.sunat_passphrase,
      data.sunat_token !== undefined ? (String(data.sunat_token).trim() || null) : current.sunat_token,
      data.sunat_activo === undefined ? Number(current.sunat_activo || 0) : payload.sunat_activo,
      id
    ]
  );
  return getById(id);
}

async function remove(id) {
  const current = await getById(id);
  if (!current) return null;
  await db.pool.execute('UPDATE restaurantes SET activo = 0 WHERE id = ?', [id]);
  return { id: Number(id), deleted: true };
}

module.exports = { getAll, getById, getSunatCredentials, create, update, remove };
