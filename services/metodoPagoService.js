'use strict';
const db = require('../models/db');

async function listActivos() {
  const [rows] = await db.query('SELECT * FROM metodos_pago WHERE activo = 1 ORDER BY id');
  return rows;
}

module.exports = { listActivos };
