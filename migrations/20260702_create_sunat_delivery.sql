ALTER TABLE restaurantes
  ADD COLUMN IF NOT EXISTS sunat_usuario_sol TEXT NULL AFTER telefono,
  ADD COLUMN IF NOT EXISTS sunat_passphrase TEXT NULL AFTER sunat_usuario_sol,
  ADD COLUMN IF NOT EXISTS sunat_token TEXT NULL AFTER sunat_passphrase,
  ADD COLUMN IF NOT EXISTS sunat_activo TINYINT(1) NOT NULL DEFAULT 0 AFTER sunat_token;

ALTER TABLE comprobantes
  ADD COLUMN IF NOT EXISTS sunat_estado VARCHAR(30) NOT NULL DEFAULT 'NO_APLICA' AFTER estado,
  ADD COLUMN IF NOT EXISTS sunat_codigo VARCHAR(30) NULL AFTER sunat_estado,
  ADD COLUMN IF NOT EXISTS sunat_mensaje VARCHAR(1000) NULL AFTER sunat_codigo,
  ADD COLUMN IF NOT EXISTS sunat_enviado_at DATETIME NULL AFTER sunat_mensaje,
  ADD COLUMN IF NOT EXISTS sunat_aceptado_at DATETIME NULL AFTER sunat_enviado_at;

CREATE TABLE IF NOT EXISTS sunat_envios (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  comprobante_id BIGINT UNSIGNED NOT NULL,
  estado ENUM('PENDIENTE','PROCESANDO','ACEPTADO','RECHAZADO','ERROR') NOT NULL DEFAULT 'PENDIENTE',
  intentos INT NOT NULL DEFAULT 0,
  max_intentos INT NOT NULL DEFAULT 8,
  proximo_intento DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  bloqueado_hasta DATETIME NULL,
  lock_token VARCHAR(64) NULL,
  http_code INT NULL,
  codigo_respuesta VARCHAR(30) NULL,
  mensaje VARCHAR(1000) NULL,
  respuesta_json LONGTEXT NULL,
  fecha_ultimo_intento DATETIME NULL,
  fecha_aceptacion DATETIME NULL,
  created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_sunat_envio_comprobante (comprobante_id),
  KEY idx_sunat_envio_cola (estado, proximo_intento, bloqueado_hasta),
  CONSTRAINT fk_sunat_envio_comprobante
    FOREIGN KEY (comprobante_id) REFERENCES comprobantes (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

UPDATE comprobantes
SET sunat_estado = CASE
  WHEN tipo IN ('BOLETA', 'FACTURA', 'NOTA_CREDITO') THEN 'PENDIENTE'
  ELSE 'NO_APLICA'
END
WHERE sunat_estado = 'NO_APLICA';

INSERT INTO sunat_envios (comprobante_id, estado, proximo_intento)
SELECT id, 'PENDIENTE', NOW()
FROM comprobantes
WHERE tipo IN ('BOLETA', 'FACTURA', 'NOTA_CREDITO')
  AND fecha_emision >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)
ON DUPLICATE KEY UPDATE comprobante_id = VALUES(comprobante_id);
