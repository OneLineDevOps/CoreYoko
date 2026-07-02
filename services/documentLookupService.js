'use strict';

const DEFAULT_BASE_URL = 'https://dniruc.apisperu.com/api/v1';

class DocumentLookupError extends Error {
  constructor(message, { code = 'DOCUMENT_LOOKUP_ERROR', status = 502 } = {}) {
    super(message);
    this.name = 'DocumentLookupError';
    this.code = code;
    this.status = status;
  }
}

function normalizeDocumentType(value) {
  const type = String(value || '').trim().toUpperCase();
  if (['RUC', '6', '01'].includes(type)) return 'RUC';
  if (['DNI', '1'].includes(type)) return 'DNI';
  return type;
}

function validateDocument(type, documentNumber) {
  const normalizedType = normalizeDocumentType(type);
  const number = String(documentNumber || '').replace(/\s+/g, '');

  if (!['DNI', 'RUC'].includes(normalizedType)) {
    throw new DocumentLookupError('La consulta automática solo está disponible para DNI y RUC', {
      code: 'UNSUPPORTED_DOCUMENT_TYPE',
      status: 400,
    });
  }

  const expectedLength = normalizedType === 'DNI' ? 8 : 11;
  if (!new RegExp(`^\\d{${expectedLength}}$`).test(number)) {
    throw new DocumentLookupError(
      `El ${normalizedType} debe contener ${expectedLength} dígitos`,
      { code: 'INVALID_DOCUMENT', status: 400 }
    );
  }

  return { type: normalizedType, number };
}

function normalizeApiResponse(type, number, data = {}) {
  if (type === 'RUC') {
    const businessName = String(data.razonSocial || data.nombre || '').trim();
    if (!businessName) return null;

    return {
      tipo_documento: 'RUC',
      numero_documento: String(data.ruc || data.numeroDocumento || number),
      razon_social: businessName,
      nombres: businessName,
      apellidos: null,
      telefono: Array.isArray(data.telefonos)
        ? (data.telefonos.filter(Boolean).join(' / ') || null)
        : (data.telefono || null),
      correo: null,
      direccion: data.direccion ? String(data.direccion).trim() : null,
    };
  }

  const names = String(data.nombres || '').trim();
  const lastNames = [
    data.apellidoPaterno,
    data.apellidoMaterno,
  ].filter(Boolean).map((value) => String(value).trim()).join(' ');

  if (!names) return null;
  return {
    tipo_documento: 'DNI',
    numero_documento: String(data.dni || data.numeroDocumento || number),
    razon_social: null,
    nombres: names,
    apellidos: lastNames || null,
    telefono: null,
    correo: null,
    direccion: data.direccion ? String(data.direccion).trim() : null,
  };
}

async function lookupDocument(type, documentNumber) {
  const validated = validateDocument(type, documentNumber);
  const token = String(process.env.DOCUMENT_LOOKUP_TOKEN || '').trim();
  if (!token) {
    throw new DocumentLookupError(
      'La consulta de DNI/RUC no está configurada. Registre DOCUMENT_LOOKUP_TOKEN en el backend.',
      { code: 'DOCUMENT_LOOKUP_NOT_CONFIGURED', status: 503 }
    );
  }

  const baseUrl = String(process.env.DOCUMENT_LOOKUP_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const resource = validated.type === 'RUC' ? 'ruc' : 'dni';
  const url = new URL(`${baseUrl}/${resource}/${validated.number}`);
  url.searchParams.set('token', token);

  const controller = new AbortController();
  const timeoutMs = Number(process.env.DOCUMENT_LOOKUP_TIMEOUT_MS || 8000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new DocumentLookupError('La consulta de DNI/RUC excedió el tiempo de espera', {
        code: 'DOCUMENT_LOOKUP_TIMEOUT',
        status: 504,
      });
    }
    throw new DocumentLookupError('No se pudo comunicar con el servicio de consulta de DNI/RUC');
  } finally {
    clearTimeout(timeout);
  }

  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = {};
  }

  if (response.status === 404) return null;
  if (response.status === 401 || response.status === 403) {
    throw new DocumentLookupError('El token de consulta de DNI/RUC no es válido', {
      code: 'INVALID_DOCUMENT_LOOKUP_TOKEN',
      status: 503,
    });
  }
  if (!response.ok) {
    const message = body.message || body.mensaje || body.error;
    throw new DocumentLookupError(
      typeof message === 'string' ? message : 'El servicio de consulta rechazó la solicitud',
      {
        code: response.status === 422 ? 'INVALID_DOCUMENT' : 'DOCUMENT_LOOKUP_ERROR',
        status: response.status === 422 ? 400 : 502,
      }
    );
  }

  return normalizeApiResponse(validated.type, validated.number, body);
}

module.exports = {
  DocumentLookupError,
  lookupDocument,
  normalizeDocumentType,
  validateDocument,
};
