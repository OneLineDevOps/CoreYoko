'use strict';
const mysql = require('mysql2/promise');
const config = require('../config/db');

const pool = mysql.createPool({
  host: config.host,
  port: config.port,
  user: config.user,
  password: config.password,
  database: config.database,
  waitForConnections: true,
  connectionLimit: config.connectionLimit,
  namedPlaceholders: false,
  charset: 'utf8mb4'
});

module.exports = {
  pool,
  getConnection: () => pool.getConnection(),
  query: (sql, params) => pool.query(sql, params)
};
