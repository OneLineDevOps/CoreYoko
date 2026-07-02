'use strict';
const db = require('../models/db');
const documentLookupService = require('./documentLookupService');

function clean(value) {
  if (value === undefined || value === null) return null;
  const result = String(value).trim();
  return result || null;
}

function normalizePayload(payload = {}) {
  const tipoDocumento = documentLookupService.normalizeDocumentType(payload.tipo_documento) || null;
  const numeroDocumento = clean(payload.numero_documento);
  const razonSocial = clean(payload.razon_social);
  const nombres = clean(payload.nombres) || razonSocial || 'Cliente';
  return {
    tipo_documento: tipoDocumento,
    numero_documento: numeroDocumento,
    razon_social: razonSocial,
    nombres,
    apellidos: clean(payload.apellidos),
    telefono: clean(payload.telefono),
    correo: clean(payload.correo),
    direccion: clean(payload.direccion),
  };
}

async function findByDocument(numero_documento) {
  const number = clean(numero_documento);
  if (!number) return null;
  const [rows] = await db.query(
    'SELECT * FROM clientes WHERE numero_documento = ? LIMIT 1',
    [number]
  );
  return rows && rows.length ? rows[0] : null;
}

async function findOrCreateByDocument(tipo_documento, numero_documento) {
  const number = clean(numero_documento);
  const existing = await findByDocument(number);
  if (existing) return { ...existing, fuente_consulta: 'BASE_DATOS' };

  const inferredType = tipo_documento || (String(number || '').length === 11 ? 'RUC' : 'DNI');
  const validated = documentLookupService.validateDocument(inferredType, number);
  const { type } = validated;
  const externalData = await documentLookupService.lookupDocument(type, number);
  if (!externalData) return null;

  // Revalidar antes del INSERT reduce duplicados si dos cajas consultan a la vez.
  const foundAfterLookup = await findByDocument(number);
  if (foundAfterLookup) return { ...foundAfterLookup, fuente_consulta: 'BASE_DATOS' };

  const created = await create(externalData);
  return { ...created, fuente_consulta: 'API' };
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

module.exports = { findByDocument, findOrCreateByDocument, search, create, getById, update };
