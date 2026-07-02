'use strict';

require('dotenv').config();
const db = require('../models/db');
const restaurantService = require('../services/restaurantService');

const restaurantId = Number(process.argv[2] || 0);
if (!restaurantId) {
  console.error('Uso: JSON por stdin | node scripts/configure-sunat.js RESTAURANTE_ID');
  process.exit(1);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', async () => {
  try {
    const credentials = JSON.parse(input);
    const current = await restaurantService.getById(restaurantId);
    if (!current) throw new Error('Restaurante no encontrado');
    await restaurantService.update(restaurantId, {
      ...current,
      sunat_usuario_sol: credentials.usuario_sol,
      sunat_passphrase: credentials.passphrase,
      sunat_token: credentials.token,
      sunat_activo: 1,
    });
    console.log(`Credenciales SUNAT configuradas para el restaurante ${restaurantId}`);
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
});
