'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../models/db');

const migrationArg = process.argv[2];
if (!migrationArg) {
  console.error('Uso: node scripts/run-migration.js migrations/archivo.sql');
  process.exit(1);
}

const migrationPath = path.resolve(process.cwd(), migrationArg);
const sql = fs.readFileSync(migrationPath, 'utf8');
const statements = sql
  .split(';')
  .map((statement) => statement.trim())
  .filter(Boolean);

(async () => {
  const connection = await db.getConnection();
  try {
    for (const statement of statements) {
      await connection.query(statement);
    }
    console.log(`Migración aplicada: ${path.basename(migrationPath)}`);
  } finally {
    connection.release();
    await db.pool.end();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
