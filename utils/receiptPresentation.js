'use strict';

const TICKET_WIDTH = 42;

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function wrapText(value, width = TICKET_WIDTH) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = '';
      }
      for (let offset = 0; offset < word.length; offset += width) {
        lines.push(word.slice(offset, offset + width));
      }
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function centerLine(value, width = TICKET_WIDTH) {
  const text = String(value || '').slice(0, width);
  return `${' '.repeat(Math.max(0, Math.floor((width - text.length) / 2)))}${text}`;
}

function centerWrapped(value, width = TICKET_WIDTH) {
  return wrapText(value, width).map((line) => centerLine(line, width));
}

function receiptPresentation(receipt = {}) {
  const restaurantName = receipt.restaurante_nombre || 'Yoko Restaurante';
  const receiptType = String(receipt.tipo || 'COMPROBANTE').toUpperCase();
  const customer = receipt.razon_social
    || `${receipt.nombres || ''} ${receipt.apellidos || ''}`.trim()
    || 'Consumidor final';
  return {
    restaurantName,
    restaurantRuc: receipt.restaurante_ruc || '',
    branchName: receipt.sucursal_nombre || '',
    address: receipt.sucursal_direccion || receipt.restaurante_direccion || '',
    phone: receipt.sucursal_telefono || receipt.restaurante_telefono || '',
    customer,
    number: `${receipt.serie || ''}-${String(receipt.numero || 0).padStart(8, '0')}`,
    typeLabel: receiptType === 'BOLETA'
      ? 'BOLETA DE VENTA ELECTRONICA'
      : receiptType === 'NOTA_CREDITO'
        ? 'NOTA DE CREDITO ELECTRONICA'
      : `${receiptType.replaceAll('_', ' ')} ELECTRONICA`,
    dateTime: formatDateTime(receipt.fecha_emision),
    closingLines: [
      'GRACIAS POR SU PREFERENCIA',
      'Fue un placer atenderle.',
      'Esperamos verle nuevamente.',
    ],
  };
}

module.exports = {
  TICKET_WIDTH,
  centerLine,
  centerWrapped,
  formatDateTime,
  receiptPresentation,
  wrapText,
};
