'use strict';

require('dotenv').config();
const db = require('../models/db');
const sunatService = require('../services/sunatService');

sunatService.runOnce()
  .then((processed) => {
    console.log(processed ? 'Se procesó un envío SUNAT' : 'No hay envíos SUNAT pendientes');
  })
  .catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end());
