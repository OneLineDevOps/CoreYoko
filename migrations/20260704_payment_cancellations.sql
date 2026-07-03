ALTER TABLE pagos
  ADD COLUMN IF NOT EXISTS estado VARCHAR(20) NOT NULL DEFAULT 'ACTIVO' AFTER monto,
  ADD COLUMN IF NOT EXISTS motivo_anulacion VARCHAR(250) NULL AFTER referencia,
  ADD COLUMN IF NOT EXISTS anulado_at DATETIME NULL AFTER motivo_anulacion,
  ADD COLUMN IF NOT EXISTS anulado_por BIGINT UNSIGNED NULL AFTER anulado_at;

ALTER TABLE pagos
  ADD INDEX IF NOT EXISTS idx_pago_estado_sesion (estado, sesion_caja_id),
  ADD INDEX IF NOT EXISTS idx_pago_anulado_por (anulado_por);

UPDATE pagos SET estado = 'ACTIVO' WHERE estado IS NULL OR estado = '';
