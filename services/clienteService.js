'use strict';
const db = require('../models/db');

function normalizePayload(payload = {}) {
  const razonSocial = payload.razon_social || null;
  const nombres = payload.nombres || razonSocial || 'Cliente';
  return {
    tipo_documento: payload.tipo_documento || null,
    numero_documento: payload.numero_documento || null,
    razon_social: razonSocial,
    nombres,
    apellidos: payload.apellidos || null,
    telefono: payload.telefono || null,
    correo: payload.correo || null,
    direccion: payload.direccion || null
  };
}

async function findByDocument(numero_documento) {
  if (!numero_documento) return null;
  const [rows] = await db.query(
    'SELECT * FROM clientes WHERE numero_documento = ? LIMIT 1',
    [numero_documento]
  );
  return rows && rows.length ? rows[0] : null;
}

async function search(q) {
  const term = `%${q || ''}%`;
  const [rows] = await db.query(
    `SELECT * FROM clientes
     WHERE numero_documento LIKE ?
        OR nombres LIKE ?
        OR apellidos LIKE ?
        OR razon_social LIKE ?
     ORDER BY id DESC
     LIMIT 30`,
    [term, term, term, term]
  );
  return rows;
}

async function create(payload) {
  const data = normalizePayload(payload);
  const [res] = await db.pool.execute(
    `INSERT INTO clientes
      (tipo_documento, numero_documento, razon_social, nombres, apellidos, telefono, correo, direccion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      data.tipo_documento,
      data.numero_documento,
      data.razon_social,
      data.nombres,
      data.apellidos,
      data.telefono,
      data.correo,
      data.direccion
    ]
  );
  return getById(res.insertId);
}

async function getById(id) {
  const [rows] = await db.query('SELECT * FROM clientes WHERE id = ? LIMIT 1', [id]);
  return rows && rows.length ? rows[0] : null;
}

async function update(id, payload) {
  const data = normalizePayload(payload);
  await db.pool.execute(
    `UPDATE clientes SET
      tipo_documento = ?,
      numero_documento = ?,
      razon_social = ?,
      nombres = ?,
      apellidos = ?,
      telefono = ?,
      correo = ?,
      direccion = ?
     WHERE id = ?`,
    [
      data.tipo_documento,
      data.numero_documento,
      data.razon_social,
      data.nombres,
      data.apellidos,
      data.telefono,
      data.correo,
      data.direccion,
      id
    ]
  );
  return getById(id);
}

module.exports = { findByDocument, search, create, getById, update };
