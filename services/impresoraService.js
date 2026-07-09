'use strict';

const db = require('../models/db');

const PROPOSITOS_BASE = ['CAJA', 'DELIVERY'];
const ESTADOS = ['ACTIVA', 'INACTIVA', 'ERROR'];

function cleanPurposes(values = []) {
  return [...new Set(
    (values || [])
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean)
  )];
}

function protocolForPort(port) {
  const value = Number(port || 9100);
  if (value === 515) return 'LPD';
  if (value === 631) return 'IPP';
  return 'RAW9100';
}

function normalizePrinter(data = {}) {
  const port = Number(data.puerto || 9100);
  return {
    sucursal_id: Number(data.sucursal_id || 0),
    agente_id: String(data.agente_id || '').trim() || null,
    agente_nombre: String(data.agente_nombre || '').trim() || null,
    nombre: String(data.nombre || `${data.ip || ''}:${port}`).trim(),
    ip: String(data.ip || '').trim(),
    puerto: port,
    protocolo: data.protocolo || protocolForPort(port),
    mac: String(data.mac || '').trim() || null,
    modelo: String(data.modelo || '').trim() || null,
    estado: ESTADOS.includes(data.estado) ? data.estado : 'INACTIVA',
    ultimo_error: String(data.ultimo_error || '').trim() || null,
    origen: data.origen === 'MANUAL' ? 'MANUAL' : 'DETECTADA',
    activo: data.activo === undefined ? 1 : Number(Boolean(data.activo)),
  };
}

function validatePrinter(printer) {
  if (!printer.sucursal_id || !printer.nombre || !printer.ip) {
    const error = new Error('sucursal_id, nombre e ip son obligatorios');
    error.code = 'INVALID_INPUT';
    throw error;
  }
  if (!Number.isInteger(printer.puerto) || printer.puerto < 1 || printer.puerto > 65535) {
    const error = new Error('El puerto de impresión no es válido');
    error.code = 'INVALID_INPUT';
    throw error;
  }
}

async function branchByCode(code) {
  const [rows] = await db.query(
    'SELECT * FROM sucursales WHERE UPPER(codigo) = UPPER(?) AND activo = 1 LIMIT 1',
    [String(code || '').trim()]
  );
  return rows?.[0] || null;
}

async function branchById(id) {
  const [rows] = await db.query(
    'SELECT * FROM sucursales WHERE id = ? AND activo = 1 LIMIT 1',
    [id]
  );
  return rows?.[0] || null;
}

async function markStaleDetected(sucursalId) {
  const params = [];
  let branchFilter = '';
  if (sucursalId) {
    branchFilter = 'AND sucursal_id = ?';
    params.push(sucursalId);
  }
  await db.pool.execute(
    `UPDATE impresoras
     SET estado = 'INACTIVA'
     WHERE origen = 'DETECTADA'
       AND estado = 'ACTIVA'
       AND ultima_conexion < DATE_SUB(NOW(), INTERVAL 3 MINUTE)
       ${branchFilter}`,
    params
  );
}

async function listBySucursal(sucursalId, includeInactive = false) {
  await markStaleDetected(sucursalId);
  const params = [sucursalId];
  let activeFilter = '';
  if (!includeInactive) activeFilter = "AND i.activo = 1 AND i.estado <> 'INACTIVA'";
  const [rows] = await db.query(
    `SELECT
       i.*,
       s.nombre AS sucursal_nombre,
       GROUP_CONCAT(DISTINCT ip.proposito ORDER BY ip.proposito SEPARATOR ',') AS propositos_csv
     FROM impresoras i
     JOIN sucursales s ON s.id = i.sucursal_id
     LEFT JOIN impresora_propositos ip ON ip.impresora_id = i.id AND ip.activo = 1
     WHERE i.sucursal_id = ? ${activeFilter}
     GROUP BY i.id
     ORDER BY i.activo DESC, i.estado, i.nombre`,
    params
  );
  return (rows || []).map((row) => ({
    ...row,
    propositos: row.propositos_csv ? cleanPurposes(String(row.propositos_csv).split(',')) : [],
  }));
}

async function getById(id) {
  const [rows] = await db.query('SELECT * FROM impresoras WHERE id = ? LIMIT 1', [id]);
  if (!rows?.length) return null;
  const [purposes] = await db.query(
    'SELECT proposito FROM impresora_propositos WHERE impresora_id = ? AND activo = 1 ORDER BY proposito',
    [id]
  );
  return { ...rows[0], propositos: cleanPurposes(purposes.map((row) => row.proposito)) };
}

async function create(data) {
  const printer = normalizePrinter({ ...data, origen: data.origen || 'MANUAL' });
  validatePrinter(printer);
  try {
    const [result] = await db.pool.execute(
      `INSERT INTO impresoras
       (sucursal_id, agente_id, agente_nombre, nombre, ip, puerto, protocolo, mac, modelo,
        estado, ultimo_error, ultima_conexion, origen, activo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`,
      [
        printer.sucursal_id,
        printer.agente_id,
        printer.agente_nombre,
        printer.nombre,
        printer.ip,
        printer.puerto,
        printer.protocolo,
        printer.mac,
        printer.modelo,
        printer.estado,
        printer.ultimo_error,
        printer.origen,
        printer.activo,
      ]
    );
    if (Array.isArray(data.propositos)) await setPurposes(result.insertId, data.propositos);
    return getById(result.insertId);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      const duplicate = new Error('Ya existe una impresora con esa IP y puerto en la sucursal');
      duplicate.code = 'DUPLICATE';
      throw duplicate;
    }
    throw error;
  }
}

async function update(id, data) {
  const current = await getById(id);
  if (!current) return null;
  const printer = normalizePrinter({ ...current, ...data });
  validatePrinter(printer);
  try {
    await db.pool.execute(
      `UPDATE impresoras SET
       nombre = ?, ip = ?, puerto = ?, protocolo = ?, mac = ?, modelo = ?,
       estado = ?, ultimo_error = ?, origen = ?, activo = ?
       WHERE id = ?`,
      [
        printer.nombre,
        printer.ip,
        printer.puerto,
        printer.protocolo,
        printer.mac,
        printer.modelo,
        printer.estado,
        printer.ultimo_error,
        printer.origen,
        printer.activo,
        id,
      ]
    );
    if (Array.isArray(data.propositos)) await setPurposes(id, data.propositos);
    return getById(id);
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') {
      const duplicate = new Error('Ya existe una impresora con esa IP y puerto en la sucursal');
      duplicate.code = 'DUPLICATE';
      throw duplicate;
    }
    throw error;
  }
}

async function setPurposes(printerId, purposes = []) {
  const [stationRows] = await db.query(
    'SELECT UPPER(TRIM(nombre)) AS proposito FROM estaciones_cocina WHERE activo = 1'
  );
  const allowedPurposes = new Set([
    ...PROPOSITOS_BASE,
    ...(stationRows || []).map((row) => row.proposito).filter(Boolean),
  ]);
  const requested = cleanPurposes(purposes);
  const invalid = requested.filter((item) => !allowedPurposes.has(item));
  if (invalid.length) {
    const error = new Error(`Propósito no configurado como estación activa: ${invalid.join(', ')}`);
    error.code = 'INVALID_INPUT';
    throw error;
  }
  const valid = requested.filter((item) => allowedPurposes.has(item));
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('DELETE FROM impresora_propositos WHERE impresora_id = ?', [printerId]);
    for (const purpose of valid) {
      await conn.execute(
        'INSERT INTO impresora_propositos (impresora_id, proposito, activo) VALUES (?, ?, 1)',
        [printerId, purpose]
      );
    }
    await conn.commit();
    return getById(printerId);
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function remove(id) {
  const current = await getById(id);
  if (!current) return null;
  await db.pool.execute(
    `UPDATE impresoras
     SET activo = 0, estado = 'INACTIVA'
     WHERE id = ?`,
    [id]
  );
  return { id: Number(id), deleted: true };
}

async function syncAgent({ sucursalCodigo, agenteId, agenteNombre, printers = [] }) {
  const branch = await branchByCode(sucursalCodigo);
  if (!branch) {
    const error = new Error('Sucursal no encontrada o inactiva');
    error.code = 'NOT_FOUND';
    throw error;
  }
  if (!agenteId) {
    const error = new Error('agente_id es obligatorio');
    error.code = 'INVALID_INPUT';
    throw error;
  }

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute(
      `UPDATE impresoras
       SET estado = 'INACTIVA'
       WHERE sucursal_id = ?
         AND origen = 'DETECTADA'
         AND estado = 'ACTIVA'
         AND ultima_conexion < DATE_SUB(NOW(), INTERVAL 3 MINUTE)`,
      [branch.id]
    );
    await conn.execute(
      `UPDATE impresoras
       SET estado = 'INACTIVA'
       WHERE sucursal_id = ? AND agente_id = ? AND origen = 'DETECTADA'`,
      [branch.id, agenteId]
    );

    for (const item of printers) {
      const printer = normalizePrinter({
        ...item,
        sucursal_id: branch.id,
        agente_id: agenteId,
        agente_nombre: agenteNombre,
        origen: item.origen || 'DETECTADA',
      });
      validatePrinter(printer);
      await conn.execute(
        `INSERT INTO impresoras
         (sucursal_id, agente_id, agente_nombre, nombre, ip, puerto, protocolo, mac, modelo,
          estado, ultimo_error, ultima_conexion, origen, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, 1)
         ON DUPLICATE KEY UPDATE
          agente_id = VALUES(agente_id),
          agente_nombre = VALUES(agente_nombre),
          nombre = VALUES(nombre),
          protocolo = VALUES(protocolo),
          mac = COALESCE(VALUES(mac), mac),
          modelo = COALESCE(VALUES(modelo), modelo),
          estado = VALUES(estado),
          ultimo_error = VALUES(ultimo_error),
          ultima_conexion = NOW(),
          activo = 1`,
        [
          printer.sucursal_id,
          printer.agente_id,
          printer.agente_nombre,
          printer.nombre,
          printer.ip,
          printer.puerto,
          printer.protocolo,
          printer.mac,
          printer.modelo,
          printer.estado,
          printer.ultimo_error,
          printer.origen,
        ]
      );
    }
    await conn.execute(
      `UPDATE impresoras
       SET agente_id = ?, agente_nombre = ?
       WHERE sucursal_id = ?
         AND origen = 'MANUAL'
         AND activo = 1
         AND (agente_id IS NULL OR agente_id = ?)`,
      [agenteId, agenteNombre || null, branch.id, agenteId]
    );
    await conn.commit();
    return {
      sucursal_id: branch.id,
      sucursal_codigo: branch.codigo,
      impresoras: await listBySucursal(branch.id, true),
    };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

module.exports = {
  PROPOSITOS: PROPOSITOS_BASE,
  branchByCode,
  branchById,
  markStaleDetected,
  listBySucursal,
  getById,
  create,
  update,
  setPurposes,
  remove,
  syncAgent,
};
