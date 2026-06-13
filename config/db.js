'use strict';
require('dotenv').config();

module.exports = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || '3306',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'u969029117_yoko',
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  igv: parseFloat(process.env.IGV || '0.18')
};
