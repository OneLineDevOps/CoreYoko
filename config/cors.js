'use strict';
require('dotenv').config();

const defaultOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

let origin;
if (defaultOrigin === '*') {
  origin = '*';
} else if (defaultOrigin.includes(',')) {
  origin = defaultOrigin.split(',').map(s => s.trim());
} else {
  origin = defaultOrigin;
}

const methods = (process.env.CORS_METHODS || 'GET,HEAD,PUT,PATCH,POST,DELETE')
  .split(',')
  .map(m => m.trim());

const allowedHeaders = (process.env.CORS_ALLOWED_HEADERS || 'Content-Type,Authorization')
  .split(',')
  .map(h => h.trim());

const credentials = process.env.CORS_CREDENTIALS === 'true';

module.exports = {
  origin,
  methods,
  allowedHeaders,
  credentials
};
