ALTER TABLE comprobantes
  MODIFY COLUMN cuenta_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS sucursal_id BIGINT UNSIGNED NULL AFTER cuenta_id,
  ADD COLUMN IF NOT EXISTS sesion_caja_id BIGINT UNSIGNED NULL AFTER metodo_pago_id,
  ADD COLUMN IF NOT EXISTS usuario_id BIGINT UNSIGNED NULL AFTER sesion_caja_id,
  ADD COLUMN IF NOT EXISTS origen VARCHAR(30) NOT NULL DEFAULT 'PEDIDO' AFTER usuario_id,
  ADD COLUMN IF NOT EXISTS motivo_codigo VARCHAR(2) NULL AFTER comprobante_referencia_id,
  ADD COLUMN IF NOT EXISTS motivo_descripcion VARCHAR(250) NULL AFTER motivo_codigo;

UPDATE comprobantes comp
JOIN cuentas cu ON cu.id = comp.cuenta_id
JOIN pedidos ped ON ped.id = cu.pedido_id
SET comp.sucursal_id = ped.sucursal_id
WHERE comp.sucursal_id IS NULL;

UPDATE comprobantes comp
SET comp.sesion_caja_id = (
      SELECT pg.sesion_caja_id
      FROM pagos pg
      JOIN cuentas cu ON cu.pedido_id = pg.pedido_id
      WHERE cu.id = comp.cuenta_id
        AND pg.sesion_caja_id IS NOT NULL
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, pg.fecha_pago, comp.fecha_emision)), pg.id DESC
      LIMIT 1
    ),
    comp.usuario_id = (
      SELECT pg.usuario_id
      FROM pagos pg
      JOIN cuentas cu ON cu.pedido_id = pg.pedido_id
      WHERE cu.id = comp.cuenta_id
        AND pg.usuario_id IS NOT NULL
      ORDER BY ABS(TIMESTAMPDIFF(SECOND, pg.fecha_pago, comp.fecha_emision)), pg.id DESC
      LIMIT 1
    )
WHERE comp.cuenta_id IS NOT NULL;

ALTER TABLE pagos
  MODIFY COLUMN pedido_id BIGINT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS comprobante_id BIGINT UNSIGNED NULL AFTER pedido_id;

UPDATE pagos pg
SET pg.comprobante_id = (
  SELECT comp.id
  FROM comprobantes comp
  JOIN cuentas cu ON cu.id = comp.cuenta_id
  WHERE cu.pedido_id = pg.pedido_id
    AND comp.estado <> 'ANULADO'
    AND (comp.metodo_pago_id = pg.metodo_pago_id OR comp.metodo_pago_id IS NULL)
    AND ABS(comp.total - pg.monto) < 0.01
  ORDER BY ABS(TIMESTAMPDIFF(SECOND, comp.fecha_emision, pg.fecha_pago)), comp.id DESC
  LIMIT 1
)
WHERE pg.comprobante_id IS NULL;

ALTER TABLE comprobantes
  ADD INDEX IF NOT EXISTS idx_comp_sucursal_fecha (sucursal_id, fecha_emision),
  ADD INDEX IF NOT EXISTS idx_comp_sesion (sesion_caja_id),
  ADD INDEX IF NOT EXISTS idx_comp_usuario (usuario_id),
  ADD INDEX IF NOT EXISTS idx_comp_referencia_estado (comprobante_referencia_id, estado);

ALTER TABLE pagos
  ADD INDEX IF NOT EXISTS idx_pago_comprobante (comprobante_id);

UPDATE series_comprobante
SET activo = 0
WHERE tipo = 'NOTA_CREDITO'
  AND serie NOT REGEXP '^[FB][A-Z0-9]{3}$';

INSERT INTO series_comprobante
  (restaurante_id, tipo, serie, ultimo_numero, activo)
SELECT r.id, 'NOTA_CREDITO', CONCAT('FC', LPAD(r.id, 2, '0')), 0, 1
FROM restaurantes r
WHERE r.activo = 1
ON DUPLICATE KEY UPDATE activo = 1;

INSERT INTO series_comprobante
  (restaurante_id, tipo, serie, ultimo_numero, activo)
SELECT r.id, 'NOTA_CREDITO', CONCAT('BC', LPAD(r.id, 2, '0')), 0, 1
FROM restaurantes r
WHERE r.activo = 1
ON DUPLICATE KEY UPDATE activo = 1;
